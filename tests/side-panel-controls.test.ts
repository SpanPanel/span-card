import { describe, it, expect, afterEach } from "vitest";
import "../src/core/side-panel.js";
import type { HomeAssistant } from "../src/types.js";

const SWITCH = "switch.kitchen_breaker";
const SELECT = "select.kitchen_circuit_priority";
const POWER = "sensor.kitchen_power";

type SidePanel = HTMLElement & { hass: HomeAssistant; open(config: unknown): void };

function hass(states: Record<string, string>): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en", callService: async () => undefined, callWS: async () => ({}) } as unknown as HomeAssistant;
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function openFor(states: Record<string, string>, priority?: string): SidePanel {
  const panel = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(panel);
  mounted.push(panel);
  panel.hass = hass(states);
  panel.open({
    uuid: "kitchen",
    name: "Kitchen",
    tabs: [2],
    entities: { switch: SWITCH, select: SELECT, power: POWER },
    is_user_controllable: true,
    relay_state: "CLOSED",
    priority,
    monitoringInfo: null,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
  });
  return panel;
}

function relay(panel: SidePanel): HTMLElement & { disabled: boolean } {
  return panel.shadowRoot!.querySelector('[data-role="relay-toggle"]') as HTMLElement & { disabled: boolean };
}

function select(panel: SidePanel): HTMLSelectElement {
  return panel.shadowRoot!.querySelector('[data-role="shedding-select"]') as HTMLSelectElement;
}

describe("the side panel's controls", () => {
  it("are enabled while the switch and select are operable", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" });
    expect(relay(panel).disabled).toBe(false);
    expect(select(panel).disabled).toBe(false);
    expect(select(panel).value).toBe("never");
  });

  it("are drawn disabled while the switch and select are unavailable, showing the last known state", () => {
    const panel = openFor({ [SWITCH]: "unavailable", [SELECT]: "unavailable" }, "OFF_GRID");
    expect(relay(panel).disabled).toBe(true);
    expect(relay(panel).hasAttribute("checked")).toBe(true);
    expect(select(panel).disabled).toBe(true);
    expect(select(panel).value).toBe("off_grid");
  });

  it("shows no priority as chosen when it is unknown, on first render and on a live update", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "unavailable" });
    expect(select(panel).selectedIndex).toBe(-1);

    panel.hass = hass({ [SWITCH]: "on", [SELECT]: "soc_threshold" });
    expect(select(panel).value).toBe("soc_threshold");

    panel.hass = hass({ [SWITCH]: "on", [SELECT]: "unknown" });
    expect(select(panel).selectedIndex).toBe(-1);
    expect(select(panel).disabled).toBe(true);
  });

  it("tracks the switch going unavailable on a live update", () => {
    const panel = openFor({ [SWITCH]: "off", [SELECT]: "never" });
    panel.hass = hass({ [SWITCH]: "unavailable", [SELECT]: "never" });
    expect(relay(panel).disabled).toBe(true);
  });
});
