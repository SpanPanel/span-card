import { describe, it, expect } from "vitest";
import { buildGridHTML } from "../src/core/grid-renderer.js";
import { buildPanelStatsHTML } from "../src/core/header-renderer.js";
import { updateCircuitDOM, updateSubDeviceDOM } from "../src/core/dom-updater.js";
import { buildSolarDetailHTML } from "../src/core/sub-device-renderer.js";
import { readsAsProducer } from "../src/core/circuit-state.js";
import { resolveSubDevicePower } from "../src/helpers/sub-device-power.js";
import { positionRange } from "../src/helpers/layout.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology, SubDevice, SubDeviceSolar } from "../src/types.js";

const CONFIG = { chart_metric: "power" } as CardConfig;

function hassWith(states: Record<string, string>): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

function circuit(slug: string, tab: number, fields: Partial<Circuit> = {}): Circuit {
  return { name: slug, tabs: [tab], device_type: "circuit", relay_state: "CLOSED", entities: { power: `sensor.${slug}_power` }, ...fields };
}

describe("a circuit reads as generation", () => {
  it("when the topology flags it, whatever its device type", () => {
    // eBus connection/feeds-role SOLAR: a circuit that reports a solar role, with no inverter behind it.
    expect(readsAsProducer(circuit("roof", 1, { is_generation: true }), 400)).toBe(true);
    expect(readsAsProducer(circuit("roof", 1, { device_type: "pv", is_generation: false }), 400)).toBe(false);
  });

  it("by its device type where the topology carries no flag", () => {
    expect(readsAsProducer(circuit("roof", 1, { device_type: "pv" }), 400)).toBe(true);
    expect(readsAsProducer(circuit("kitchen", 1), 400)).toBe(false);
  });

  it("while measured feeding power back, flag or not", () => {
    expect(readsAsProducer(circuit("kitchen", 1, { is_generation: false }), -50)).toBe(true);
  });
});

describe("a flagged circuit on the grid and in the circuits' sum", () => {
  // eBus connection/feeds-role SOLAR
  const circuits = { roof: circuit("roof", 1, { is_generation: true }), kitchen: circuit("kitchen", 2, { is_generation: false }) };
  const topology = { circuits, panel_size: 2, panel_entities: { site_power: "sensor.site_power" } } as PanelTopology;
  const hass = hassWith({ "sensor.roof_power": "2000", "sensor.kitchen_power": "300" });

  it("is styled as production", () => {
    const root = document.createElement("div");
    root.innerHTML = buildGridHTML(topology, positionRange(topology, 2)!, hass, CONFIG, null);
    expect(root.querySelector('[data-uuid="roof"]')!.classList.contains("circuit-producer")).toBe(true);
    expect(root.querySelector('[data-uuid="kitchen"]')!.classList.contains("circuit-producer")).toBe(false);
  });

  it("is no load in the site sum", () => {
    const root = document.createElement("div");
    root.innerHTML = buildPanelStatsHTML(topology, CONFIG) + buildGridHTML(topology, positionRange(topology, 2)!, hass, CONFIG, null);
    updateCircuitDOM(root, hass, topology, CONFIG, new Map(), undefined);
    expect(root.querySelector(".stat-consumption .stat-value")!.textContent).toBe("0.3");
  });
});

const SITE_TOTAL = "sensor.pv_power";
const CIRCUIT_POWER = "sensor.roof_power";

function solarBlock(fields: Partial<SubDeviceSolar> = {}): SubDeviceSolar {
  return {
    role: "site",
    vendor: null,
    model: null,
    feed_circuit_id: "roof",
    power_entity_id: CIRCUIT_POWER,
    site_power_entity_id: SITE_TOTAL,
    ...fields,
  };
}

function detail(solar: SubDeviceSolar, states: Record<string, string>): HTMLElement {
  const sub: SubDevice = { name: "Solar", type: "pv", entities: {}, solar };
  const root = document.createElement("div");
  root.innerHTML = `<div data-subdev="solar">${buildSolarDetailHTML(solar, resolveSubDevicePower(sub), hassWith(states))}</div>`;
  return root;
}

function siteTotalRow(root: ParentNode): HTMLElement {
  return root.querySelector(".sub-site-total-value")!.closest<HTMLElement>(".sub-entity")!;
}

describe("a solar tile", () => {
  it("of a circuit that reports a solar role has no identity line", () => {
    // eBus connection/feeds-role SOLAR: the source is the circuit's role, so there is no vendor or model to show.
    const root = detail(solarBlock({ identity: "role", vendor: "Any", model: "Thing" }), { [SITE_TOTAL]: "2000" });
    expect(root.querySelector(".sub-identity")).toBeNull();
  });

  it("of a published inverter keeps its identity line", () => {
    const root = detail(solarBlock({ vendor: "Vendor", model: "Model" }), { [SITE_TOTAL]: "2000" });
    expect(root.querySelector(".sub-identity")!.textContent).toBe("Vendor · Model");
  });

  it("shows the site total while it reads", () => {
    const root = detail(solarBlock(), { [SITE_TOTAL]: "2000" });
    expect(siteTotalRow(root).hidden).toBe(false);
  });

  it.each(["unknown", "unavailable"])("omits the site total while it is %s, never showing 0", state => {
    const root = detail(solarBlock(), { [SITE_TOTAL]: state });
    const row = siteTotalRow(root);
    expect(row.hidden).toBe(true);
    expect(row.textContent).not.toMatch(/\b0\s*W/);
  });

  it("shows and omits the site total as live updates change it", () => {
    const sub: SubDevice = { name: "Solar", type: "pv", entities: {}, solar: solarBlock() };
    const topology = { circuits: {}, sub_devices: { solar: sub } } as unknown as PanelTopology;
    const root = detail(solarBlock(), { [SITE_TOTAL]: "unknown" });
    const row = siteTotalRow(root);

    updateSubDeviceDOM(root, hassWith({ [SITE_TOTAL]: "1500" }), topology, CONFIG, new Map(), undefined);
    expect(row.hidden).toBe(false);
    updateSubDeviceDOM(root, hassWith({ [SITE_TOTAL]: "unknown" }), topology, CONFIG, new Map(), undefined);
    expect(row.hidden).toBe(true);
  });
});
