import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HomeAssistant, PanelDevice, PanelTopology } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", () => ({
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import { FavoritesController, buildCompositeId } from "../src/core/favorites-controller.js";

const mockDiscover = vi.mocked(discoverTopology);

const hass = { states: {} } as unknown as HomeAssistant;

function makePanel(id: string, name: string, entryId: string): PanelDevice {
  return {
    id,
    name,
    name_by_user: undefined,
    config_entries: [entryId],
  } as unknown as PanelDevice;
}

function makeTopology(circuits: Record<string, { name: string }>, deviceName = "SPAN Panel"): PanelTopology {
  const fullCircuits = Object.fromEntries(
    Object.entries(circuits).map(([uuid, c]) => [uuid, { name: c.name, tabs: [], entities: {} } as unknown as PanelTopology["circuits"][string]])
  );
  return {
    circuits: fullCircuits,
    device_name: deviceName,
    panel_entities: {},
  };
}

describe("FavoritesController.build", () => {
  let controller: FavoritesController;

  beforeEach(() => {
    controller = new FavoritesController();
    mockDiscover.mockReset();
  });

  it("empty favorites → empty topology, no entries, no stats", async () => {
    const result = await controller.build(hass, {}, []);
    expect(Object.keys(result.topology.circuits)).toHaveLength(0);
    expect(result.topology.sub_devices).toBeDefined();
    expect(Object.keys(result.topology.sub_devices!)).toHaveLength(0);
    expect(result.entryIds).toEqual([]);
    expect(result.perPanelStats).toEqual([]);
  });

  it("single panel with 2 favorited circuits → 2 composite-id circuits, no name prefix", async () => {
    const panel = makePanel("panel-1", "Home Panel", "entry-1");
    const topology = makeTopology({ "uuid-a": { name: "Kitchen" }, "uuid-b": { name: "Living Room" } });
    mockDiscover.mockResolvedValue({ topology, panelDevice: panel, panelSize: 200 });

    const favorites = {
      "panel-1": { circuits: ["uuid-a", "uuid-b"], sub_devices: [] },
    };

    const result = await controller.build(hass, favorites, [panel]);

    const circuitKeys = Object.keys(result.topology.circuits);
    expect(circuitKeys).toHaveLength(2);
    expect(circuitKeys).toContain(buildCompositeId("panel-1", "uuid-a"));
    expect(circuitKeys).toContain(buildCompositeId("panel-1", "uuid-b"));

    // No prefix when only one panel contributes
    expect(result.topology.circuits[buildCompositeId("panel-1", "uuid-a")].name).toBe("Kitchen");
    expect(result.topology.circuits[buildCompositeId("panel-1", "uuid-b")].name).toBe("Living Room");

    expect(result.entryIds).toEqual(["entry-1"]);
    expect(result.perPanelStats).toHaveLength(1);
    expect(result.perPanelStats[0].panelDeviceId).toBe("panel-1");
    expect(result.perPanelStats[0].topology).toBe(topology);
  });

  it("two panels each with 1 favorite → 2 circuits, names prefixed with panel label", async () => {
    const panel1 = makePanel("panel-1", "Span Panel 1", "entry-1");
    const panel2 = makePanel("panel-2", "Span Panel 2", "entry-2");
    const topology1 = makeTopology({ "uuid-a": { name: "Garage" } }, "SPAN 1");
    const topology2 = makeTopology({ "uuid-b": { name: "Kitchen" } }, "SPAN 2");

    mockDiscover.mockImplementation((_hass, deviceId) => {
      if (deviceId === "panel-1") return Promise.resolve({ topology: topology1, panelDevice: panel1, panelSize: 200 });
      if (deviceId === "panel-2") return Promise.resolve({ topology: topology2, panelDevice: panel2, panelSize: 200 });
      return Promise.reject(new Error("unknown panel"));
    });

    const favorites = {
      "panel-1": { circuits: ["uuid-a"], sub_devices: [] },
      "panel-2": { circuits: ["uuid-b"], sub_devices: [] },
    };

    const result = await controller.build(hass, favorites, [panel1, panel2]);

    expect(Object.keys(result.topology.circuits)).toHaveLength(2);

    // Names should be prefixed when more than one panel contributes
    const circuit1 = result.topology.circuits[buildCompositeId("panel-1", "uuid-a")];
    const circuit2 = result.topology.circuits[buildCompositeId("panel-2", "uuid-b")];
    expect(circuit1.name).toBe("Span Panel 1 · Garage");
    expect(circuit2.name).toBe("Span Panel 2 · Kitchen");

    expect(result.entryIds.sort()).toEqual(["entry-1", "entry-2"].sort());
    expect(result.perPanelStats).toHaveLength(2);
  });

  it("panel missing from panels list → its favorites are dropped", async () => {
    const panel = makePanel("panel-1", "Home Panel", "entry-1");
    // "panel-2" is NOT in the panels array
    const topology = makeTopology({ "uuid-a": { name: "Kitchen" } });
    mockDiscover.mockResolvedValue({ topology, panelDevice: panel, panelSize: 200 });

    const favorites = {
      "panel-1": { circuits: ["uuid-a"], sub_devices: [] },
      "panel-2": { circuits: ["uuid-z"], sub_devices: [] },
    };

    const result = await controller.build(hass, favorites, [panel]);

    // Only panel-1's circuit appears; panel-2 was dropped before fetch
    expect(Object.keys(result.topology.circuits)).toHaveLength(1);
    expect(result.topology.circuits[buildCompositeId("panel-1", "uuid-a")]).toBeDefined();
    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(mockDiscover).toHaveBeenCalledWith(hass, "panel-1");
  });

  it("discoverTopology rejection for one panel → that panel dropped, others still merge", async () => {
    const panel1 = makePanel("panel-1", "Good Panel", "entry-1");
    const panel2 = makePanel("panel-2", "Bad Panel", "entry-2");
    const topology1 = makeTopology({ "uuid-a": { name: "Office" } });

    mockDiscover.mockImplementation((_hass, deviceId) => {
      if (deviceId === "panel-1") return Promise.resolve({ topology: topology1, panelDevice: panel1, panelSize: 200 });
      return Promise.reject(new Error("fetch failed"));
    });

    const favorites = {
      "panel-1": { circuits: ["uuid-a"], sub_devices: [] },
      "panel-2": { circuits: ["uuid-b"], sub_devices: [] },
    };

    const result = await controller.build(hass, favorites, [panel1, panel2]);

    // Only panel-1 contributes; panel-2 fetch rejected and was dropped
    expect(Object.keys(result.topology.circuits)).toHaveLength(1);
    expect(result.topology.circuits[buildCompositeId("panel-1", "uuid-a")]).toBeDefined();
    expect(result.entryIds).toEqual(["entry-1"]);
    expect(result.perPanelStats).toHaveLength(1);
  });

  it("favorited uuid not present in topology → silently dropped", async () => {
    const panel = makePanel("panel-1", "Home Panel", "entry-1");
    // Topology only has "uuid-a"; "uuid-missing" is not in it
    const topology = makeTopology({ "uuid-a": { name: "Kitchen" } });
    mockDiscover.mockResolvedValue({ topology, panelDevice: panel, panelSize: 200 });

    const favorites = {
      "panel-1": { circuits: ["uuid-a", "uuid-missing"], sub_devices: [] },
    };

    const result = await controller.build(hass, favorites, [panel]);

    expect(Object.keys(result.topology.circuits)).toHaveLength(1);
    expect(result.topology.circuits[buildCompositeId("panel-1", "uuid-a")]).toBeDefined();
    expect(result.topology.circuits[buildCompositeId("panel-1", "uuid-missing")]).toBeUndefined();
  });

  it("favorited sub_device → appears under composite id, refs populated correctly", async () => {
    const panel = makePanel("panel-1", "Home Panel", "entry-1");
    const topology: PanelTopology = {
      circuits: {},
      sub_devices: {
        "sub-uuid-1": { name: "Solar Inverter", type: "solar" },
      },
      device_name: "SPAN Panel",
      panel_entities: {},
    };
    mockDiscover.mockResolvedValue({ topology, panelDevice: panel, panelSize: 200 });

    const favorites = {
      "panel-1": { circuits: [], sub_devices: ["sub-uuid-1"] },
    };

    const result = await controller.build(hass, favorites, [panel]);

    const compositeId = buildCompositeId("panel-1", "sub-uuid-1");
    expect(result.topology.sub_devices![compositeId]).toBeDefined();
    expect(result.topology.sub_devices![compositeId].name).toBe("Solar Inverter");
    expect(result.topology._favoriteRefs[compositeId]).toMatchObject({
      panelDeviceId: "panel-1",
      kind: "sub_device",
      targetId: "sub-uuid-1",
      configEntryId: "entry-1",
    });
  });

  it("_favoriteRefs records origin for circuits", async () => {
    const panel = makePanel("panel-1", "Home Panel", "entry-1");
    const topology = makeTopology({ "uuid-a": { name: "Kitchen" } });
    mockDiscover.mockResolvedValue({ topology, panelDevice: panel, panelSize: 200 });

    const favorites = {
      "panel-1": { circuits: ["uuid-a"], sub_devices: [] },
    };

    const result = await controller.build(hass, favorites, [panel]);

    const compositeId = buildCompositeId("panel-1", "uuid-a");
    expect(result.topology._favoriteRefs[compositeId]).toMatchObject({
      panelDeviceId: "panel-1",
      kind: "circuit",
      targetId: "uuid-a",
      configEntryId: "entry-1",
    });
  });
});
