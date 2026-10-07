import { describe, it, expect } from "vitest";
import { buildListRowHTML } from "../src/core/list-renderer.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ListViewController } from "../src/core/list-view-controller.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";

const SWITCH = "switch.kitchen_breaker";
const SELECT = "select.kitchen_circuit_priority";
const POWER = "sensor.kitchen_power";
const KITCHEN = {
  name: "Kitchen",
  tabs: [1],
  entities: { switch: SWITCH, select: SELECT, power: POWER },
  is_user_controllable: true,
  relay_state: "CLOSED",
} as Circuit;
const TOPOLOGY = { circuits: { kitchen: KITCHEN } } as unknown as PanelTopology;
const CONFIG = { chart_metric: "power" } as CardConfig;

function hassWith(states: Record<string, string>): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

function rendered(hass: HomeAssistant, priority: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = buildListRowHTML("kitchen", KITCHEN, hass, CONFIG, null, priority, false);
  return root;
}

function update(root: HTMLElement, hass: HomeAssistant): void {
  new ListViewController(new DashboardController()).updateCollapsedRows(root, hass, TOPOLOGY, CONFIG);
}

describe("updateCollapsedRows", () => {
  it("tracks toggle-unavailable on a list row's pill and keeps showing the relay state", () => {
    const root = rendered(hassWith({ [SWITCH]: "off", [SELECT]: "never" }), "never");
    const pill = root.querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-unavailable")).toBe(false);

    update(root, hassWith({ [SWITCH]: "unavailable", [SELECT]: "never" }));
    expect(pill.classList.contains("toggle-unavailable")).toBe(true);
    expect(pill.classList.contains("toggle-on")).toBe(true);

    update(root, hassWith({ [SWITCH]: "off", [SELECT]: "never" }));
    expect(pill.classList.contains("toggle-unavailable")).toBe(false);
    expect(pill.classList.contains("toggle-off")).toBe(true);
  });

  it("shows a list row's shedding marker once the priority is known, and hides it again", () => {
    const root = rendered(hassWith({ [SWITCH]: "on", [SELECT]: "unavailable" }), "unknown");
    const marker = root.querySelector<HTMLElement>(".shedding-composite")!;
    expect(marker.style.display).toBe("none");

    update(root, hassWith({ [SWITCH]: "on", [SELECT]: "never" }));
    expect(marker.style.display).toBe("");
    expect(root.querySelector(".shedding-icon")!.getAttribute("icon")).toBe("mdi:battery");

    update(root, hassWith({ [SWITCH]: "on", [SELECT]: "unknown" }));
    expect(marker.style.display).toBe("none");
  });
});
