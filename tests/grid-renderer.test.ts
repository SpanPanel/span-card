import { describe, it, expect } from "vitest";
import { buildGridHTML, renderCircuitSlot } from "../src/core/grid-renderer.js";
import type { Circuit, HomeAssistant, CardConfig, PanelTopology } from "../src/types.js";

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
  div.innerHTML = buildGridHTML(topology, 1, hassWith(states), config, null);
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
