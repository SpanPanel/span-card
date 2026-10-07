import { describe, it, expect } from "vitest";
import { buildSubDevicesHTML } from "../src/core/sub-device-renderer.js";
import { subEntityGroups } from "../src/editor/sub-entity-groups.js";
import { formatPowerHTML } from "../src/helpers/format.js";
import type { CardConfig, HomeAssistant, PanelTopology, SubDevice, SubDeviceEntityInfo, SubDeviceSolar } from "../src/types.js";

/**
 * The `solar` blocks the integration's topology handler actually sends, fed
 * through the renderer and the editor.
 *
 * The blocks for scenario A, for span#269's shape and for PV with no inverter
 * published are copied verbatim from the handler's output over a real
 * registry (illustrative serial `example-40t-001`). The pending block is the
 * shape the integration's tests pin: no inverter published, so no identity,
 * and the bound circuit C as its power.
 *
 * Each sub-device also carries the registry fields the wire sends beside the
 * block. The card does not type them, because it never reads them; they are
 * here so the tests show it takes identity from the block, not the registry.
 * On span#269's shape the Solar device's registry model is the placeholder
 * "Solar Inverter", while its block's model is null.
 */

type WireSubDevice = SubDevice & {
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  sw_version: string | null;
};

const SERIAL = "example-40t-001";
const SITE_TOTAL = "sensor.span_panel_solar_pv_power";
const CIRCUIT_C = "sensor.span_panel_solar_inverter_power";
const CIRCUIT_C2 = "sensor.span_panel_garage_solar_power";

const hass = {
  states: {
    [SITE_TOTAL]: { state: "5200", attributes: {} },
    [CIRCUIT_C]: { state: "3100", attributes: {} },
    [CIRCUIT_C2]: { state: "2100", attributes: {} },
  },
  services: {},
  language: "en",
} as unknown as HomeAssistant;

/** The Solar device's entities: PV Power, the metadata sensors and the panel link. */
function solarEntities(): Record<string, SubDeviceEntityInfo> {
  return {
    [SITE_TOTAL]: { domain: "sensor", original_name: "PV Power", unique_id: `span_${SERIAL}_pv_power` },
    "sensor.span_panel_solar_pv_vendor": { domain: "sensor", original_name: "PV Vendor", unique_id: `span_${SERIAL}_pv_vendor` },
    "sensor.span_panel_solar_pv_product": { domain: "sensor", original_name: "PV Product", unique_id: `span_${SERIAL}_pv_product` },
    "sensor.span_panel_solar_pv_nameplate_capacity": {
      domain: "sensor",
      original_name: "PV Nameplate Capacity",
      unique_id: `span_${SERIAL}_pv_nameplate_capacity`,
    },
    "binary_sensor.span_panel_solar_pv_panel_link": { domain: "binary_sensor", original_name: "PV Panel Link", unique_id: `span_${SERIAL}_pv_panel_link` },
  };
}

/** An inverter card's metadata sensors, whose unique ids embed its key (spec F8). */
function inverterEntities(slug: string, key: string): Record<string, SubDeviceEntityInfo> {
  return {
    [`sensor.${slug}_pv_vendor`]: { domain: "sensor", original_name: "PV Vendor", unique_id: `span_${SERIAL}_pv_${key}_pv_vendor` },
    [`sensor.${slug}_pv_product`]: { domain: "sensor", original_name: "PV Product", unique_id: `span_${SERIAL}_pv_${key}_pv_product` },
    [`sensor.${slug}_pv_nameplate_capacity`]: {
      domain: "sensor",
      original_name: "PV Nameplate Capacity",
      unique_id: `span_${SERIAL}_pv_${key}_pv_nameplate_capacity`,
    },
  };
}

function topologyOf(subs: Record<string, WireSubDevice>): PanelTopology {
  return { circuits: {}, sub_devices: subs } as unknown as PanelTopology;
}

/** One tile of the rendered HTML, by device id. */
function tile(html: string, devId: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  const el = root.querySelector<HTMLElement>(`[data-subdev="${devId}"]`);
  if (!el) throw new Error(`no tile for ${devId}`);
  return el;
}

