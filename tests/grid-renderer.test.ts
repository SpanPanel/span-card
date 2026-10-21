import { describe, it, expect } from "vitest";
import { buildGridHTML, renderCircuitSlot } from "../src/core/grid-renderer.js";
import { updateCircuitDOM } from "../src/core/dom-updater.js";
import type { Circuit, HomeAssistant, CardConfig, MonitoringPointInfo, PanelTopology } from "../src/types.js";

const hass = { states: {}, services: {}, language: "en" } as unknown as HomeAssistant;

const config: CardConfig = {};

function makeCircuit(overrides: Partial<Circuit> = {}): Circuit {
  return {
    name: "Kitchen",
    tabs: [1],
    entities: {},
    ...overrides,
  };
}

describe("renderCircuitSlot", () => {
  it("escapes user-controllable circuit name in markup", () => {
    const circuit = makeCircuit({ name: '<img src=x onerror="alert(1)">' });
    const html = renderCircuitSlot("uuid1", circuit, 1, "1", "single", hass, config, null, "unknown");
    // The literal tag should never appear; the escaped form should.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes user-controllable uuid in data attribute", () => {
    const circuit = makeCircuit();
    const html = renderCircuitSlot('uuid"onclick=alert(1)"', circuit, 1, "1", "single", hass, config, null, "unknown");
    expect(html).not.toContain('uuid"onclick');
    expect(html).toContain("uuid&quot;onclick");
  });

  it("escapes shedding label so i18n quote characters cannot break the title attribute", () => {
    // The "soc_threshold" shedding priority label comes from i18n; if a future
    // translation contained a quote, an unescaped title= would split the
    // attribute. Exercise the composite-icon branch which uses safeLabel.
    const circuit = makeCircuit();
    const html = renderCircuitSlot("uuid1", circuit, 1, "1", "single", hass, config, null, "soc_threshold");
    // The rendered HTML must remain well-formed: the <ha-icon ... title="..."
    // > attribute must close before any content. A regression would emit
    // `title=""quote here"` breaking subsequent attributes.
    const titleMatches = html.match(/title="[^"]*"/g) ?? [];
    expect(titleMatches.length).toBeGreaterThan(0);
    for (const match of titleMatches) {
      // No stray `"` inside an attribute would survive escapeHtml.
      expect(match.slice(7, -1)).not.toContain('"');
    }
  });
});

const SWITCH = "switch.kitchen_breaker";
const SELECT = "select.kitchen_circuit_priority";
const POWER = "sensor.kitchen_power";

function hassWith(states: Record<string, { state: string; attributes?: Record<string, unknown> }>): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, s]) => [
      entity_id,
      { entity_id, state: s.state, attributes: s.attributes ?? {}, last_changed: "", last_updated: "" },
    ])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

function grid(circuit: Circuit, states: Parameters<typeof hassWith>[0]): HTMLElement {
  const topology = { circuits: { kitchen: circuit } } as unknown as PanelTopology;
  const div = document.createElement("div");
  div.innerHTML = buildGridHTML(topology, { first: 1, last: 2 }, hassWith(states), config, null);
  return div;
}

const KITCHEN = makeCircuit({ entities: { switch: SWITCH, select: SELECT, power: POWER }, is_user_controllable: true, relay_state: "CLOSED" });

