import { describe, it, expect, vi } from "vitest";
import type { Circuit, HomeAssistant, PanelTopology } from "../src/types.js";
import { resolveAndAssignAreas, subscribeAreaUpdates } from "../src/core/area-resolver.js";
import { ErrorStore } from "../src/core/error-store.js";
import type { DeviceRegistryEntry, EntityRegistryEntry } from "../src/core/registry-types.js";
import { DEVICE_REGISTRY, ENTITY_REGISTRY, FakeConnection } from "./fake-connection.js";

// A circuit with no area of its own takes the panel device's area. The panel is
// found by the device topology names, because the id a card holds can be one
// from before Home Assistant 2026.8 that the device list no longer contains.
const OLD_ID = "panel-before-2026-8";
const CURRENT_ID = "panel-now";

function hassWithPanelIn(areaName: string): HomeAssistant {
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/area_registry/list":
        return [{ area_id: "garage", name: areaName }];
      case "config/entity_registry/list":
        return [];
      case "config/device_registry/list":
        return [{ id: CURRENT_ID, area_id: "garage" }];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  return { callWS } as unknown as HomeAssistant;
}

function topologyWith(ids: Pick<PanelTopology, "device_id" | "panel_device_id">): PanelTopology {
  return {
    ...ids,
    circuits: { kitchen: { name: "Kitchen", tabs: [1], entities: {} } as unknown as PanelTopology["circuits"][string] },
  };
}

describe("resolveAndAssignAreas", () => {
  it("gives a circuit the area of the panel device topology names", async () => {
    const topology = topologyWith({ device_id: OLD_ID, panel_device_id: CURRENT_ID });

    await resolveAndAssignAreas(hassWithPanelIn("Garage"), topology);

    expect(topology.circuits.kitchen?.area).toBe("Garage");
  });

  it("falls back to the requested device when topology names none", async () => {
    const topology = topologyWith({ device_id: CURRENT_ID });

    await resolveAndAssignAreas(hassWithPanelIn("Garage"), topology);

    expect(topology.circuits.kitchen?.area).toBe("Garage");
  });
});

// A circuit is a child device of its panel, and Home Assistant files a device
// under its own area, then its parent's. A circuit with no device, or whose
// device has no area, is filed by its entities' areas before the panel's.
const CIRCUIT_DEVICE = "device-kitchen";
const CHARGER_DEVICE = "device-charger";
const POWER = "sensor.kitchen_power";
const BREAKER = "switch.kitchen_breaker";

const AREAS = [
  { area_id: "kitchen", name: "Kitchen" },
  { area_id: "pantry", name: "Pantry" },
  { area_id: "garage", name: "Garage" },
  { area_id: "driveway", name: "Driveway" },
];

interface Registries {
  entities: EntityRegistryEntry[];
  devices: DeviceRegistryEntry[];
}

/** A hass answering from `registries` as they stand when asked, so a test can change them between calls. */
function hassHolding(registries: Registries): HomeAssistant {
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/area_registry/list":
        return AREAS;
      case "config/entity_registry/list":
        return registries.entities;
      case "config/device_registry/list":
        return registries.devices;
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  return { callWS } as unknown as HomeAssistant;
}

function panelIn(area_id: string | null): DeviceRegistryEntry {
  return { id: CURRENT_ID, name: "SPAN Panel", area_id, parent_device_id: null, via_device_id: null };
}

/** The circuit's device, as the device list sends a child device. */
function circuitDeviceIn(area_id: string | null): DeviceRegistryEntry {
  return { id: CIRCUIT_DEVICE, name: "Kitchen", area_id, parent_device_id: CURRENT_ID };
}

function entity(entity_id: string, device_id: string, area_id: string | null = null): EntityRegistryEntry {
  return { entity_id, unique_id: entity_id, device_id, area_id };
}

function kitchenTopology(circuit: Partial<Circuit> = {}): PanelTopology {
  return { panel_device_id: CURRENT_ID, circuits: { kitchen: { name: "Kitchen", tabs: [1], entities: { power: POWER, switch: BREAKER }, ...circuit } } };
}

async function areaOf(topology: PanelTopology, registries: Registries): Promise<string | undefined> {
  await resolveAndAssignAreas(hassHolding(registries), topology);
  return topology.circuits.kitchen?.area;
}