function text(el: HTMLElement, selector: string): string | undefined {
  return el.querySelector(selector)?.textContent?.trim();
}

function render(subs: Record<string, WireSubDevice>): string {
  return buildSubDevicesHTML(topologyOf(subs), hass, {} as CardConfig);
}

// -- Scenario A: two inverters, both fed by a circuit --

const A_SITE_BLOCK: SubDeviceSolar = {
  role: "site",
  vendor: "Enphase",
  model: "IQ8PLUS-72-2-US",
  feed_circuit_id: "573066aaddd7b75114c4563ce3af18c4",
  power_entity_id: "sensor.span_panel_solar_inverter_power",
  site_power_entity_id: "sensor.span_panel_solar_pv_power",
};
const A_INVERTER_BLOCK: SubDeviceSolar = {
  role: "inverter",
  vendor: "Second Vendor",
  model: "IQ8PLUS-72-2-US",
  feed_circuit_id: "5be1d2c3a4f5061728394a5b6c7d8e9f",
  power_entity_id: "sensor.span_panel_garage_solar_power",
  site_power_entity_id: null,
};

const SCENARIO_A: Record<string, WireSubDevice> = {
  dev_garage: {
    name: "SPAN Panel Solar Inverter (Garage Solar)",
    type: "pv",
    manufacturer: "Second Vendor",
    model: "IQ8PLUS-72-2-US",
    serial_number: null,
    sw_version: null,
    entities: inverterEntities("span_panel_solar_inverter_garage_solar", "5be1d2c3a4f5061728394a5b6c7d8e9f"),
    solar: A_INVERTER_BLOCK,
  },
  dev_solar: {
    name: "SPAN Panel Solar",
    type: "pv",
    manufacturer: "Enphase",
    model: "IQ8PLUS-72-2-US",
    serial_number: null,
    sw_version: null,
    entities: solarEntities(),
    solar: A_SITE_BLOCK,
  },
};

// -- span#269's shape: two upstream inverters behind a gateway, unbound --

const B_SITE_BLOCK: SubDeviceSolar = {
  role: "site",
  vendor: "SolarEdge",
  model: null,
  feed_circuit_id: null,
  power_entity_id: null,
  site_power_entity_id: "sensor.span_panel_solar_pv_power",
};
const B_INVERTER_1_BLOCK: SubDeviceSolar = {
  role: "inverter",
  vendor: "SolarEdge",
  model: "SE7600H-US",
  feed_circuit_id: null,
  power_entity_id: null,
  site_power_entity_id: null,
};
const B_INVERTER_2_BLOCK: SubDeviceSolar = {
  role: "inverter",
  vendor: "SolarEdge",
  model: "USE7600H-US",
  feed_circuit_id: null,
  power_entity_id: null,
  site_power_entity_id: null,
};

const SCENARIO_B: Record<string, WireSubDevice> = {
  dev_inv_2: {
    name: "SPAN Panel Solar Inverter (2)",
    type: "pv",
    manufacturer: "SolarEdge",
    model: "USE7600H-US",
    serial_number: null,
    sw_version: null,
    entities: inverterEntities("span_panel_solar_inverter_2", "panel-use7600h-us-2"),
    solar: B_INVERTER_2_BLOCK,
  },
  dev_solar: {
    name: "SPAN Panel Solar",
    type: "pv",
    manufacturer: "SolarEdge",
    model: "Solar Inverter",
    serial_number: null,
    sw_version: null,
    entities: solarEntities(),
    solar: B_SITE_BLOCK,
  },
  dev_inv_1: {
    name: "SPAN Panel Solar Inverter (1)",
    type: "pv",
    manufacturer: "SolarEdge",
    model: "SE7600H-US",
    serial_number: null,
    sw_version: null,
    entities: inverterEntities("span_panel_solar_inverter_1", "panel-se7600h-us-1"),
    solar: B_INVERTER_1_BLOCK,
  },
};

// -- PV commissioned, no inverter published --

const NONE_PUBLISHED_BLOCK: SubDeviceSolar = {
  role: "site",
  vendor: null,
  model: null,
  feed_circuit_id: null,
  power_entity_id: null,
  site_power_entity_id: "sensor.span_panel_solar_pv_power",
};

// -- Pending: bound to circuit C, no inverter published --

