import { describe, it, expect, vi } from "vitest";
import { DashboardController } from "../src/core/dashboard-controller.js";
import "../src/core/side-panel.js";
import { slotRatingText, type SlotMember } from "../src/helpers/shared-meters.js";
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

describe("the circuit gear's rating subtitle", () => {
  async function ratingTextFor(circuits: Record<string, Record<string, unknown>>, uuid: string): Promise<unknown> {
    const topology = { circuits } as unknown as PanelTopology;
    const ctrl = new DashboardController();
    ctrl.init(topology, {} as CardConfig, hass({}), "entry-1");
    const root = document.createElement("div");
    root.innerHTML = `<button class="gear-icon circuit-gear" data-uuid="${uuid}"></button><span-side-panel></span-side-panel>`;
    document.body.appendChild(root);
    const panel = root.querySelector("span-side-panel") as unknown as { open: (config: unknown) => void };
    const open = vi.spyOn(panel, "open").mockImplementation(() => {});
    await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);
    root.remove();
    // The side panel words its subtitle from the slot the gear hands it.
    return slotRatingText((open.mock.calls[0]![0] as { members: SlotMember[] }).members.map(member => member.circuit));
  }

  const lone = { name: "Hall", tabs: [1], entities: {}, breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true };

  it("is the panel's rating, unmarked, beside a user-set monitoring rating", async () => {
    expect(await ratingTextFor({ hall: lone }, "hall")).toBe("20A");
  });

  it("is the plain rating while the monitoring rating is the panel's", async () => {
    expect(await ratingTextFor({ hall: { ...lone, monitoring_rating_a: 20, monitoring_rating_user_set: false } }, "hall")).toBe("20A");
  });

  it('is empty, never "undefinedA", for a circuit with no rating', async () => {
    expect(await ratingTextFor({ hall: { name: "Hall", tabs: [1], entities: {} } }, "hall")).toBe("");
  });

  it("is the slot's label for circuits that share a meter, as the grid draws it, unmarked", async () => {
    const member = (name: string, rating: number, monitoring: number, userSet: boolean) => ({
      name,
      tabs: [2],
      entities: {},
      shared_meter_group: "a",
      breaker_rating_a: rating,
      monitoring_rating_a: monitoring,
      monitoring_rating_user_set: userSet,
    });
    const circuits = { a: member("A", 15, 15, false), b: member("B", 10, 25, true) };
    expect(await ratingTextFor(circuits, "a")).toBe("15·10 A");
  });
});

describe("the chart limit line on each update", () => {
  const CURRENT = "sensor.kitchen_current";
  const CIRCUIT = {
    name: "Kitchen",
    tabs: [2],
    entities: { power: "sensor.kitchen_power", current: CURRENT },
    breaker_rating_a: 20,
    monitoring_rating_a: 50,
    monitoring_rating_user_set: true,
  };
  const CFG: CardConfig = { chart_metric: "current" };

  /** A hass whose `get_monitoring_status` answers the circuit's monitoring as on or off. */
  function monitoredHass(monitoringEnabled: boolean): HomeAssistant {
    const response = { enabled: true, circuits: { [CURRENT]: { monitoring_enabled: monitoringEnabled, utilization_pct: null } }, mains: {} };
    return { states: {}, services: {}, language: "en", callService: vi.fn(), callWS: vi.fn(async () => ({ response })) } as unknown as HomeAssistant;
  }

  function limitsAfterUpdate(ctrl: DashboardController, topology: PanelTopology): number[] {
    const root = document.createElement("div");
    root.innerHTML = Object.keys(topology.circuits)
      .map(uuid => `<div class="circuit-slot" data-uuid="${uuid}"><div class="chart-container"></div></div>`)
      .join("");
    ctrl.updateDOM(root);
    const chart = root.querySelector(".chart-container span-chart") as unknown as { data: { data: [number, number][] }[] };
    return chart.data.flatMap(series => series.data.map(point => point[1]));
  }

  it.each([
    [true, 50],
    [false, 20],
  ])("reads the panel's monitoring status (monitoring on: %s)", async (monitoringEnabled, rating) => {
    const topology = { circuits: { kitchen: CIRCUIT } } as unknown as PanelTopology;
    const hassObj = monitoredHass(monitoringEnabled);
    const ctrl = new DashboardController();
    ctrl.init(topology, CFG, hassObj, "entry-1");
    await ctrl.monitoringCache.fetch(hassObj, "entry-1");

    expect(limitsAfterUpdate(ctrl, topology)).toContain(rating);
  });

  it("reads the Favorites view's merged monitoring status", async () => {
    const topology = { circuits: { "panel-1|kitchen": CIRCUIT } } as unknown as PanelTopology;
    const hassObj = monitoredHass(true);
    const ctrl = new DashboardController();
    ctrl.init(topology, CFG, hassObj, "entry-1");
    ctrl.setFavoriteRefs({ "panel-1|kitchen": { panelDeviceId: "panel-1", kind: "circuit", targetId: "kitchen", configEntryId: "entry-1" } });
    await ctrl.fetchMergedMonitoringStatus(["entry-1"]);

    expect(limitsAfterUpdate(ctrl, topology)).toContain(50);
  });

  it("forgets the Favorites view's status when it leaves the view, so a later visit starts from none", async () => {
    const topology = { circuits: { "panel-1|kitchen": CIRCUIT } } as unknown as PanelTopology;
    const refs = { "panel-1|kitchen": { panelDeviceId: "panel-1", kind: "circuit" as const, targetId: "kitchen", configEntryId: "entry-1" } };
    const ctrl = new DashboardController();
    ctrl.init(topology, CFG, monitoredHass(true), "entry-1");
    ctrl.setFavoriteRefs(refs);
    await ctrl.fetchMergedMonitoringStatus(["entry-1"]);

    ctrl.clearFavoriteRefs();
    ctrl.setFavoriteRefs(refs);

    expect(ctrl.monitoringStatus).toBeNull();
    expect(limitsAfterUpdate(ctrl, topology)).toContain(20);
  });

  it("reads the panel's rating before any monitoring status is known", () => {
    const topology = { circuits: { kitchen: CIRCUIT } } as unknown as PanelTopology;
    const ctrl = new DashboardController();
    ctrl.init(topology, CFG, monitoredHass(true), "entry-1");

    expect(limitsAfterUpdate(ctrl, topology)).toContain(20);
  });
});
