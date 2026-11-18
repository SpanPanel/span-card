import { INTEGRATION_DOMAIN } from "../constants.js";
import { resolveAndAssignAreas } from "../core/area-resolver.js";
import { RetryManager } from "../core/retry-manager.js";
import { isPositiveInteger, measuresOutsidePanel, positionRange } from "../helpers/layout.js";
import { t } from "../i18n.js";
import { deviceName, entityOwnName, sharesOwner } from "../core/registry-types.js";
import type { DeviceRegistryEntry, EntityRegistryEntry } from "../core/registry-types.js";
import type { HomeAssistant, PanelTopology, PanelDevice, DiscoveryResult, Circuit, CircuitEntities, SubDevice, SubDeviceEntityInfo } from "../types.js";

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
  // Found by the device topology names rather than the id the card holds: they
  // differ when the card was configured before Home Assistant 2026.8, whose split
  // of shared devices left the old id naming no device in this list.
  const panelDeviceId = topology.panel_device_id ?? deviceId;
  const panelDevice = devices.find(d => d.id === panelDeviceId) ?? null;

  labelCircuitsByDevice(topology.circuits, devices);
  await resolveAndAssignAreas(hass, topology);

  return { topology, panelDevice, panelSize };
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

// ── The panel's config entry ─────────────────────────────────────────────────

/**
 * The config entry that owns the panel: the one topology names, else the panel
 * device's own. Topology is asked first because it answers even when the card
 * holds an id from before Home Assistant 2026.8 and so found no device; the
 * device is the fallback for topology built by entity discovery, which names none.
 */
export function panelConfigEntryId(topology: PanelTopology | null, panelDevice: PanelDevice | null): string | null {
  return topology?.config_entry_id ?? panelDevice?.config_entry_id ?? null;
}

// ── Fallback discovery from entity registry ──────────────────────────────────

const POWER_SUFFIX = "_power";
const BREAKER_RATING_SUFFIX = "_breaker_rating";
/** What a circuit's power sensor is called on a device that already names the circuit: its label alone. */
const POWER_LABEL = "Power";

/** A circuit power sensor's unique id, taken apart. */
interface PowerSensorId {
  circuitId: string;
  /** What comes before the circuit id: `span_{serial}`, as this unique id spells the serial. */
  panelPrefix: string;
}

/**
 * The parts of a circuit power sensor's unique id, null for any other sensor.
 * The unique id is `span_{serial}_{circuit id}_power`, the serial lower-cased,
 * and the circuit id is opaque: everything between that prefix and the suffix,
 * `_` included. Where the unique id does not start with the panel's serial, the
 * serial is taken to be its second `_` segment.
 */
function parsePowerSensorId(uniqueId: string, serial: string): PowerSensorId | null {
  if (!uniqueId.endsWith(POWER_SUFFIX)) return null;
  const prefix = `span_${serial.toLowerCase()}_`;
  const circuitId = serial && uniqueId.startsWith(prefix) ? uniqueId.slice(prefix.length, -POWER_SUFFIX.length) : uniqueId.split("_").slice(2, -1).join("_");
  if (!circuitId) return null;
  return { circuitId, panelPrefix: uniqueId.slice(0, -(circuitId.length + POWER_SUFFIX.length + 1)) };
}

/** The serial the panel device names in its integration identifier, "" where it names none. */
function panelSerial(panelDevice: DeviceRegistryEntry): string {
  let serial = "";
  for (const pair of panelDevice.identifiers ?? []) {
    // Identifier pairs are [domain, value]. Skip malformed shapes rather
    // than silently indexing past the end.
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [domain, value] = pair;
    if (domain === INTEGRATION_DOMAIN && typeof value === "string") {
      serial = value;
    }
  }
  return serial;
}

/** The identifier the integration gives a circuit's own device: the panel's serial as its device spells it, then the circuit id. */
function circuitDeviceIdentifier(serial: string, circuitId: string): string {
  return `${serial}_circuit_${circuitId}`;
}

/** The tabs a circuit entity's `tabs` attribute names, as `tabs [7]` or `tabs [10:12]`; null for anything else. */
function parseTabs(tabsAttr: unknown): number[] | null {
  if (typeof tabsAttr !== "string" || !tabsAttr.startsWith("tabs [")) return null;
  const content = tabsAttr.slice(6, -1);
  const tabs = content.includes(":") ? content.split(":").map(Number) : [Number(content)];
  return tabs.every(Number.isFinite) ? tabs : null;
}

/** The names a panel's device goes by: the user's and the integration's, each where it has one. */
function panelNamesOf(panelDevice: DeviceRegistryEntry): string[] {
  return [panelDevice.name_by_user, panelDevice.name].flatMap(name => (name?.trim() ? [name.trim()] : []));
}