const PENDING_BLOCK: SubDeviceSolar = {
  role: "site",
  vendor: null,
  model: null,
  feed_circuit_id: "573066aaddd7b75114c4563ce3af18c4",
  power_entity_id: "sensor.span_panel_solar_inverter_power",
  site_power_entity_id: "sensor.span_panel_solar_pv_power",
};

function soleSolar(block: SubDeviceSolar): Record<string, WireSubDevice> {
  return {
    dev_solar: {
      name: "SPAN Panel Solar",
      type: "pv",
      manufacturer: "Unknown",
      model: "Solar Inverter",
      serial_number: null,
      sw_version: null,
      entities: solarEntities(),
      solar: block,
    },
  };
}

const SOLAR_DEVICE_OPTIONS = [
  { entityId: "sensor.span_panel_solar_pv_vendor", label: "PV Vendor" },
  { entityId: "sensor.span_panel_solar_pv_product", label: "PV Product" },
  { entityId: "sensor.span_panel_solar_pv_nameplate_capacity", label: "PV Nameplate Capacity" },
  { entityId: "binary_sensor.span_panel_solar_pv_panel_link", label: "PV Panel Link" },
];

describe("the integration's solar blocks, scenario A: two circuit-fed inverters", () => {
  const html = render(SCENARIO_A);

  it("heads the Solar tile with circuit C, its identity, and the site total as a row", () => {
    const site = tile(html, "dev_solar");

    expect(text(site, ".sub-device-type")).toBe("Solar");
    expect(text(site, ".sub-identity")).toBe("Enphase · IQ8PLUS-72-2-US");
    expect(site.querySelector(".sub-power-value")?.innerHTML).toBe(formatPowerHTML(3100));
    expect(site.querySelector(".sub-power-caption")).toBeNull();
    expect(site.querySelector(`[data-site-total-eid="${SITE_TOTAL}"]`)?.innerHTML).toBe(formatPowerHTML(5200));
    expect(site.querySelector('[data-chart-key="sub_dev_solar_power"]')).not.toBeNull();
    expect(site.querySelector(".sub-note")).toBeNull();
  });

  it("gives the second inverter its own tile with circuit C2's power", () => {
    const inverter = tile(html, "dev_garage");

    expect(text(inverter, ".sub-device-type")).toBe("Solar inverter");
    expect(text(inverter, ".sub-identity")).toBe("Second Vendor · IQ8PLUS-72-2-US");
    expect(inverter.querySelector(".sub-power-value")?.innerHTML).toBe(formatPowerHTML(2100));
    expect(inverter.querySelector("[data-site-total-eid]")).toBeNull();
    expect(inverter.querySelector('[data-chart-key="sub_dev_garage_power"]')).not.toBeNull();
    expect(html.indexOf('data-subdev="dev_solar"')).toBeLessThan(html.indexOf('data-subdev="dev_garage"'));
  });

  it("offers each device's metadata in the editor, under its own heading, and never PV Power", () => {
    expect(subEntityGroups(SCENARIO_A, "pv")).toEqual([
      { devId: "dev_solar", name: "SPAN Panel Solar", entities: SOLAR_DEVICE_OPTIONS },
      {
        devId: "dev_garage",
        name: "SPAN Panel Solar Inverter (Garage Solar)",
        entities: [
          { entityId: "sensor.span_panel_solar_inverter_garage_solar_pv_vendor", label: "PV Vendor" },
          { entityId: "sensor.span_panel_solar_inverter_garage_solar_pv_product", label: "PV Product" },
          { entityId: "sensor.span_panel_solar_inverter_garage_solar_pv_nameplate_capacity", label: "PV Nameplate Capacity" },
        ],
      },
    ]);
  });
});

