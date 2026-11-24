import { INTEGRATION_DOMAIN } from "../constants.js";
import { resolveAndAssignAreas } from "../core/area-resolver.js";
import { isConnectionLost } from "../core/entry-load.js";
import type { EntryLoad } from "../core/entry-load.js";
import { subscribeEntryReloads } from "../core/entry-reload.js";
import type { ConfigEntrySummary } from "../core/entry-reload.js";
import { RetryManager } from "../core/retry-manager.js";
import { isPositiveInteger, measuresOutsidePanel, positionRange } from "../helpers/layout.js";
import { t } from "../i18n.js";
import { deviceName } from "../core/registry-types.js";
import type { DeviceRegistryEntry } from "../core/registry-types.js";
import type { HomeAssistant, PanelTopology, DiscoveryResult, Circuit } from "../types.js";

// ── Primary discovery via custom WebSocket API ───────────────────────────────

export async function discoverTopology(hass: HomeAssistant, deviceId: string | undefined, retry?: RetryManager | null): Promise<DiscoveryResult> {
  if (!deviceId) {
    throw new Error(t("card.device_not_found"));
  }

  const topologyMsg = { type: `${INTEGRATION_DOMAIN}/panel_topology`, device_id: deviceId };
  const topology = retry ? await retry.callWS<PanelTopology>(hass, topologyMsg, { errorId: "fetch:topology" }) : await hass.callWS<PanelTopology>(topologyMsg);

  const panelSize = isPositiveInteger(topology.panel_size) ? topology.panel_size : panelSizeFromCircuits(topology.circuits);
  // A panel that does not know its size still loads when it reports its positions.
  if (!positionRange(topology, panelSize)) {
    throw new Error(t("card.topology_error"));
  }

  const devicesMsg = { type: "config/device_registry/list" };
  const devices = retry
    ? await retry.callWS<DeviceRegistryEntry[]>(hass, devicesMsg, { errorId: "fetch:topology" })
    : await hass.callWS<DeviceRegistryEntry[]>(devicesMsg);

  labelCircuitsByDevice(topology.circuits, devices);
  await resolveAndAssignAreas(hass, topology);

  return { topology, panelSize };
}

/**
 * Label each circuit by its own device, where its record names one the device
 * list holds and that device has a name. The record's `name` is the circuit's
 * name in the SPAN app; the device's is the one Home Assistant shows, the
 * user's rename of the device first. A record that names no device, as from an
 * integration that predates circuit devices, keeps the name it came with.
 */
function labelCircuitsByDevice(circuits: Record<string, Circuit>, devices: DeviceRegistryEntry[]): void {
  const deviceById = new Map(devices.map(d => [d.id, d]));
  for (const circuit of Object.values(circuits)) {
    const device = circuit.device_id ? deviceById.get(circuit.device_id) : undefined;
    const name = device ? deviceName(device) : "";
    if (name) circuit.name = name;
  }
}

// ── Backward-compatible panel size derivation ────────────────────────────────

function panelSizeFromCircuits(circuits: Record<string, Circuit>): number {
  let maxTab = 0;
  for (const circuit of Object.values(circuits)) {
    if (!circuit || measuresOutsidePanel(circuit)) continue;
    for (const tab of circuit.tabs) {
      if (tab > maxTab) maxTab = tab;
    }
  }
  return maxTab > 0 ? maxTab + (maxTab % 2) : 0;
}

// ── Waiting for the panel's config entry to load ─────────────────────────────

/**
 * The config entry that owns device `deviceId`, as the device registry list
 * says; null where the list does not hold the device. An id saved before Home
 * Assistant 2026.8 names no device in the list, since that release gave every
 * device it split a new id, though the integration still answers it. Rejects
 * as the list's request does, which it does only where the connection is lost:
 * the list answers every logged-in user, and its handler has no path that
 * refuses.
 */
async function owningEntryId(hass: HomeAssistant, deviceId: string): Promise<string | null> {
  const devices = await hass.callWS<DeviceRegistryEntry[]>({ type: "config/device_registry/list" });
  return devices.find(d => d.id === deviceId)?.config_entry_id ?? null;
}