describe("a breaker's pill on the grid", () => {
  it("is operable while the switch reads on or off", () => {
    const pill = grid(KITCHEN, { [SWITCH]: { state: "on" } }).querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-on")).toBe(true);
    expect(pill.classList.contains("toggle-unavailable")).toBe(false);
  });

  it("shows the relay state, dimmed and inert, while the switch is unavailable", () => {
    const slot = grid(KITCHEN, { [SWITCH]: { state: "unavailable" }, [POWER]: { state: "0", attributes: { relay_state: "CLOSED" } } });
    const pill = slot.querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-on")).toBe(true);
    expect(pill.classList.contains("toggle-unavailable")).toBe(true);
    expect(slot.querySelector(".circuit-slot")!.classList.contains("circuit-off")).toBe(false);
  });

  it("draws no pill for a guessed switch that has no state", () => {
    expect(grid(KITCHEN, { [POWER]: { state: "0" } }).querySelector(".toggle-pill")).toBeNull();
  });

  it("shows no help icon for an unavailable select, and keeps the last known priority", () => {
    const slot = grid({ ...KITCHEN, priority: "OFF_GRID" }, { [SWITCH]: { state: "on" }, [SELECT]: { state: "unavailable" } });
    expect(slot.innerHTML).not.toContain("mdi:help-circle-outline");
    expect(slot.querySelector(".shedding-icon")!.getAttribute("icon")).toBe("mdi:transmission-tower");
  });

  it("emits the shedding marker, hidden, when the priority is unknown", () => {
    const marker = grid({ ...KITCHEN, entities: { switch: SWITCH, power: POWER } }, { [SWITCH]: { state: "on" } }).querySelector<HTMLElement>(
      ".shedding-composite"
    );
    expect(marker).not.toBeNull();
    expect(marker!.style.display).toBe("none");
  });
});

const CURRENT = "sensor.kitchen_current";
const MEASURED = makeCircuit({
  entities: { switch: SWITCH, power: POWER, current: CURRENT },
  is_user_controllable: true,
  relay_state: "CLOSED",
  breaker_rating_a: 20,
  monitoring_rating_a: 20,
});

function slotOf(states: Parameters<typeof hassWith>[0], cfg: CardConfig = config, monitoring: MonitoringPointInfo | null = null): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = renderCircuitSlot("kitchen", MEASURED, 1, "2", "single", hassWith(states), cfg, monitoring, "unknown");
  return div.querySelector(".circuit-slot")!;
}

describe("a slot's reading on the grid", () => {
  it("shows an unknown power reading as unknown, never 0 W", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [POWER]: { state: "unknown" } });
    expect(slot.querySelector(".power-value")!.textContent!.trim()).toBe("--");
    expect(slot.querySelector(".power-value")!.innerHTML).not.toContain("0");
  });

  it("shows an unavailable power reading as unknown", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [POWER]: { state: "unavailable" } });
    expect(slot.querySelector(".power-value")!.textContent!.trim()).toBe("--");
  });

  it("keeps a published zero as a reading", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [POWER]: { state: "0" } });
    expect(slot.querySelector(".power-value strong")!.textContent).toBe("0");
    expect(slot.querySelector(".power-unit")!.textContent).toBe("W");
  });

  it("does not style an unknown reading as production", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [POWER]: { state: "unknown" } });
    expect(slot.classList.contains("circuit-producer")).toBe(false);
  });

  it("shows an unknown current as unknown, never 0 A", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [CURRENT]: { state: "unknown" } }, { chart_metric: "current" });
    expect(slot.querySelector(".power-value")!.textContent!.trim()).toBe("--");
  });

  it("draws no utilization from an unknown current, never 0 %", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [CURRENT]: { state: "unknown" } }, config, { utilization_pct: null });
    expect(slot.querySelector(".utilization")).toBeNull();
  });

  it("draws utilization from a measured current", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [CURRENT]: { state: "10" } });
    expect(slot.querySelector(".utilization")!.textContent).toBe("50%");
  });

  it("draws no utilization beside an unknown current, whatever figure the monitor still holds", () => {
    for (const held of [0, 45]) {
      const slot = slotOf({ [SWITCH]: { state: "on" }, [CURRENT]: { state: "unavailable" } }, config, { utilization_pct: held });
      expect(slot.querySelector(".utilization")).toBeNull();
    }
  });

  it("draws the monitor's figure beside a measured current", () => {
    const slot = slotOf({ [SWITCH]: { state: "on" }, [CURRENT]: { state: "10" } }, config, { utilization_pct: 45 });
    expect(slot.querySelector(".utilization")!.textContent).toBe("45%");
  });
});

