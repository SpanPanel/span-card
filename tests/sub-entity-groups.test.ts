import { describe, it, expect } from "vitest";
import { subEntityGroups } from "../src/editor/sub-entity-groups.js";
import type { SubDevice, SubDeviceSolar } from "../src/types.js";
import { BATTERY_VENDOR, METER_POWER, REALISTIC_BESS } from "./realistic-bess.js";

const block = (overrides: Partial<SubDeviceSolar>): SubDeviceSolar => ({
  role: "inverter",
  vendor: null,
  model: null,
  feed_circuit_id: null,
  power_entity_id: null,
  site_power_entity_id: null,
  ...overrides,
});

describe("subEntityGroups", () => {
  it("lists the Solar device and every inverter, each under its own heading", () => {
    const subs: Record<string, SubDevice> = {
      inv: {
        name: "Span Panel Solar Inverter (Garage)",
        type: "pv",
        solar: block({ power_entity_id: "sensor.garage_power" }),
        entities: { "sensor.inv_vendor": { domain: "sensor", original_name: "Span Panel Solar Inverter (Garage) PV Vendor" } },
      },
      site: {
        name: "Span Panel Solar",
        type: "pv",
        solar: block({ role: "site", power_entity_id: "sensor.c36_power", site_power_entity_id: "sensor.span_panel_pv_power" }),
        entities: {
          "sensor.span_panel_pv_power": { domain: "sensor", original_name: "PV Power" },
          "sensor.span_panel_pv_vendor": { domain: "sensor", original_name: "PV Vendor" },
        },
      },
    };

    expect(subEntityGroups(subs, "pv")).toEqual([
      { devId: "site", name: "Span Panel Solar", entities: [{ entityId: "sensor.span_panel_pv_vendor", label: "PV Vendor" }] },
      { devId: "inv", name: "Span Panel Solar Inverter (Garage)", entities: [{ entityId: "sensor.inv_vendor", label: "PV Vendor" }] },
    ]);
  });

  it("lists every device of a type, each under its own heading", () => {
    const charger = (name: string, id: string): SubDevice => ({
      name,
      type: "evse",
      entities: {
        [`sensor.${id}_power`]: { domain: "sensor", original_name: "Power", unique_id: `${id}_power` },
        [`sensor.${id}_status`]: { domain: "sensor", original_name: "Status" },
      },
    });
    const groups = subEntityGroups({ a: charger("Drive A", "a"), b: charger("Drive B", "b") }, "evse");

    expect(groups.map(g => g.name)).toEqual(["Drive A", "Drive B"]);
    expect(groups.map(g => g.entities.map(e => e.entityId))).toEqual([["sensor.a_status"], ["sensor.b_status"]]);
  });

  it("offers the battery's Meter Power, which the tile does not draw", () => {
    // A deliberate change (spec F15): the old suffix rule hid it, with every other `_power` sensor.
    const [group] = subEntityGroups({ bess: REALISTIC_BESS }, "bess");

    expect(group?.entities.map(e => e.entityId)).toEqual([METER_POWER, BATTERY_VENDOR]);
  });
});
