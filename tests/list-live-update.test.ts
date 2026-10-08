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

describe("updateCollapsedRows readings and order", () => {
  function circuit(slug: string): Circuit {
    return {
      name: slug,
      tabs: [1],
      entities: { power: `sensor.${slug}_power` },
      is_user_controllable: false,
      relay_state: "CLOSED",
    } as Circuit;
  }

  const CIRCUITS = { a: circuit("a"), b: circuit("b"), c: circuit("c"), d: circuit("d") };
  const ORDERED = { circuits: CIRCUITS } as unknown as PanelTopology;

  function listOf(hass: HomeAssistant, order: string[]): HTMLElement {
    const root = document.createElement("div");
    const cells = order
      .map(
        uuid =>
          `<div class="list-cell" data-cell-uuid="${uuid}">${buildListRowHTML(uuid, CIRCUITS[uuid as keyof typeof CIRCUITS], hass, CONFIG, null, "unknown", false)}</div>`
      )
      .join("");
    root.innerHTML = `<div class="list-view">${cells}</div>`;
    return root;
  }

  function order(root: HTMLElement): string[] {
    return [...root.querySelectorAll<HTMLElement>(".list-cell")].map(cell => cell.dataset.cellUuid!);
  }

  it("puts a circuit with an unknown reading after every measured one, a published zero included", () => {
    const hass = hassWith({ "sensor.a_power": "unknown", "sensor.b_power": "0", "sensor.c_power": "250", "sensor.d_power": "-90" });
    const root = listOf(hass, ["a", "b", "c", "d"]);

    new ListViewController(new DashboardController()).updateCollapsedRows(root, hass, ORDERED, CONFIG);

    expect(order(root)).toEqual(["c", "d", "b", "a"]);
  });

  it("shows a reading that becomes unknown as unknown, never 0 W", () => {
    const root = listOf(hassWith({ "sensor.a_power": "120" }), ["a"]);

    new ListViewController(new DashboardController()).updateCollapsedRows(root, hassWith({ "sensor.a_power": "unavailable" }), ORDERED, CONFIG);

    expect(root.querySelector(".list-power-value")!.textContent!.trim()).toBe("--");
  });
});