/** What a wait for a panel's config entry hears of the entry (`subscribePanelEntryLoads`). */
export interface PanelEntryWatch {
  /** The entry reached `loaded`, one already loaded as the subscription starts included. */
  onLoaded: () => void;
  /**
   * Where the entry stands (`entryLoadOf`): reported as the subscription starts,
   * and again as that changes, and null once the entry is removed. Only an entry
   * known to be the panel's is reported.
   */
  onStatus: (load: EntryLoad | null) => void;
}

/**
 * Call `onLoaded` whenever the config entry of the panel `deviceId` names
 * reaches `loaded`, one already loaded as the subscription starts included, so
 * an entry that loaded between a failed discovery (`isRefusedUntilEntryLoads`)
 * and this subscription is not missed, and `onStatus` with where that entry
 * stands. The entry is the one that owns the panel's device (`owningEntryId`).
 * Where the device list does not hold the device, any of the integration's
 * entries is taken, and the next `panel_topology` says whether it was the
 * panel's, while what any of them says of itself says nothing of the panel's,
 * so `onStatus` hears nothing. Where the list is refused for a lost connection,
 * the owner is looked up again once the connection is back
 * (`subscribeUntilOwnerKnown`). Resolves to the unsubscribe function.
 *
 * Nothing here watches the connection. home-assistant-js-websocket holds a
 * subscription asked for while the socket is down until it reconnects, from
 * 9.8.0 (9.7.1 never sent one), and replays every subscription after each
 * reconnect, its first batch a re-seed that reports each loaded entry. Every
 * Home Assistant from 2026.11.0, the first the integration supports, pins
 * home-assistant-js-websocket 9.8.0, so a wait started across a restart ends
 * once the entry loads, without a click.
 */
export async function subscribePanelEntryLoads(hass: HomeAssistant, deviceId: string, watch: PanelEntryWatch): Promise<() => Promise<void>> {
  let owner: string | null;
  try {
    owner = await owningEntryId(hass, deviceId);
  } catch (err) {
    if (!isConnectionLost(err)) throw err;
    return subscribeUntilOwnerKnown(hass, deviceId, watch);
  }
  return subscribeForOwner(hass, owner, watch);
}

/** Wait for the loads of `owner`, hearing where it stands; or, where the owner is not known (null), for those of any of the integration's entries. */
function subscribeForOwner(hass: HomeAssistant, owner: string | null, { onLoaded, onStatus }: PanelEntryWatch): Promise<() => Promise<void>> {
  if (owner === null)
    return subscribeEntryReloads(
      hass,
      entry => entry.domain === INTEGRATION_DOMAIN,
      () => onLoaded(),
      { initialIsReseed: true }
    );
  const accept = (entry: ConfigEntrySummary): boolean => entry.entry_id === owner;
  return subscribeEntryReloads(hass, accept, () => onLoaded(), { initialIsReseed: true, onStatus: (_entryId, load) => onStatus(load) });
}

/**
 * Wait for the loads of any of the integration's entries, the owner of
 * `deviceId` not to be had for a lost connection, and look the owner up again as
 * the subscription's batch of the current entries comes. Asked for while the
 * connection is down, the subscription is held until it is back, so that batch
 * comes over a live connection. Once the owner is known, wait for its entry alone
 * (`subscribeForOwner`), whose own first batch says where it stands; a lookup the
 * connection is lost for again waits for the next batch. Resolves to an
 * unsubscribe function for whichever subscription then holds the wait.
 */
async function subscribeUntilOwnerKnown(hass: HomeAssistant, deviceId: string, watch: PanelEntryWatch): Promise<() => Promise<void>> {
  let stopped = false;
  let looking = false;
  let current: Promise<() => Promise<void>>;
  const lookAgain = async (): Promise<void> => {
    if (looking) return;
    looking = true;
    let owner: string | null;
    try {
      owner = await owningEntryId(hass, deviceId);
    } catch (err) {
      looking = false;
      if (!isConnectionLost(err)) throw err;
      return;
    }
    if (stopped) return;
    const before = current;
    current = subscribeForOwner(hass, owner, watch);
    await (
      await before
    )();
  };
  current = subscribeEntryReloads(
    hass,
    entry => entry.domain === INTEGRATION_DOMAIN,
    () => watch.onLoaded(),
    {
      initialIsReseed: true,
      onSeed: () => void lookAgain(),
    }
  );
  await current;
  return async () => {
    stopped = true;
    await (
      await current
    )();
  };
}