describe("the integration's solar blocks, span#269's shape: two upstream inverters, unbound", () => {
  const html = render(SCENARIO_B);

  it("captions the site total as the Solar tile's headline, with the block's vendor and not the registry's placeholder model", () => {
    const site = tile(html, "dev_solar");

    expect(text(site, ".sub-device-type")).toBe("Solar");
    expect(text(site, ".sub-identity")).toBe("SolarEdge");
    expect(site.textContent).not.toContain("Solar Inverter");
    expect(text(site, ".sub-power-caption")).toBe("Site total");
    expect(site.querySelector(".sub-power-value")?.innerHTML).toBe(formatPowerHTML(5200));
    expect(site.querySelector("[data-site-total-eid]")).toBeNull();
    expect(site.querySelector('[data-chart-key="sub_dev_solar_power"]')).not.toBeNull();
    expect(site.querySelector(".sub-note")).toBeNull();
  });

  it("shows each upstream inverter's identity, included in the site total, with no reading or chart", () => {
    for (const [devId, identity] of [
      ["dev_inv_1", "SolarEdge · SE7600H-US"],
      ["dev_inv_2", "SolarEdge · USE7600H-US"],
    ] as const) {
      const inverter = tile(html, devId);
      expect(text(inverter, ".sub-device-type")).toBe("Solar inverter");
      expect(text(inverter, ".sub-identity")).toBe(identity);
      expect(text(inverter, ".sub-note")).toBe("Included in the site total");
      expect(inverter.querySelector(".sub-power-value")).toBeNull();
      expect(inverter.querySelector("[data-chart-key]")).toBeNull();
    }
  });

  it("orders the Solar tile first, then the inverters by name", () => {
    const order = ["dev_solar", "dev_inv_1", "dev_inv_2"].map(devId => html.indexOf(`data-subdev="${devId}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(subEntityGroups(SCENARIO_B, "pv").map(g => g.devId)).toEqual(["dev_solar", "dev_inv_1", "dev_inv_2"]);
  });

  it("offers the Solar device's metadata in the editor, and never PV Power", () => {
    expect(subEntityGroups(SCENARIO_B, "pv")[0]).toEqual({ devId: "dev_solar", name: "SPAN Panel Solar", entities: SOLAR_DEVICE_OPTIONS });
  });
});

describe("the integration's solar blocks, PV commissioned with no inverter published", () => {
  const html = render(soleSolar(NONE_PUBLISHED_BLOCK));

  it("labels the tile Solar, with no identity, and the captioned site total as its headline", () => {
    const site = tile(html, "dev_solar");

    expect(text(site, ".sub-device-type")).toBe("Solar");
    expect(html).not.toContain("Sub-device");
    expect(site.querySelector(".sub-identity")).toBeNull();
    expect(site.textContent).not.toContain("Solar Inverter");
    expect(site.textContent).not.toContain("Unknown");
    expect(text(site, ".sub-power-caption")).toBe("Site total");
    expect(site.querySelector(".sub-power-value")?.innerHTML).toBe(formatPowerHTML(5200));
    expect(site.querySelector("[data-site-total-eid]")).toBeNull();
  });

  it("offers the Solar device's metadata in the editor, and never PV Power", () => {
    expect(subEntityGroups(soleSolar(NONE_PUBLISHED_BLOCK), "pv")).toEqual([{ devId: "dev_solar", name: "SPAN Panel Solar", entities: SOLAR_DEVICE_OPTIONS }]);
  });
});

describe("the integration's solar blocks, pending: bound to circuit C, no inverter published", () => {
  const html = render(soleSolar(PENDING_BLOCK));

  it("keeps the bound circuit as the headline, with no identity and the site total as a row", () => {
    const site = tile(html, "dev_solar");

    expect(text(site, ".sub-device-type")).toBe("Solar");
    expect(site.querySelector(".sub-identity")).toBeNull();
    expect(site.querySelector(".sub-power-caption")).toBeNull();
    expect(site.querySelector(".sub-power-value")?.innerHTML).toBe(formatPowerHTML(3100));
    expect(site.querySelector(`[data-site-total-eid="${SITE_TOTAL}"]`)?.innerHTML).toBe(formatPowerHTML(5200));
    expect(site.querySelector('[data-chart-key="sub_dev_solar_power"]')).not.toBeNull();
  });

  it("offers the Solar device's metadata in the editor, and never PV Power or the bound circuit", () => {
    expect(subEntityGroups(soleSolar(PENDING_BLOCK), "pv")).toEqual([{ devId: "dev_solar", name: "SPAN Panel Solar", entities: SOLAR_DEVICE_OPTIONS }]);
  });
});
