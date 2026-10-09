import { describe, it, expect } from "vitest";
import { buildPanelStatsHTML } from "../src/core/header-renderer.js";
import { renderCircuitSlot } from "../src/core/grid-renderer.js";
import { updateCircuitDOM, updatePanelStatsBlock } from "../src/core/dom-updater.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";

const CONFIG = { chart_metric: "power" } as CardConfig;
const SITE = "sensor.site_power";
const UPSTREAM = "sensor.upstream_power";
const DOWNSTREAM = "sensor.downstream_power";
const SOLAR = "sensor.solar_power";
const BATTERY = "sensor.battery_level";

function circuit(slug: string, tab: number): Circuit {
  return { name: slug, tabs: [tab], entities: { power: `sensor.${slug}_power` }, relay_state: "CLOSED" } as Circuit;
}

const CIRCUITS = { a: circuit("a", 1), b: circuit("b", 2), c: circuit("c", 3) };

function topology(): PanelTopology {
  return {
    circuits: CIRCUITS,
    panel_entities: { site_power: SITE, current_power: UPSTREAM, feedthrough_power: DOWNSTREAM, pv_power: SOLAR, battery_level: BATTERY },
  } as unknown as PanelTopology;
}

function hassWith(states: Record<string, string>): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

/** A header and the circuits' slots, as the card draws them, without charts. */
function rendered(hass: HomeAssistant): HTMLElement {
  const root = document.createElement("div");
  const slots = Object.entries(CIRCUITS)
    .map(([uuid, c]) => renderCircuitSlot(uuid, c, c.tabs[0]!, "2", "single", hass, CONFIG, null, "unknown"))
    .join("");
  root.innerHTML = buildPanelStatsHTML(topology(), CONFIG) + slots;
  for (const chart of root.querySelectorAll(".chart-container")) chart.remove();
  return root;
}

function stat(root: Element, name: string): Element {
  return root.querySelector(`.stat-${name} .stat-value`)!;
}

describe("the header's readings", () => {
  it("starts every reading unknown, never 0", () => {
    const root = rendered(hassWith({}));
    for (const name of ["consumption", "upstream", "downstream", "solar", "battery"]) {
      expect(stat(root, name).textContent).toBe("--");
    }
  });

  it("shows an unknown site, upstream, downstream, solar or battery reading as unknown", () => {
    const hass = hassWith({ [SITE]: "unknown", [UPSTREAM]: "unavailable", [DOWNSTREAM]: "unknown", [SOLAR]: "unknown", [BATTERY]: "unavailable" });
    const root = rendered(hass);

    updateCircuitDOM(root, hass, topology(), CONFIG, new Map(), undefined);

    for (const name of ["consumption", "upstream", "downstream", "solar", "battery"]) {
      expect(stat(root, name).textContent).toBe("--");
    }
    expect(stat(root, "consumption").classList.contains("stat-partial")).toBe(false);
  });

  it("keeps published zeros as readings", () => {
    const hass = hassWith({ [SITE]: "0", [UPSTREAM]: "0", [DOWNSTREAM]: "0", [SOLAR]: "0", [BATTERY]: "0" });
    const root = rendered(hass);

    updateCircuitDOM(root, hass, topology(), CONFIG, new Map(), undefined);

    for (const name of ["consumption", "upstream", "downstream", "solar"]) {
      expect(stat(root, name).textContent).toBe("0.0");
    }
    expect(stat(root, "battery").textContent).toBe("0");
  });

  it("sums the circuits without the site reading, skips an unknown circuit and marks the sum partial", () => {
    const hass = hassWith({ "sensor.a_power": "1000", "sensor.b_power": "unknown", "sensor.c_power": "500" });
    const root = rendered(hass);

    updateCircuitDOM(root, hass, topology(), CONFIG, new Map(), undefined);

    expect(stat(root, "consumption").textContent).toBe("1.5");
    expect(stat(root, "consumption").classList.contains("stat-partial")).toBe(true);
  });

  it("drops the partial mark once every circuit reads", () => {
    const root = rendered(hassWith({}));
    updateCircuitDOM(root, hassWith({ "sensor.a_power": "1000", "sensor.b_power": "unknown" }), topology(), CONFIG, new Map(), undefined);

    updateCircuitDOM(root, hassWith({ "sensor.a_power": "1000", "sensor.b_power": "500", "sensor.c_power": "0" }), topology(), CONFIG, new Map(), undefined);

    expect(stat(root, "consumption").textContent).toBe("1.5");
    expect(stat(root, "consumption").classList.contains("stat-partial")).toBe(false);
  });

  it("shows the circuits' sum as unknown when no circuit reads", () => {
    const hass = hassWith({ "sensor.a_power": "unknown", "sensor.b_power": "unavailable" });
    const root = rendered(hass);

    updateCircuitDOM(root, hass, topology(), CONFIG, new Map(), undefined);

    expect(stat(root, "consumption").textContent).toBe("--");
  });

  it("shows the site as unknown in a block given no sum to fall back on", () => {
    const block = document.createElement("div");
    block.innerHTML = buildPanelStatsHTML(topology(), CONFIG);

    updatePanelStatsBlock(block, hassWith({}), topology(), CONFIG, null);

    expect(stat(block, "consumption").textContent).toBe("--");
  });
});

describe("a slot's reading after an update", () => {
  it("turns an unknown power reading into unknown, never 0 W, and not production", () => {
    const root = rendered(hassWith({ "sensor.a_power": "-300" }));
    const slot = root.querySelector('.circuit-slot[data-uuid="a"]')!;
    expect(slot.classList.contains("circuit-producer")).toBe(true);

    updateCircuitDOM(root, hassWith({ "sensor.a_power": "unknown" }), topology(), CONFIG, new Map(), undefined);

    expect(slot.querySelector(".power-value")!.textContent!.trim()).toBe("--");
    expect(slot.classList.contains("circuit-producer")).toBe(false);
  });

  it("turns an unknown current into unknown, never 0 A", () => {
    const withCurrent = { ...CIRCUITS.a, entities: { power: "sensor.a_power", current: "sensor.a_current" } } as Circuit;
    const top = { circuits: { a: withCurrent } } as unknown as PanelTopology;
    const amps = { chart_metric: "current" } as CardConfig;
    const root = document.createElement("div");
    root.innerHTML = renderCircuitSlot("a", withCurrent, 1, "2", "single", hassWith({ "sensor.a_current": "4" }), amps, null, "unknown");
    root.querySelector(".chart-container")?.remove();

    updateCircuitDOM(root, hassWith({ "sensor.a_current": "unavailable" }), top, amps, new Map(), undefined);

    expect(root.querySelector(".power-value")!.textContent!.trim()).toBe("--");
  });
});