/**
 * A name without the panel's in front, which a label on the panel's own
 * dashboard has no use for. Either of the panel's names may lead: the user's,
 * as in a name they typed, or the integration's, which it builds a charger's
 * device name from whatever the user calls the panel. The longer is taken
 * where both lead, and a name that is the panel's and nothing more is kept.
 */
function withoutPanelName(name: string, panelNames: readonly string[]): string {
  const leading = panelNames.filter(panelName => name.startsWith(`${panelName} `)).sort((a, b) => b.length - a.length)[0];
  return leading === undefined ? name : name.slice(leading.length + 1);
}

/**
 * A circuit's label read from its power sensor's own name, for a sensor that
 * is not on a device of the circuit's own: the name without its ` Power`
 * ending and without the panel's name in front. "" where nothing is left,
 * which is a sensor with no name or one named `Power` alone.
 */
function labelFromPowerSensorName(ownName: string, panelNames: readonly string[]): string {
  if (ownName === POWER_LABEL) return "";
  const label = ownName.endsWith(` ${POWER_LABEL}`) ? ownName.slice(0, -(POWER_LABEL.length + 1)) : ownName;
  return withoutPanelName(label, panelNames);
}

/** A device's name and its entities' own names, for a battery or a charger: the shape topology gives a sub-device. */
function subDeviceRecord(sub: DeviceRegistryEntry, entities: EntityRegistryEntry[]): SubDevice {
  const modelLower = (sub.model ?? "").toLowerCase();
  const isBess = modelLower.includes("battery") || (sub.identifiers ?? []).some(p => p[1].toLowerCase().includes("bess"));
  const isEvse = modelLower.includes("drive") || (sub.identifiers ?? []).some(p => p[1].toLowerCase().includes("evse"));

  const entMap: Record<string, SubDeviceEntityInfo> = {};
  for (const e of entities) {
    const info: SubDeviceEntityInfo = { domain: e.entity_id.split(".")[0] ?? "", unique_id: e.unique_id };
    // The entity's own name, which is what the tile's readings are found by
    // and its rows are labelled with; an entity with none is given none.
    const ownName = entityOwnName(e);
    if (ownName) info.original_name = ownName;
    entMap[e.entity_id] = info;
  }

  return { name: deviceName(sub), type: isBess ? "bess" : isEvse ? "evse" : "unknown", entities: entMap };
}

/**
 * Build a topology from the device and entity registries, where the integration
 * gives none: an integration that lets only an administrator read
 * `panel_topology` refuses anyone else, and a read that fails falls back here
 * too. It carries no monitoring rating.
 *
 * A circuit is found by its power sensor, wherever that sits among the panel's
 * devices: on the circuit's own device, a child of the panel's; on the panel
 * device, where the integration has not given circuits devices yet; or on a
 * charger's device, which keeps its feed circuit's sensors.
 */
