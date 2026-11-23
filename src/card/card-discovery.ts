import { INTEGRATION_DOMAIN } from "../constants.js";
import { resolveAndAssignAreas } from "../core/area-resolver.js";
import { subscribeEntryReloads } from "../core/entry-reload.js";
import type { ConfigEntrySummary } from "../core/entry-reload.js";
import { RetryManager } from "../core/retry-manager.js";
import { errorText } from "../helpers/error-text.js";
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
 * The codes Home Assistant refuses `panel_topology` with until the panel's
 * config entry has loaded: the integration's `not_loaded` while the entry is
 * set up, retried or reloaded, and its `no_data` for a loaded entry with no
 * data yet, which setup's wait for the first data rules out and is taken the
 * same way; and Home Assistant's own `unknown_command` before the integration
 * has registered the command, which it does as the first of its entries sets up.
 */
const ENTRY_NOT_LOADED_CODES: ReadonlySet<unknown> = new Set(["not_loaded", "no_data", "unknown_command"]);

/** home-assistant-js-websocket's code for a lost connection, its `ERR_CONNECTION_LOST`. */
const ERR_CONNECTION_LOST = 3;

/**
 * Whether home-assistant-js-websocket rejected a call because the connection
 * was lost. It rejects a call the lost connection cut off with an error result
 * carrying the code, `{ type: "result", success: false, error: { code: 3,
 * message } }`, and from 9.8.0 one sent while the socket is down the same way.
 * Before 9.8.0 it rejected a call sent while the socket was down, and one
 * queued during a reconnect, with the bare code. Both are taken, as the
 * library's own `isConnectionLost` takes them.
 */
function isConnectionLost(err: unknown): boolean {
  if (err === ERR_CONNECTION_LOST) return true;
  if (typeof err !== "object" || err === null || !("error" in err)) return false;
  const { error } = err;
  return typeof error === "object" && error !== null && "code" in error && error.code === ERR_CONNECTION_LOST;
}

/**
 * Whether a failed discovery means the panel's topology is not available yet,
 * and its config entry reaching `loaded` will bring it: the entry has not
 * loaded (`ENTRY_NOT_LOADED_CODES`), as while Home Assistant starts, while
 * setup retries a panel it cannot reach, and during a reload; or the
 * connection to Home Assistant was lost (`isConnectionLost`), as across a
 * restart. Home Assistant's refusals are plain `{ code, message }` objects.
 * Every other failure, such as for a device that is not a SPAN panel, is one
 * that waiting does not end.
 */
export function isTopologyPending(err: unknown): boolean {
  if (isConnectionLost(err)) return true;
  return typeof err === "object" && err !== null && "code" in err && ENTRY_NOT_LOADED_CODES.has(err.code);
}

/**
 * The config entry that owns device `deviceId`, as the device registry list
 * says; null where the list holds no such device or names no owner for it, or
 * cannot be read. An id saved before Home Assistant 2026.8 names no device in
 * the list, since that release gave every device it split a new id, though the
 * integration still answers it.
 */
async function owningEntryId(hass: HomeAssistant, deviceId: string): Promise<string | null> {
  try {
    const devices = await hass.callWS<DeviceRegistryEntry[]>({ type: "config/device_registry/list" });
    return devices.find(d => d.id === deviceId)?.config_entry_id ?? null;
  } catch (err) {
    console.warn("SPAN Panel: device registry list failed; waiting for any SPAN Panel entry to load:", errorText(err));
    return null;
  }
}

/**
 * Call `onLoaded` whenever the config entry of the panel `deviceId` names
 * reaches `loaded`, one already loaded as the subscription starts included, so
 * an entry that loaded between a failed discovery (`isTopologyPending`) and
 * this subscription is not missed. The entry is the one that owns the panel's
 * device; where that is not known (`owningEntryId`), any of the integration's
 * entries is taken, and the next `panel_topology` says whether it was the
 * panel's. Resolves to the unsubscribe function.
 *
 * Nothing here watches the connection. home-assistant-js-websocket holds a
 * subscription asked for while the socket is down until it reconnects, from
 * 9.8.0 (9.7.1 never sent one), and replays every subscription after each
 * reconnect, its first batch a re-seed that reports each loaded entry. Every
 * Home Assistant the integration supports, 2026.11.0 on, ships a frontend that
 * pins 9.8.0 (20261028.4 to .6), so a wait started across a restart ends once
 * the entry loads, without a click.
 */
export async function subscribePanelEntryLoads(hass: HomeAssistant, deviceId: string, onLoaded: () => void): Promise<() => Promise<void>> {
  const entryId = await owningEntryId(hass, deviceId);
  const accept = (entry: ConfigEntrySummary): boolean => (entryId === null ? entry.domain === INTEGRATION_DOMAIN : entry.entry_id === entryId);
  return subscribeEntryReloads(hass, accept, () => onLoaded(), { initialIsReseed: true });
}
