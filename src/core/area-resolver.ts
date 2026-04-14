import type { HomeAssistant, PanelTopology } from "../types.js";

interface AreaRegistryEntry {
  area_id: string;
  name: string;
}

interface EntityRegistryEntry {
  entity_id: string;
  area_id?: string;
  device_id?: string;
}

interface DeviceRegistryEntry {
  id: string;
  area_id?: string;
}

/**
 * Fetch HA registries and assign area names to each circuit in the topology.
 *
 * Resolution order per circuit:
 *   1. First entity in `circuit.entities` that has an explicit area assignment.
 *   2. The panel device's area (via `topology.device_id`).
 *   3. `undefined` (no area).
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

  // entity_id → area_id (only entries with an explicit area)
  const entityArea = new Map<string, string>();
  for (const ent of entities) {
    if (ent.area_id) {
      entityArea.set(ent.entity_id, ent.area_id);
    }
  }

  // device id → area_id
  const deviceArea = new Map<string, string | undefined>();
  for (const dev of devices) {
    deviceArea.set(dev.id, dev.area_id);
  }

  // Resolve fallback: the panel device's own area
  let panelAreaName: string | undefined;
  if (topology.device_id) {
    const panelDevAreaId = deviceArea.get(topology.device_id);
    if (panelDevAreaId) {
      panelAreaName = areaNames.get(panelDevAreaId);
    }
  }

  for (const circuit of Object.values(topology.circuits)) {
    let resolved: string | undefined;

    // Try each entity on the circuit for an explicit area assignment
    for (const entityId of Object.values(circuit.entities)) {
      if (!entityId) continue;
      const areaId = entityArea.get(entityId);
      if (areaId) {
        resolved = areaNames.get(areaId);
        break;
      }
    }

    // Fall back to the panel device's area
    if (!resolved) {
      resolved = panelAreaName;
    }

    circuit.area = resolved;
  }
}

/**
 * Subscribe to HA area and entity registry changes.
 * When a change is detected that alters any circuit's area assignment,
 * the provided callback is invoked.
 *
 * Returns an unsubscribe function that tears down both listeners.
 */
export async function subscribeAreaUpdates(hass: HomeAssistant, topology: PanelTopology, callback: () => void): Promise<() => void> {
  if (!hass.connection) {
    return () => {};
  }

  const handler = async (): Promise<void> => {
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
    }
  };

  const [unsubEntity, unsubArea] = await Promise.all([
    hass.connection.subscribeEvents(handler, "entity_registry_updated"),
    hass.connection.subscribeEvents(handler, "area_registry_updated"),
  ]);

  return () => {
    unsubEntity();
    unsubArea();
  };
}