export async function discoverEntitiesFallback(hass: HomeAssistant, deviceId: string | undefined, retry?: RetryManager | null): Promise<DiscoveryResult> {
  const devicesMsg = { type: "config/device_registry/list" };
  const entitiesMsg = { type: "config/entity_registry/list" };
  const [devices, entities] = await Promise.all([
    retry ? retry.callWS<DeviceRegistryEntry[]>(hass, devicesMsg, { errorId: "fetch:topology" }) : hass.callWS<DeviceRegistryEntry[]>(devicesMsg),
    retry ? retry.callWS<EntityRegistryEntry[]>(hass, entitiesMsg, { errorId: "fetch:topology" }) : hass.callWS<EntityRegistryEntry[]>(entitiesMsg),
  ]);

  const panelDevice = devices.find(d => d.id === deviceId);
  if (!panelDevice) return { topology: null, panelDevice: null, panelSize: 0 };

  const serial = panelSerial(panelDevice);
  const panelName = deviceName(panelDevice);
  const panelNames = panelNamesOf(panelDevice);

  // The panel's devices: itself, each circuit's, a child of it, and each
  // battery's and charger's, reached through it; each owned by the panel's own
  // config entry, which leaves out a copy of one a helper owns.
  const circuitDevices = devices.filter(d => d.parent_device_id === panelDevice.id && sharesOwner(d, panelDevice));
  const subDevices = devices.filter(d => d.via_device_id === panelDevice.id && sharesOwner(d, panelDevice));
  const circuitDeviceIds = new Set(circuitDevices.map(d => d.id));
  const deviceById = new Map([panelDevice, ...circuitDevices, ...subDevices].map(d => [d.id, d]));
  const circuitDeviceByIdentifier = new Map<string, DeviceRegistryEntry>();
  for (const device of circuitDevices) {
    for (const pair of device.identifiers ?? []) {
      if (pair[0] === INTEGRATION_DOMAIN) circuitDeviceByIdentifier.set(pair[1], device);
    }
  }

  const entitiesByDevice = new Map<string, EntityRegistryEntry[]>();
  for (const entity of entities) {
    if (typeof entity.device_id !== "string" || !deviceById.has(entity.device_id)) continue;
    const onDevice = entitiesByDevice.get(entity.device_id);
    if (onDevice) onDevice.push(entity);
    else entitiesByDevice.set(entity.device_id, [entity]);
  }
  const panelEntities = entitiesByDevice.get(panelDevice.id) ?? [];
  const familyEntities = [...entitiesByDevice.values()].flat();

  // A circuit's other entities are found by the unique ids the integration
  // gives them, never by their entity ids, which each follow their own entity.
  // A switch's unique id carries the serial as the panel reports it and a
  // sensor's carries it lower-cased, so switches are matched without case.
  const sensorByUniqueId = new Map<string, string>();
  const switchByUniqueId = new Map<string, string>();
  for (const entity of familyEntities) {
    if (entity.entity_id.startsWith("sensor.")) sensorByUniqueId.set(entity.unique_id, entity.entity_id);
    else if (entity.entity_id.startsWith("switch.")) switchByUniqueId.set(entity.unique_id.toLowerCase(), entity.entity_id);
  }

  const circuits: Record<string, Circuit> = {};

  for (const ent of familyEntities) {
    const state = hass.states[ent.entity_id];
    if (!state) continue;
    const attrs = state.attributes;
    const tabs = parseTabs(attrs.tabs);
    if (!tabs) continue;

    // A circuit's sensors all carry its tabs; its power sensor alone stands for it.
    const powerId = parsePowerSensorId(ent.unique_id, serial);
    if (!powerId) continue;
    const { circuitId, panelPrefix } = powerId;

    // The circuit's own device: the one its power sensor is on, else the one
    // the integration names for the circuit, which holds a charger's feed
    // circuit's breaker switch while the charger's device holds its sensors.
    const sensorDevice = typeof ent.device_id === "string" ? deviceById.get(ent.device_id) : undefined;
    const circuitDevice =
      sensorDevice && circuitDeviceIds.has(sensorDevice.id) ? sensorDevice : circuitDeviceByIdentifier.get(circuitDeviceIdentifier(serial, circuitId));

    // Labelled by the circuit's device, the user's rename first. Without one,
    // by the sensor's own name; and where that says only what it measures, as
    // on a charger's device, by the device the sensor is on. Neither of the
    // last two carries the panel's name, which the integration puts in front
    // of a charger's.
    const displayName =
      (circuitDevice ? deviceName(circuitDevice) : "") ||
      labelFromPowerSensorName(entityOwnName(ent), panelNames) ||
      (sensorDevice && sensorDevice !== panelDevice ? withoutPanelName(deviceName(sensorDevice), panelNames) : "") ||
      ent.entity_id;

    const voltage = typeof attrs.voltage === "number" ? attrs.voltage : tabs.length === 2 ? 240 : 120;

    const circuitEntities: CircuitEntities = { power: ent.entity_id };
    const breakerSwitch = switchByUniqueId.get(`${panelPrefix}_relay_${circuitId}`.toLowerCase());
    if (breakerSwitch) circuitEntities.switch = breakerSwitch;
    const breakerRating = sensorByUniqueId.get(`${panelPrefix}_${circuitId}${BREAKER_RATING_SUFFIX}`);
    if (breakerRating) circuitEntities.breaker_rating = breakerRating;

    const circuit: Circuit = {
      tabs,
      name: displayName,
      voltage,
      device_type: typeof attrs.device_type === "string" ? attrs.device_type : "circuit",
      relay_state: typeof attrs.relay_state === "string" ? attrs.relay_state : "UNKNOWN",
      is_user_controllable: true,
      breaker_rating_a: null,
      entities: circuitEntities,
    };
    if (circuitDevice) circuit.device_id = circuitDevice.id;
    circuits[circuitId] = circuit;
  }

  let panelSize = 0;
  for (const ent of panelEntities) {
    const state = hass.states[ent.entity_id];
    if (state && isPositiveInteger(state.attributes.panel_size)) {
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

  const subDeviceMap: Record<string, SubDevice> = {};
  for (const sub of subDevices) {
    subDeviceMap[sub.id] = subDeviceRecord(sub, entitiesByDevice.get(sub.id) ?? []);
  }

  const topology: PanelTopology = {
    serial,
    firmware: panelDevice.sw_version ?? "",
    panel_size: panelSize,
    device_id: deviceId,
    device_name: panelName || t("header.default_name"),
    circuits,
    sub_devices: subDeviceMap,
  };

  await resolveAndAssignAreas(hass, topology);

  return { topology, panelDevice, panelSize };
}
