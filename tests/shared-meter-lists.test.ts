import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/chart/chart-update.js", () => ({ updateChart: vi.fn() }));

import { updateChart } from "../src/chart/chart-update.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ListViewController } from "../src/core/list-view-controller.js";
import { buildExpandedChartHTML } from "../src/core/list-renderer.js";
import { updateCircuitDOM } from "../src/core/dom-updater.js";
import { meterSlots } from "../src/helpers/shared-meters.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";

const mockUpdateChart = vi.mocked(updateChart);
const POWER = { chart_metric: "power" } as CardConfig;
const AMPS = { chart_metric: "current" } as CardConfig;

/** A 15 A and a 10 A circuit on one tandem in space 48, keyed by the first: 25 A of capacity behind one meter. */
function member(slug: string, name: string, rating: number): Circuit {
  return {
    name,
    tabs: [48],
    breaker_rating_a: rating,
    relay_state: "CLOSED",
    shared_meter_group: "t-a",
    entities: { power: `sensor.${slug}_power`, current: `sensor.${slug}_current` },
  };
}

const TANDEM: Record<string, Circuit> = { "t-a": member("lights", "Lights", 15), "t-b": member("outlets", "Outlets", 10) };
const RECORD = { members: ["t-a", "t-b"], breaker_rating_a: 25 };

/** Both members report the one meter's 20 A. */
function hass(): HomeAssistant {
  const states: Record<string, string> = {
    "sensor.lights_power": "2400",
    "sensor.outlets_power": "2400",
    "sensor.lights_current": "20",
    "sensor.outlets_current": "20",
  };
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

/** The By Activity list as the dashboard draws it, with monitoring off. */
function activityList(topology: PanelTopology): HTMLElement {
  const container = document.createElement("div");
  new ListViewController(new DashboardController()).renderActivityView(container, hass(), topology, POWER, null, "");
  return container;
}

function rowUtilization(root: ParentNode, uuid: string): string | null | undefined {
  return root.querySelector(`.list-row[data-row-uuid="${uuid}"] .utilization`)?.textContent;
}

beforeEach(() => mockUpdateChart.mockReset());

describe("a list row of a circuit that shares a meter, with monitoring off", () => {
  it("is judged against the group's capacity, as the grid judges the group", () => {
    // 20 A of the pair's 25 A is 80 %, not 133 % of the first's 15 A or 200 % of the second's 10 A.
    const root = activityList({ circuits: TANDEM, shared_meter_groups: { "t-a": RECORD } } as PanelTopology);
    expect(rowUtilization(root, "t-a")).toBe("80%");
    expect(rowUtilization(root, "t-b")).toBe("80%");
  });

  it("keeps showing its own breaker's rating", () => {
    const root = activityList({ circuits: TANDEM, shared_meter_groups: { "t-a": RECORD } } as PanelTopology);
    expect(root.querySelector('.list-row[data-row-uuid="t-b"] .breaker-badge')?.textContent).toBe("10A");
  });
});

describe("a circuit favorited without the others that share its meter", () => {
  const LONE = { circuits: { "t-b": TANDEM["t-b"]! }, shared_meter_groups: { "t-a": RECORD } } as PanelTopology;

  it("is rated by its group's capacity", () => {
    expect(meterSlots(LONE)[0]!.circuit.breaker_rating_a).toBe(25);
    expect(rowUtilization(activityList(LONE), "t-b")).toBe("80%");
  });

  it("draws its chart's limit at its group's capacity", () => {
    const root = document.createElement("div");
    root.innerHTML = buildExpandedChartHTML("t-b", TANDEM["t-b"]!, hass(), AMPS, null);

    updateCircuitDOM(root, hass(), LONE, AMPS, new Map(), undefined);

    expect(mockUpdateChart).toHaveBeenCalledTimes(1);
    expect(mockUpdateChart.mock.calls[0]![7]).toBe(25);
  });
});

describe("an expanded list row of a circuit that shares a meter", () => {
  const GROUPED = { circuits: TANDEM, shared_meter_groups: { "t-a": RECORD } } as PanelTopology;
  const HISTORY = new Map([
    ["t-a", [{ time: Date.now(), value: 20 }]],
    ["t-b", [{ time: Date.now(), value: 20 }]],
  ]);

  /** The expanded chart slots of `uuids`, as the list draws them below their rows. */
  function expanded(...uuids: string[]): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = uuids.map(uuid => buildExpandedChartHTML(uuid, TANDEM[uuid]!, hass(), AMPS, null)).join("");
    return root;
  }

  function chartOf(root: ParentNode, uuid: string): Element {
    return root.querySelector(`.circuit-slot[data-uuid="${uuid}"] .chart-container`)!;
  }

  it("draws its chart for a member other than the group's key, from its own history, limited at the group's capacity", () => {
    const root = expanded("t-b");

    updateCircuitDOM(root, hass(), GROUPED, AMPS, HISTORY, undefined);

    expect(mockUpdateChart).toHaveBeenCalledTimes(1);
    const [container, , history, , , , , limit] = mockUpdateChart.mock.calls[0]!;
    expect(container).toBe(chartOf(root, "t-b"));
    expect(history).toBe(HISTORY.get("t-b"));
    expect(limit).toBe(25);
  });

  it("draws one chart for every expanded member", () => {
    const root = expanded("t-a", "t-b");

    updateCircuitDOM(root, hass(), GROUPED, AMPS, HISTORY, undefined);

    expect(mockUpdateChart.mock.calls.map(call => call[0])).toEqual([chartOf(root, "t-a"), chartOf(root, "t-b")]);
  });
});
