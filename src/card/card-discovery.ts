import { INTEGRATION_DOMAIN } from "../constants.js";
import { resolveAndAssignAreas } from "../core/area-resolver.js";
import { RetryManager } from "../core/retry-manager.js";
import { t } from "../i18n.js";
import type { HomeAssistant, PanelTopology, PanelDevice, DiscoveryResult, Circuit, CircuitEntities } from "../types.js";

// ── HA registry response shapes (internal) ─────────────────────────────────

interface DeviceRegistryEntry {
  id: string;
  name?: string;
  name_by_user?: string;
  config_entries?: string[];
  identifiers?: [string, string][];
  via_device_id?: string | null;
  sw_version?: string;
  model?: string;
}

interface EntityRegistryEntry {
  entity_id: string;
  device_id?: string;
  unique_id: string;
  platform?: string;
}

// ── Primary discovery via custom WebSocket API ───────────────────────────────

export async function discoverTopology(hass: HomeAssistant, deviceId: string | undefined, retry?: RetryManager | null): Promise<DiscoveryResult> {
  if (!deviceId) {
    throw new Error(t("card.device_not_found"));
  }

  const topologyMsg = { type: `${INTEGRATION_DOMAIN}/panel_topology`, device_id: deviceId };
  const topology = retry ? await retry.callWS<PanelTopology>(hass, topologyMsg, { errorId: "fetch:topology" }) : await hass.callWS<PanelTopology>(topologyMsg);

  const panelSize = topology.panel_size ?? panelSizeFromCircuits(topology.circuits);
  if (!panelSize) {
    throw new Error(t("card.topology_error"));
  }

  const devicesMsg = { type: "config/device_registry/list" };
  const devices = retry
    ? await retry.callWS<DeviceRegistryEntry[]>(hass, devicesMsg, { errorId: "fetch:topology" })
    : await hass.callWS<DeviceRegistryEntry[]>(devicesMsg);
  const panelDevice = deviceToPanelDevice(devices.find(d => d.id === deviceId));

  await resolveAndAssignAreas(hass, topology);

  return { topology, panelDevice, panelSize };
}

// ── Backward-compatible panel size derivation ────────────────────────────────

function panelSizeFromCircuits(circuits: Record<string, Circuit>): number {
  let maxTab = 0;
  for (const circuit of Object.values(circuits)) {
    if (!circuit) continue;
    for (const tab of circuit.tabs) {
      if (tab > maxTab) maxTab = tab;
    }
  }
  return maxTab > 0 ? maxTab + (maxTab % 2) : 0;
}

// ── Map device registry entry to PanelDevice ─────────────────────────────────

function deviceToPanelDevice(entry: DeviceRegistryEntry | undefined): PanelDevice | null {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    name_by_user: entry.name_by_user,
    config_entries: entry.config_entries,
    identifiers: entry.identifiers,
    via_device_id: entry.via_device_id,
    sw_version: entry.sw_version,
    model: entry.model,
  };
}

// ── Fallback discovery from entity registry ──────────────────────────────────

