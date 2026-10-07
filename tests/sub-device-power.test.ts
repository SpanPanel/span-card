import { describe, it, expect } from "vitest";
import { resolveSubDevicePower, tileRenderedEntityIds } from "../src/helpers/sub-device-power.js";
import type { SubDevice, SubDeviceSolar } from "../src/types.js";
import { BATTERY_CAPACITY, BATTERY_LEVEL, BATTERY_POWER, BATTERY_SOE, METER_POWER, REALISTIC_BESS } from "./realistic-bess.js";

/**
 * One answer to "what is this tile's power". A solar tile's power is what the
 * integration says it is -- its feeding circuit's reading, or the site total
 * when the Solar device describes no single metered inverter -- and is never
 * guessed from names or suffixes.
 */

const SITE_TOTAL = "sensor.span_panel_pv_power";
const CIRCUIT = "sensor.span_panel_commissioned_pv_system_power";

function solar(overrides: Partial<SubDeviceSolar>): SubDeviceSolar {
  return {
    role: "inverter",
    vendor: null,
    model: null,
    feed_circuit_id: null,
    power_entity_id: null,
    site_power_entity_id: null,
    ...overrides,
  };
}

function pv(block: SubDeviceSolar, entities: SubDevice["entities"] = {}): SubDevice {
  return { name: "Span Panel Solar", type: "pv", solar: block, entities };
}

describe("resolveSubDevicePower", () => {
  it("takes an inverter's power from its block, never from its entities", () => {
    const sub = pv(solar({ power_entity_id: CIRCUIT }), {
      "sensor.vendor_power_reading": { domain: "sensor", original_name: "Power", unique_id: "x_power" },
    });
    expect(resolveSubDevicePower(sub)).toEqual({ headlineEid: CIRCUIT, headlineIsSiteTotal: false, siteTotalEid: null });
  });

  it("gives an inverter no circuit feeds no individual reading", () => {
    expect(resolveSubDevicePower(pv(solar({})))).toEqual({ headlineEid: null, headlineIsSiteTotal: false, siteTotalEid: null });
  });

  it("heads the site tile with its inverter's circuit and keeps the site total as a row", () => {
    const sub = pv(solar({ role: "site", power_entity_id: CIRCUIT, site_power_entity_id: SITE_TOTAL }));
    expect(resolveSubDevicePower(sub)).toEqual({ headlineEid: CIRCUIT, headlineIsSiteTotal: false, siteTotalEid: SITE_TOTAL });
  });

  it("heads the site tile with the site total when it describes no metered inverter", () => {
    const sub = pv(solar({ role: "site", site_power_entity_id: SITE_TOTAL }));
    expect(resolveSubDevicePower(sub)).toEqual({ headlineEid: SITE_TOTAL, headlineIsSiteTotal: true, siteTotalEid: null });
  });

  it("falls back to today's lookup without a block", () => {
    expect(resolveSubDevicePower(REALISTIC_BESS).headlineEid).toBe(BATTERY_POWER);
  });
});

describe("tileRenderedEntityIds", () => {
  it("is the headline and the site total for a site tile", () => {
    const sub = pv(solar({ role: "site", power_entity_id: CIRCUIT, site_power_entity_id: SITE_TOTAL }));
    expect(tileRenderedEntityIds(sub)).toEqual(new Set([CIRCUIT, SITE_TOTAL]));
  });

  it("hides what a real battery tile draws, and not its Meter Power or Nameplate Capacity", () => {
    // The old editor rule hid every `_power` sensor; the tile draws only one of the two (spec F15).
    // It also hid Nameplate Capacity, which the tile draws nowhere: no header, chart or row shows it.
    const drawn = tileRenderedEntityIds(REALISTIC_BESS);
    expect(drawn).toEqual(new Set([BATTERY_POWER, BATTERY_LEVEL, BATTERY_SOE]));
    expect(drawn.has(METER_POWER)).toBe(false);
    expect(drawn.has(BATTERY_CAPACITY)).toBe(false);
  });
});
