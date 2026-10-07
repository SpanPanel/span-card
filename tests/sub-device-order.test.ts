import { describe, it, expect } from "vitest";
import { orderSubDevices, panelOfSubDevice } from "../src/core/sub-device-order.js";
import type { FavoritesTopology, PanelTopology, SubDevice, SubDeviceSolar } from "../src/types.js";

const block = (role: SubDeviceSolar["role"]): SubDeviceSolar => ({
  role,
  vendor: null,
  model: null,
  feed_circuit_id: null,
  power_entity_id: null,
  site_power_entity_id: null,
});

describe("orderSubDevices", () => {
  it("groups the solar tiles where the first one was: the site tile, then inverters by name", () => {
    const entries: [string, SubDevice][] = [
      ["bess", { type: "bess", name: "Battery" }],
      ["inv_b", { type: "pv", name: "Solar Inverter (Garage)", solar: block("inverter") }],
      ["evse", { type: "evse", name: "Charger" }],
      ["site", { type: "pv", name: "Solar", solar: block("site") }],
      ["inv_a", { type: "pv", name: "Solar Inverter (Barn)", solar: block("inverter") }],
    ];
    expect(orderSubDevices(entries).map(([id]) => id)).toEqual(["bess", "site", "inv_a", "inv_b", "evse"]);
  });

  it("keeps each panel's solar tiles together in favorites", () => {
    const entries: [string, SubDevice][] = [
      ["p1:inv", { type: "pv", name: "A Solar Inverter (1)", solar: block("inverter") }],
      ["p2:site", { type: "pv", name: "B Solar", solar: block("site") }],
      ["p1:site", { type: "pv", name: "A Solar", solar: block("site") }],
      ["p2:inv", { type: "pv", name: "B Solar Inverter (1)", solar: block("inverter") }],
    ];
    const panelOf = (devId: string): string => devId.split(":")[0] ?? "";
    expect(orderSubDevices(entries, panelOf).map(([id]) => id)).toEqual(["p1:site", "p1:inv", "p2:site", "p2:inv"]);
  });

  it("leaves a topology without solar tiles as it was", () => {
    const entries: [string, SubDevice][] = [
      ["evse", { type: "evse" }],
      ["bess", { type: "bess" }],
    ];
    expect(orderSubDevices(entries)).toEqual(entries);
  });
});

describe("panelOfSubDevice", () => {
  it("reads each favorite's panel from its ref", () => {
    const topology: FavoritesTopology = {
      circuits: {},
      sub_devices: {},
      _favoriteRefs: { "x:dev": { panelDeviceId: "panel-x", kind: "sub_device", targetId: "dev", configEntryId: null } },
    };
    expect(panelOfSubDevice(topology)("x:dev")).toBe("panel-x");
  });

  it("puts every device of a single panel's topology on one panel", () => {
    const topology = { circuits: {}, sub_devices: {} } as unknown as PanelTopology;
    expect(panelOfSubDevice(topology)("anything")).toBe("");
  });
});