export async function discoverEntitiesFallback(hass: HomeAssistant, deviceId: string | undefined, retry?: RetryManager | null): Promise<DiscoveryResult> {
  const devicesMsg = { type: "config/device_registry/list" };
  const entitiesMsg = { type: "config/entity_registry/list" };
  const [devices, entities] = await Promise.all([
    retry ? retry.callWS<DeviceRegistryEntry[]>(hass, devicesMsg, { errorId: "fetch:topology" }) : hass.callWS<DeviceRegistryEntry[]>(devicesMsg),
    retry ? retry.callWS<EntityRegistryEntry[]>(hass, entitiesMsg, { errorId: "fetch:topology" }) : hass.callWS<EntityRegistryEntry[]>(entitiesMsg),
  ]);

  const panelDevice = deviceToPanelDevice(devices.find(d => d.id === deviceId));
  if (!panelDevice) return { topology: null, panelDevice: null, panelSize: 0 };

  const allEntities = entities.filter(e => e.device_id === deviceId);
  const subDevices = devices.filter(d => d.via_device_id === deviceId);
  const subDeviceIds = new Set(subDevices.map(d => d.id));
  const subEntities = entities.filter(e => e.device_id !== undefined && subDeviceIds.has(e.device_id));

  const circuits: Record<string, Circuit> = {};
  const devName = panelDevice.name_by_user ?? panelDevice.name ?? "";

  for (const ent of [...allEntities, ...subEntities]) {
    const state = hass.states[ent.entity_id];
    if (!state) continue;
    const attrs = state.attributes;
    const tabsAttr = attrs.tabs;
    if (typeof tabsAttr !== "string" || !tabsAttr.startsWith("tabs [")) continue;

    const content = tabsAttr.slice(6, -1);
    let tabs: number[];
    if (content.includes(":")) {
      tabs = content.split(":").map(Number);
    } else {
      tabs = [Number(content)];
    }
    if (!tabs.every(Number.isFinite)) continue;

    const uidParts = ent.unique_id.split("_");
    let circuitUuid: string | null = null;
    for (let i = 2; i < uidParts.length - 1; i++) {
      const part = uidParts[i];
      if (part !== undefined && part.length >= 16 && /^[a-f0-9]+$/i.test(part)) {
        circuitUuid = part;
        break;
      }
    }
    if (!circuitUuid) continue;

    let displayName = (typeof attrs.friendly_name === "string" ? attrs.friendly_name : undefined) ?? ent.entity_id;
    for (const suffix of [" Power", " Consumed Energy", " Produced Energy"]) {
      if (displayName.endsWith(suffix)) {
        displayName = displayName.slice(0, -suffix.length);
        break;
      }
    }
    if (devName && displayName.startsWith(devName + " ")) {
      displayName = displayName.slice(devName.length + 1);
    }

    const base = ent.entity_id.replace(/^sensor\./, "").replace(/_power$/, "");

    const voltage = typeof attrs.voltage === "number" ? attrs.voltage : tabs.length === 2 ? 240 : 120;

    const circuitEntities: CircuitEntities = {
      power: ent.entity_id,
      switch: `switch.${base}_breaker`,
      breaker_rating: `sensor.${base}_breaker_rating`,
    };

    circuits[circuitUuid] = {
      tabs,
      name: displayName,
      voltage,
      device_type: typeof attrs.device_type === "string" ? attrs.device_type : "circuit",
      relay_state: typeof attrs.relay_state === "string" ? attrs.relay_state : "UNKNOWN",
      is_user_controllable: true,
      breaker_rating_a: null,
      entities: circuitEntities,
    };
  }

  let serial = "";
  if (panelDevice.identifiers) {
    for (const pair of panelDevice.identifiers) {
      // Identifier pairs are [domain, value]. Skip malformed shapes rather
      // than silently indexing past the end.
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [domain, value] = pair;
      if (domain === INTEGRATION_DOMAIN && typeof value === "string") {
        serial = value;
      }
    }
  }

  let panelSize = 0;
  for (const ent of allEntities) {
    const state = hass.states[ent.entity_id];
    if (state && typeof state.attributes.panel_size === "number") {
      panelSize = state.attributes.panel_size;
      break;
    }
  }
  if (!panelSize) {
    panelSize = panelSizeFromCircuits(circuits);
  }
  if (!panelSize) {
    throw new Error(t("card.panel_size_error"));
  }

  const subDeviceMap: Record<string, { name: string; type: string; entities: Record<string, { domain: string; original_name: string }> }> = {};

  for (const sub of subDevices) {
    const subEnts = entities.filter(e => e.device_id === sub.id);
    const modelLower = (sub.model ?? "").toLowerCase();
    const isBess = modelLower.includes("battery") || (sub.identifiers ?? []).some(p => p[1].toLowerCase().includes("bess"));
    const isEvse = modelLower.includes("drive") || (sub.identifiers ?? []).some(p => p[1].toLowerCase().includes("evse"));

    const entMap: Record<string, { domain: string; original_name: string }> = {};
    for (const e of subEnts) {
      const domainPart = e.entity_id.split(".")[0];
      const subState = hass.states[e.entity_id];
      const friendlyName = subState?.attributes?.friendly_name;
      entMap[e.entity_id] = {
        domain: domainPart ?? "",
        original_name: typeof friendlyName === "string" ? friendlyName : e.entity_id,
      };
    }

    subDeviceMap[sub.id] = {
      name: sub.name_by_user ?? sub.name ?? "",
      type: isBess ? "bess" : isEvse ? "evse" : "unknown",
      entities: entMap,
    };
  }

  const topology: PanelTopology = {
    serial,
    firmware: panelDevice.sw_version ?? "",
    panel_size: panelSize,
    device_id: deviceId,
    device_name: panelDevice.name_by_user ?? panelDevice.name ?? t("header.default_name"),
    circuits,
    sub_devices: subDeviceMap,
  };

  await resolveAndAssignAreas(hass, topology);

  return { topology, panelDevice, panelSize };
}