describe("a slot's utilization colour on the grid", () => {
  const TANDEM = { continuous_threshold_pct: 160, spike_threshold_pct: 200 };
  const DEFAULTS = { continuous_threshold_pct: 80, spike_threshold_pct: 100 };
  const ON = { [SWITCH]: { state: "on" } };

  /** The slot's utilization class, from the monitor's figure where given, else 20 A of current over the 20 A rating. */
  function level(amps: string, monitoring: MonitoringPointInfo | null): string | undefined {
    const slot = slotOf({ ...ON, [CURRENT]: { state: amps } }, config, monitoring);
    return [...slot.querySelector(".utilization")!.classList].find(name => name.startsWith("utilization-"));
  }

  it("is judged against the circuit's own thresholds", () => {
    // 30 A on the 20 A breaker is 150 %, under the 160 % continuous threshold set for the pair it is judged as.
    expect(level("30", { ...TANDEM, utilization_pct: 150 })).toBe("utilization-normal");
    expect(level("34", { ...TANDEM, utilization_pct: 170 })).toBe("utilization-warning");
    expect(level("40", { ...TANDEM, utilization_pct: 200 })).toBe("utilization-alert");
  });

  it("keeps the default thresholds' colours", () => {
    expect(level("15", { ...DEFAULTS, utilization_pct: 75 })).toBe("utilization-normal");
    expect(level("16", { ...DEFAULTS, utilization_pct: 80 })).toBe("utilization-warning");
    expect(level("30", { ...DEFAULTS, utilization_pct: 150 })).toBe("utilization-alert");
  });

  it("falls back to 80 % and 100 % with no monitoring info, the utilization coming from the rating", () => {
    expect(level("15", null)).toBe("utilization-normal");
    expect(level("17", null)).toBe("utilization-warning");
    expect(level("30", null)).toBe("utilization-alert");
  });
});

describe("a slot's breaker rating on the grid", () => {
  const states = { [SWITCH]: { state: "on" } };
  const badge = (c: Circuit): HTMLElement => grid(c, states).querySelector<HTMLElement>(".breaker-badge")!;

  it("draws the panel's rating, as before the monitoring rating existed", () => {
    const el = badge({ ...MEASURED, breaker_rating_a: 20 });
    expect(el.innerHTML).toBe("20A");
    expect(el.querySelector(".rating-user-set")).toBeNull();
  });

  it("draws the panel's rating, unmarked, when the user sets a monitoring rating", () => {
    const el = badge({ ...MEASURED, breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true });
    expect(el.innerHTML).toBe("20A");
    expect(el.querySelector(".rating-user-set")).toBeNull();
  });
});

describe("the monitoring rating on the grid", () => {
  it("is what utilization falls back to when the monitor has no figure", () => {
    const circuit = { ...MEASURED, breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true };
    const slot = grid(circuit, { [SWITCH]: { state: "on" }, [CURRENT]: { state: "10" } }).querySelector(".circuit-slot")!;
    expect(slot.querySelector(".utilization")!.textContent).toBe("20%");
  });

  it("is where the current chart draws its limit line", () => {
    const circuit = { ...MEASURED, breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true };
    const topology = { circuits: { kitchen: circuit } } as unknown as PanelTopology;
    const hass = hassWith({ [SWITCH]: { state: "on" }, [CURRENT]: { state: "10" } });
    const root = document.createElement("div");
    const cfg: CardConfig = { chart_metric: "current" };
    root.innerHTML = buildGridHTML(topology, { first: 1, last: 2 }, hass, cfg, null);
    updateCircuitDOM(root, hass, topology, cfg, new Map(), undefined, null);
    const chart = root.querySelector(".chart-container span-chart") as unknown as { data: { data: [number, number][] }[] };
    const limits = chart.data.flatMap(series => series.data.map(point => point[1]));
    expect(limits).toContain(50);
    expect(limits).not.toContain(20);
  });
});
