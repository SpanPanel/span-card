import { describe, it, expect } from "vitest";
import { buildSubDevicesHTML } from "../src/core/sub-device-renderer.js";
import type { PanelTopology, HomeAssistant, CardConfig, SubDevice } from "../src/types.js";

/**
 * A sub-device earns a tile by having something to draw, not by being a known type.
 *
 * The Microgrid Interconnect arrived in the parent/child schema with exactly one
 * entity -- a diagnostic enum for utility-supply health -- so it had no power
 * reading, no charts, and nothing opted into `visible_sub_entities`. It rendered
 * as a header bar reading "SUB-DEVICE" and a gear icon, and nothing else.
 *
 * The tempting fix is to exclude the MID by type. These tests pin the rule that
 * was chosen instead, because the empty tile is not a MID bug: any sub-device
 * whose entities are all diagnostic produces it, and v1.0 has more device classes
 * coming. Emptiness is the property; the type is a coincidence.
 */

const hass = {
  states: {
    "sensor.panel_battery_power": { state: "1200", attributes: {} },
    "sensor.panel_mid_grid_state": { state: "up", attributes: {} },
  },
  services: {},
  language: "en",
} as unknown as HomeAssistant;

function topologyOf(subs: Record<string, SubDevice>): PanelTopology {
  return { sub_devices: subs } as unknown as PanelTopology;
}

const MID: SubDevice = {
  name: "Span Panel Microgrid Interconnect",
  type: "mid",
  entities: {
    "sensor.panel_mid_grid_state": { domain: "sensor", original_name: "Grid State" },
  },
} as unknown as SubDevice;

const BESS: SubDevice = {
  name: "Span Panel Battery",
  type: "bess",
  entities: {
    "sensor.panel_battery_power": { domain: "sensor", original_name: "Battery Power" },
  },
} as unknown as SubDevice;

describe("buildSubDevicesHTML", () => {
  it("skips a sub-device with no power reading, charts or visible entities", () => {
    const html = buildSubDevicesHTML(topologyOf({ dev_mid: MID }), hass, {} as CardConfig);

    expect(html).toBe("");
  });

  it("skips it on emptiness, not on being a MID", () => {
    // Same device, same type, one entity the user has chosen to show. If the
    // rule were "hide the MID" this would still be blank.
    const config = { visible_sub_entities: { "sensor.panel_mid_grid_state": true } } as unknown as CardConfig;

    const html = buildSubDevicesHTML(topologyOf({ dev_mid: MID }), hass, config);

    expect(html).toContain("Span Panel Microgrid Interconnect");
  });

  it("still renders the sub-devices that do have something to draw", () => {
    const html = buildSubDevicesHTML(topologyOf({ dev_mid: MID, dev_bess: BESS }), hass, {} as CardConfig);

    expect(html).toContain("Span Panel Battery");
    expect(html).not.toContain("Microgrid Interconnect");
  });

  it("returns nothing at all when every sub-device is empty", () => {
    // Rather than an empty wrapper, which would still take vertical space.
    const html = buildSubDevicesHTML(topologyOf({ dev_mid: MID, dev_other: { ...MID, name: "Something Else" } }), hass, {} as CardConfig);

    expect(html).toBe("");
  });
});
