import { describe, it, expect } from "vitest";
import { buildSubDevicesHTML } from "../src/core/sub-device-renderer.js";
import { formatPowerHTML } from "../src/helpers/format.js";
import type { PanelTopology, HomeAssistant, CardConfig, SubDevice, SubDeviceSolar } from "../src/types.js";
import { BATTERY_CAPACITY, REALISTIC_BESS } from "./realistic-bess.js";

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

const SITE_TOTAL = "sensor.span_panel_pv_power";
const CIRCUIT_A = "sensor.span_panel_commissioned_pv_system_power";
const CIRCUIT_B = "sensor.span_panel_solar_inverter_2_power";

const solarHass = {
  states: {
    [SITE_TOTAL]: { state: "5200", attributes: {} },
    [CIRCUIT_A]: { state: "3100", attributes: {} },
    [CIRCUIT_B]: { state: "2100", attributes: {} },
  },
  services: {},
  language: "en",
} as unknown as HomeAssistant;

function block(overrides: Partial<SubDeviceSolar>): SubDeviceSolar {
  return { role: "inverter", vendor: null, model: null, feed_circuit_id: null, power_entity_id: null, site_power_entity_id: null, ...overrides };
}

const SITE: SubDevice = {
  name: "Span Panel Solar",
  type: "pv",
  entities: { [SITE_TOTAL]: { domain: "sensor", original_name: "PV Power", unique_id: "span_x_pv_power" } },
  solar: block({
    role: "site",
    vendor: "Enphase",
    model: "IQ8PLUS-72-2-US",
    feed_circuit_id: "c36",
    power_entity_id: CIRCUIT_A,
    site_power_entity_id: SITE_TOTAL,
  }),
};
const SECOND: SubDevice = {
  name: "Span Panel Solar Inverter (Solar Inverter 2)",
  type: "pv",
  entities: {},
  solar: block({ vendor: "SolarEdge", model: "SE3800H-US", feed_circuit_id: "c24", power_entity_id: CIRCUIT_B }),
};
const UPSTREAM: SubDevice = { name: "Span Panel Solar Inverter (1)", type: "pv", entities: {}, solar: block({ vendor: "SolarEdge" }) };

describe("solar tiles", () => {
  it("draws the bound inverter's circuit on the Solar tile and always the site total as a row", () => {
    // PV Power is made visible on purpose: the tile draws it, so it must still not appear as an entity row.
    const config = { visible_sub_entities: { [SITE_TOTAL]: true } } as unknown as CardConfig;
    const html = buildSubDevicesHTML(topologyOf({ site: SITE }), solarHass, config);

    expect(html).toContain('<span class="sub-device-type">Solar</span>');
    expect(html).toContain("Enphase · IQ8PLUS-72-2-US");
    expect(html).toContain(`<span class="sub-power-value">${formatPowerHTML(3100)}</span>`);
    expect(html).toContain(`data-site-total-eid="${SITE_TOTAL}">${formatPowerHTML(5200)}`);
    expect(html).toContain('data-chart-key="sub_site_power"');
    expect(html).not.toContain(`data-eid="${SITE_TOTAL}"`);
  });

  it("captions the headline when it is the site total", () => {
    const site: SubDevice = { ...SITE, solar: block({ role: "site", site_power_entity_id: SITE_TOTAL }) };
    const html = buildSubDevicesHTML(topologyOf({ site }), solarHass, {} as CardConfig);

    expect(html).toContain('class="sub-power-caption"');
    expect(html).toContain(`<span class="sub-power-value">${formatPowerHTML(5200)}</span>`);
    expect(html).not.toContain("data-site-total-eid");
  });

  it("labels a solar device Solar, block or not", () => {
    // An integration that predates the block still sends `type: "pv"`; the tile must never read "Sub-device".
    const legacy: SubDevice = {
      name: "Span Panel Solar",
      type: "pv",
      entities: { [SITE_TOTAL]: { domain: "sensor", original_name: "PV Power", unique_id: "span_x_pv_power" } },
    };
    const html = buildSubDevicesHTML(topologyOf({ legacy }), solarHass, {} as CardConfig);

    expect(html).toContain('<span class="sub-device-type">Solar</span>');
    expect(html).not.toContain("Sub-device");
  });

  it("gives every other inverter its own tile with its circuit's power", () => {
    const html = buildSubDevicesHTML(topologyOf({ site: SITE, second: SECOND }), solarHass, {} as CardConfig);

    expect(html).toContain('<span class="sub-device-type">Solar inverter</span>');
    expect(html).toContain("SolarEdge · SE3800H-US");
    expect(html).toContain('data-chart-key="sub_second_power"');
    expect(html.indexOf('data-subdev="site"')).toBeLessThan(html.indexOf('data-subdev="second"'));
  });

  it("shows an inverter no circuit feeds with its identity, included in the site total", () => {
    const html = buildSubDevicesHTML(topologyOf({ upstream: UPSTREAM }), solarHass, {} as CardConfig);

    expect(html).toContain("Span Panel Solar Inverter (1)");
    expect(html).toContain("SolarEdge");
    expect(html).toContain("Included in the site total");
    expect(html).not.toContain("sub-power-value");
    expect(html).not.toContain("data-chart-key");
  });

  it("renders an inverter's power without consulting topology.circuits", () => {
    // The favorites merge re-keys and filters circuits; the tile must not need them.
    const topology = { sub_devices: { second: SECOND }, circuits: {} } as unknown as PanelTopology;
    expect(buildSubDevicesHTML(topology, solarHass, {} as CardConfig)).toContain(`<span class="sub-power-value">${formatPowerHTML(2100)}</span>`);
  });

  it("hides every solar tile when show_solar is off", () => {
    const html = buildSubDevicesHTML(topologyOf({ site: SITE, second: SECOND }), solarHass, { show_solar: false } as CardConfig);
    expect(html).toBe("");
  });
});

describe("battery tile rows", () => {
  it("shows Nameplate Capacity as a row once it is chosen, since the tile draws it nowhere else", () => {
    const batteryHass = {
      states: { [BATTERY_CAPACITY]: { state: "13.5", attributes: { unit_of_measurement: "kWh" } } },
      services: {},
      language: "en",
    } as unknown as HomeAssistant;
    const config = { visible_sub_entities: { [BATTERY_CAPACITY]: true } } as unknown as CardConfig;

    const html = buildSubDevicesHTML(topologyOf({ bess: REALISTIC_BESS }), batteryHass, config);

    expect(html).toContain(`data-eid="${BATTERY_CAPACITY}"`);
  });
});