describe("area resolves circuit device, then entity, then panel", () => {
  // The notice for a breaker switch that joined its circuit's area advises
  // giving the switch an area of its own. That says where the switch is filed,
  // not the circuit, which stays in its device's area.
  it("keeps a circuit in its device's area when its breaker switch has an area of its own", async () => {
    const registries = {
      devices: [panelIn("garage"), circuitDeviceIn("pantry")],
      entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE, "kitchen")],
    };

    expect(await areaOf(kitchenTopology({ device_id: CIRCUIT_DEVICE }), registries)).toBe("Pantry");
  });

  it("takes an entity's own area where the circuit's device has none", async () => {
    const registries = {
      devices: [panelIn("garage"), circuitDeviceIn(null)],
      entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE, "kitchen")],
    };

    expect(await areaOf(kitchenTopology({ device_id: CIRCUIT_DEVICE }), registries)).toBe("Kitchen");
  });

  it("takes an entity's own area before the area of a device the record does not name", async () => {
    const registries = {
      devices: [panelIn("garage"), circuitDeviceIn("pantry")],
      entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE, "kitchen")],
    };

    expect(await areaOf(kitchenTopology(), registries)).toBe("Kitchen");
  });

  it("takes an entity's own area on a circuit with no device, before the panel's", async () => {
    const registries = {
      devices: [panelIn("garage")],
      entities: [entity(POWER, CURRENT_ID), entity(BREAKER, CURRENT_ID, "kitchen")],
    };

    expect(await areaOf(kitchenTopology({ device_id: null }), registries)).toBe("Kitchen");
  });

  // The integration names each circuit's device in its record; a record that
  // names none leaves the card to find the device through the circuit's entities.
  describe.each([
    ["the record names the circuit's device", { device_id: CIRCUIT_DEVICE }],
    ["the device is found through the circuit's entities", {}],
  ])("where %s", (_case, record) => {
    it("takes the circuit device's area", async () => {
      const registries = {
        devices: [panelIn("garage"), circuitDeviceIn("pantry")],
        entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE)],
      };

      expect(await areaOf(kitchenTopology(record), registries)).toBe("Pantry");
    });

    it("then the panel's area", async () => {
      const registries = {
        devices: [panelIn("garage"), circuitDeviceIn(null)],
        entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE)],
      };

      expect(await areaOf(kitchenTopology(record), registries)).toBe("Garage");
    });

    it("and has none where neither it, its device nor the panel has one", async () => {
      const registries = {
        devices: [panelIn(null), circuitDeviceIn(null)],
        entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE)],
      };

      expect(await areaOf(kitchenTopology(record), registries)).toBeUndefined();
    });
  });

  it("takes the area of the device the record names for a circuit with no entity in the registry", async () => {
    const registries = { devices: [panelIn("garage"), circuitDeviceIn("pantry")], entities: [] };

    expect(await areaOf(kitchenTopology({ device_id: CIRCUIT_DEVICE }), registries)).toBe("Pantry");
  });

  it("passes over an area id that names no area", async () => {
    const registries = {
      devices: [panelIn("garage"), circuitDeviceIn("pantry")],
      entities: [entity(POWER, CIRCUIT_DEVICE, "deleted-area"), entity(BREAKER, CIRCUIT_DEVICE)],
    };

    expect(await areaOf(kitchenTopology(), registries)).toBe("Pantry");
  });

  it("passes over a device's area id that names no area", async () => {
    const registries = {
      devices: [panelIn("garage"), circuitDeviceIn("deleted-area")],
      entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE, "kitchen")],
    };

    expect(await areaOf(kitchenTopology({ device_id: CIRCUIT_DEVICE }), registries)).toBe("Kitchen");
  });

  it("gives a circuit whose entities are still on the panel device the panel's area", async () => {
    const registries = { devices: [panelIn("garage")], entities: [entity(POWER, CURRENT_ID), entity(BREAKER, CURRENT_ID)] };

    expect(await areaOf(kitchenTopology(), registries)).toBe("Garage");
  });

  // A charger's feed circuit: sensors on the charger's device, breaker switch on the circuit's own.
  describe("for a circuit whose sensors sit on a charger's device", () => {
    const chargerIn = (area_id: string | null): DeviceRegistryEntry => ({ id: CHARGER_DEVICE, name: "SPAN Drive", area_id, via_device_id: CURRENT_ID });

    it("takes the area of the device the record names before the charger's", async () => {
      const registries = {
        devices: [panelIn("garage"), circuitDeviceIn("pantry"), chargerIn("driveway")],
        entities: [entity(POWER, CHARGER_DEVICE), entity(BREAKER, CIRCUIT_DEVICE)],
      };

      expect(await areaOf(kitchenTopology({ device_id: CIRCUIT_DEVICE }), registries)).toBe("Pantry");
    });

    it("takes the charger's area where the circuit's own device has none", async () => {
      const registries = {
        devices: [panelIn("garage"), circuitDeviceIn(null), chargerIn("driveway")],
        entities: [entity(POWER, CHARGER_DEVICE), entity(BREAKER, CIRCUIT_DEVICE)],
      };

      expect(await areaOf(kitchenTopology({ device_id: CIRCUIT_DEVICE }), registries)).toBe("Driveway");
    });
  });
});

