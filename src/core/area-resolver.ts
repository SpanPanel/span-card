import type { HomeAssistant, PanelTopology } from "../types.js";
import type { ErrorStore } from "./error-store.js";
import type { DeviceRegistryEntry, EntityRegistryEntry } from "./registry-types.js";
import { t } from "../i18n.js";

interface AreaRegistryEntry {
  area_id: string;
  name: string;
}

/** The registry events after which a circuit's area can differ: each registry an area is read from. */
const REGISTRY_EVENTS = ["entity_registry_updated", "area_registry_updated", "device_registry_updated"] as const;

/**
 * Fetch HA registries and assign area names to each circuit in the topology.
 *
 * Resolution order per circuit. A circuit is a device, and Home Assistant
 * files a device under its own area, so the circuit's device is asked before
 * its entities. An entity's own area says where that entity is filed, as for a
 * breaker switch kept out of its room's area-wide actions, not where the
 * circuit is.
 *   1. The circuit's own device, which its record names in `device_id`.
 *   2. The first entity in `circuit.entities` with an area of its own. This is
 *      the circuit's area where it has no device, as before the integration
 *      gives circuits devices, and where its device has no area.
 *   3. Each device its entities are on, found through the entity registry: a
 *      charger's, which keeps its feed circuit's sensors, and the circuit's
 *      own where the record names none.
 *   4. The panel device's area (via `topology.panel_device_id`, else `topology.device_id`).
 *   5. `undefined` (no area).
 * The first of these that names an existing area gives it.
 */
export async function resolveAndAssignAreas(hass: HomeAssistant, topology: PanelTopology): Promise<void> {
  const [areas, entities, devices] = await Promise.all([
    hass.callWS<AreaRegistryEntry[]>({ type: "config/area_registry/list" }),
    hass.callWS<EntityRegistryEntry[]>({ type: "config/entity_registry/list" }),
    hass.callWS<DeviceRegistryEntry[]>({ type: "config/device_registry/list" }),
  ]);

  // area_id → area name
  const areaNames = new Map<string, string>();
  for (const area of areas) {
    areaNames.set(area.area_id, area.name);
  }

  // entity_id → area_id (only entries with an explicit area), and entity_id → the device it is on
  const entityArea = new Map<string, string>();
  const entityDevice = new Map<string, string>();
  for (const ent of entities) {
    if (ent.area_id) {
      entityArea.set(ent.entity_id, ent.area_id);
    }
    if (ent.device_id) {
      entityDevice.set(ent.entity_id, ent.device_id);
    }
  }

  // device id → area_id (only devices with an area)
  const deviceArea = new Map<string, string>();
  for (const dev of devices) {
    if (dev.area_id) {
      deviceArea.set(dev.id, dev.area_id);
    }
  }

  // The panel's current device, which differs from the requested id when that
  // is one from before Home Assistant 2026.8 the device list no longer holds.
  const panelDeviceId = topology.panel_device_id ?? topology.device_id;

  const areaOfDevice = (deviceId: string | null | undefined): string | undefined => (deviceId ? deviceArea.get(deviceId) : undefined);

  for (const circuit of Object.values(topology.circuits)) {
    const entityIds = Object.values(circuit.entities).filter((entityId): entityId is string => !!entityId);
    // The areas that could be the circuit's, nearest first; an id that names no area is passed over.
    const areaIds = [
      areaOfDevice(circuit.device_id),
      ...entityIds.map(entityId => entityArea.get(entityId)),
      ...entityIds.map(entityId => areaOfDevice(entityDevice.get(entityId))),
      areaOfDevice(panelDeviceId),
    ];
    circuit.area = areaIds.map(areaId => (areaId ? areaNames.get(areaId) : undefined)).find(name => !!name);
  }
}

/**
 * Subscribe to HA area, entity and device registry changes, re-resolving circuit
 * areas on whichever topology `getTopology` returns when the event arrives. The
 * device registry is among them because a circuit's area is usually its
 * device's, which the user sets without touching any entity. A re-fetch
 * replaces the topology; the subscription is never re-created for it, and never
 * bound to a stale object. The callback runs when any circuit's area changed.
 *
 * Returns an unsubscribe function that tears down all three listeners.
 */
export async function subscribeAreaUpdates(
  hass: HomeAssistant,
  getTopology: () => PanelTopology | null,
  callback: () => void,
  errorStore?: ErrorStore | null
): Promise<() => void> {
  const connection = hass.connection;
  if (!connection) {
    return () => {};
  }

  const handler = async (): Promise<void> => {
    // Read once: the snapshot of areas and the resolution must act on the same
    // object even if a re-fetch lands while this handler awaits.
    const topology = getTopology();
    if (!topology) return;
    try {
      // Snapshot current area values
      const before = new Map<string, string | undefined>();
      for (const [id, circuit] of Object.entries(topology.circuits)) {
        before.set(id, circuit.area);
      }

      await resolveAndAssignAreas(hass, topology);

      // Check for changes
      for (const [id, circuit] of Object.entries(topology.circuits)) {
        if (circuit.area !== before.get(id)) {
          callback();
          return;
        }
      }
    } catch (err) {
      console.warn("[span-panel] area registry update failed:", err);
      errorStore?.add({
        key: "fetch:areas",
        level: "warning",
        message: t("error.areas_failed"),
        persistent: false,
      });
    }
  };

  const unsubscribes = await Promise.all(REGISTRY_EVENTS.map(event => connection.subscribeEvents(handler, event)));

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
