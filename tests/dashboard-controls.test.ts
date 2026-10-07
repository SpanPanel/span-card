import { describe, it, expect, vi } from "vitest";
import { DashboardController } from "../src/core/dashboard-controller.js";
import "../src/core/side-panel.js";
import type { CardConfig, HomeAssistant, PanelTopology } from "../src/types.js";

const SWITCH = "switch.kitchen_breaker";

function hass(states: Record<string, string>, callService = vi.fn(async () => undefined)): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en", callService, callWS: async () => ({}) } as unknown as HomeAssistant;
}

const TOPOLOGY = {
  circuits: {
    kitchen: {
      name: "Kitchen",
      tabs: [2],
      entities: { switch: SWITCH, power: "sensor.kitchen_power" },
      is_user_controllable: true,
      relay_state: "OPEN",
      priority: "OFF_GRID",
      device_type: "circuit",
    },
  },
} as unknown as PanelTopology;

function clickToggle(states: Record<string, string>): ReturnType<typeof vi.fn> {
  const callService = vi.fn(async () => undefined);
  const ctrl = new DashboardController();
  ctrl.init(TOPOLOGY, {} as CardConfig, hass(states, callService), "entry-1");
  const root = document.createElement("div");
  root.innerHTML = `<div class="slide-confirm confirmed"></div><div data-uuid="kitchen"><div class="toggle-pill"></div></div>`;
  const pill = root.querySelector(".toggle-pill")!;
  ctrl.onToggleClick({ target: pill, stopPropagation() {}, preventDefault() {} } as unknown as Event, root);
  return callService;
}

describe("the breaker toggle", () => {
  it("operates an operable switch", () => {
    expect(clickToggle({ [SWITCH]: "on" })).toHaveBeenCalledWith("switch", "turn_off", {}, { entity_id: SWITCH });
  });

  it("sends nothing to an unavailable switch", () => {
    expect(clickToggle({ [SWITCH]: "unavailable" })).not.toHaveBeenCalled();
  });

  it("sends nothing for a guessed switch that has no state", () => {
    expect(clickToggle({})).not.toHaveBeenCalled();
  });
});

describe("the circuit gear", () => {
  it("hands the side panel the circuit's relay state, priority and device type", async () => {
    const ctrl = new DashboardController();
    ctrl.init(TOPOLOGY, {} as CardConfig, hass({ [SWITCH]: "unavailable" }), "entry-1");
    const root = document.createElement("div");
    root.innerHTML = `<button class="gear-icon circuit-gear" data-uuid="kitchen"></button><span-side-panel></span-side-panel>`;
    document.body.appendChild(root);
    const panel = root.querySelector("span-side-panel") as unknown as { open: (config: unknown) => void };
    const open = vi.spyOn(panel, "open").mockImplementation(() => {});

    await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);

    expect(open).toHaveBeenCalledWith(expect.objectContaining({ uuid: "kitchen", relay_state: "OPEN", priority: "OFF_GRID", device_type: "circuit" }));
    root.remove();
  });
});