describe("subscribeAreaUpdates", () => {
  function hassOn(connection: FakeConnection): HomeAssistant {
    return { ...hassWithPanelIn("Garage"), connection } as unknown as HomeAssistant;
  }

  it("reads the topology once per registry event", async () => {
    const connection = new FakeConnection();
    const topology = topologyWith({ panel_device_id: CURRENT_ID });
    const getTopology = vi.fn(() => topology);
    await subscribeAreaUpdates(hassOn(connection), getTopology, () => {}, new ErrorStore());

    connection.emit(ENTITY_REGISTRY, {});

    await vi.waitFor(() => expect(topology.circuits.kitchen?.area).toBe("Garage"));
    expect(getTopology).toHaveBeenCalledTimes(1);
  });

  it("resolves against whichever topology is current when the event arrives", async () => {
    const connection = new FakeConnection();
    const first = topologyWith({ panel_device_id: CURRENT_ID });
    const second = topologyWith({ panel_device_id: CURRENT_ID });
    let current = first;
    const changed = vi.fn();
    await subscribeAreaUpdates(hassOn(connection), () => current, changed, new ErrorStore());

    current = second;
    connection.emit(ENTITY_REGISTRY, {});

    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(second.circuits.kitchen?.area).toBe("Garage");
    expect(first.circuits.kitchen?.area).toBeUndefined();
  });

  it("area re-resolves on device_registry_updated", async () => {
    const connection = new FakeConnection();
    const registries = { devices: [panelIn("garage"), circuitDeviceIn(null)], entities: [entity(POWER, CIRCUIT_DEVICE), entity(BREAKER, CIRCUIT_DEVICE)] };
    const topology = kitchenTopology({ device_id: CIRCUIT_DEVICE });
    const hass = { ...hassHolding(registries), connection } as unknown as HomeAssistant;
    await resolveAndAssignAreas(hass, topology);
    expect(topology.circuits.kitchen?.area).toBe("Garage");
    const changed = vi.fn();
    await subscribeAreaUpdates(hass, () => topology, changed, new ErrorStore());

    // The user puts the circuit's device in an area: no entity and no area changes.
    registries.devices = [panelIn("garage"), circuitDeviceIn("pantry")];
    connection.emit(DEVICE_REGISTRY, {});

    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(topology.circuits.kitchen?.area).toBe("Pantry");
  });

  it("stops listening to all three registries when unsubscribed", async () => {
    const connection = new FakeConnection();
    const unsubscribe = await subscribeAreaUpdates(
      hassOn(connection),
      () => null,
      () => {},
      new ErrorStore()
    );
    expect([connection.live(ENTITY_REGISTRY), connection.live("area_registry_updated"), connection.live(DEVICE_REGISTRY)]).toEqual([1, 1, 1]);

    unsubscribe();

    expect(connection.subscriptions.filter(s => !s.unsubscribed)).toEqual([]);
  });

  it("does nothing while there is no topology", async () => {
    const connection = new FakeConnection();
    const changed = vi.fn();
    const hass = hassOn(connection);
    await subscribeAreaUpdates(hass, () => null, changed, new ErrorStore());

    connection.emit(ENTITY_REGISTRY, {});
    await Promise.resolve();

    expect(changed).not.toHaveBeenCalled();
  });
});
