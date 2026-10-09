import { describe, it, expect, vi, afterEach } from "vitest";
import { buildGridHTML } from "../src/core/grid-renderer.js";
import { buildMetersStripHTML, updateMetersDOM } from "../src/core/meters-strip.js";
import { buildPanelStatsHTML } from "../src/core/header-renderer.js";
import { updateCircuitDOM } from "../src/core/dom-updater.js";
import { buildExpandedChartHTML, buildListRowHTML } from "../src/core/list-renderer.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ListViewController } from "../src/core/list-view-controller.js";
import { positionRange } from "../src/helpers/layout.js";
import "../src/card/span-panel-card.js";
import { FakeConnection, hassWith as hassOn } from "./fake-connection.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";

const CONFIG = { chart_metric: "power" } as CardConfig;

/** A meter outside the panel, as topology reports one: no breaker space, no switch, no select, no rating. */
function meter(slug: string, name: string | null = "Meter A"): Circuit {
  return {
    name,
    tabs: [],
    outside_panel: true,
    entities: {
      power: `sensor.${slug}_power`,
      consumed_energy: `sensor.${slug}_consumed_energy`,
      produced_energy: `sensor.${slug}_produced_energy`,
      current: `sensor.${slug}_current`,
    },
    is_user_controllable: false,
    breaker_rating_a: null,
    relay_state: "UNKNOWN",
  } as unknown as Circuit;
}

function hosted(slug: string, tab: number, relay = "CLOSED"): Circuit {
  return { name: slug, tabs: [tab], outside_panel: false, entities: { power: `sensor.${slug}_power` }, relay_state: relay } as Circuit;
}

function topologyOf(circuits: Record<string, Circuit>): PanelTopology {
  return { circuits, panel_size: 32 } as PanelTopology;
}

type States = Record<string, string | { state: string; attributes: Record<string, unknown> }>;

function hassWith(states: States): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, s]) => {
      const { state, attributes } = typeof s === "string" ? { state: s, attributes: {} } : s;
      return [entity_id, { entity_id, state, attributes, last_changed: "", last_updated: "" }];
    })
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

function wh(state: string): { state: string; attributes: Record<string, unknown> } {
  return { state, attributes: { unit_of_measurement: "Wh" } };
}

function strip(topology: PanelTopology, hass: HomeAssistant): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = buildMetersStripHTML(topology, hass);
  return div;
}

function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const IMPORTING = hassWith({
  "sensor.meter_a_power": "850",
  "sensor.meter_a_consumed_energy": wh("52340"),
  "sensor.meter_a_produced_energy": wh("812"),
});

describe("a meter outside the panel on the grid", () => {
  it("is never a grid slot", () => {
    const topology = topologyOf({ kitchen: hosted("kitchen", 1), "meter-a": meter("meter_a") });
    const div = document.createElement("div");
    div.innerHTML = buildGridHTML(topology, positionRange(topology, 32)!, IMPORTING, CONFIG, null);
    expect(div.querySelector('[data-uuid="kitchen"]')).not.toBeNull();
    expect(div.querySelector('[data-uuid="meter-a"]')).toBeNull();
  });

  it("is never a grid slot, even when it names a tab", () => {
    const topology = topologyOf({ "meter-a": { ...meter("meter_a"), tabs: [3] } });
    const div = document.createElement("div");
    div.innerHTML = buildGridHTML(topology, { first: 1, last: 32 }, IMPORTING, CONFIG, null);
    expect(div.querySelector('[data-uuid="meter-a"]')).toBeNull();
  });
});

describe("the Meters strip", () => {
  it("draws nothing when no meter is outside the panel", () => {
    expect(buildMetersStripHTML(topologyOf({ kitchen: hosted("kitchen", 1) }), IMPORTING)).toBe("");
  });

  it("shows each meter's name, power with its direction, and energy", () => {
    const el = strip(topologyOf({ kitchen: hosted("kitchen", 1), "meter-a": meter("meter_a") }), IMPORTING);
    expect(text(el.querySelector(".meters-title"))).toBe("Meters");
    const tiles = el.querySelectorAll(".meter-tile");
    expect(tiles).toHaveLength(1);
    const tile = tiles[0]!;
    expect(tile.getAttribute("data-meter-uuid")).toBe("meter-a");
    expect(text(tile.querySelector(".meter-name"))).toBe("Meter A");
    expect(text(tile.querySelector(".meter-power"))).toBe("850W");
    expect(text(tile.querySelector(".meter-direction"))).toBe("importing");
    expect(text(tile.querySelector(".meter-imported"))).toBe("52.3 kWh imported");
    expect(text(tile.querySelector(".meter-exported"))).toBe("0.8 kWh exported");
  });

  it("keeps the import-positive sign: negative power is exporting", () => {
    const el = strip(topologyOf({ "meter-a": meter("meter_a") }), hassWith({ "sensor.meter_a_power": "-340" }));
    expect(text(el.querySelector(".meter-power"))).toBe("-340W");
    expect(text(el.querySelector(".meter-direction"))).toBe("exporting");
  });

  it("states no direction at zero", () => {
    const el = strip(topologyOf({ "meter-a": meter("meter_a") }), hassWith({ "sensor.meter_a_power": "0" }));
    expect(text(el.querySelector(".meter-power"))).toBe("0W");
    expect(text(el.querySelector(".meter-direction"))).toBe("");
  });

  it("reads unknown power and energy as unknown, never 0, with no direction", () => {
    const el = strip(
      topologyOf({ "meter-a": meter("meter_a") }),
      hassWith({ "sensor.meter_a_power": "unknown", "sensor.meter_a_consumed_energy": "unavailable" })
    );
    expect(text(el.querySelector(".meter-power"))).toBe("--");
    expect(text(el.querySelector(".meter-direction"))).toBe("");
    expect(text(el.querySelector(".meter-imported"))).toBe("-- imported");
    expect(text(el.querySelector(".meter-exported"))).toBe("-- exported");
  });

  it("shows energy reported in kWh as it is", () => {
    const hass = hassWith({ "sensor.meter_a_consumed_energy": { state: "52.34", attributes: { unit_of_measurement: "kWh" } } });
    expect(text(strip(topologyOf({ "meter-a": meter("meter_a") }), hass).querySelector(".meter-imported"))).toBe("52.3 kWh imported");
  });

  it("draws no toggle pill, no breaker rating and no gear", () => {
    const el = strip(topologyOf({ "meter-a": meter("meter_a") }), IMPORTING);
    expect(el.querySelector(".toggle-pill")).toBeNull();
    expect(el.querySelector(".breaker-badge")).toBeNull();
    expect(el.querySelector(".gear-icon")).toBeNull();
  });

  it("falls back to the unknown label for a meter with no name", () => {
    expect(text(strip(topologyOf({ "meter-a": meter("meter_a", null) }), IMPORTING).querySelector(".meter-name"))).toBe("Unknown");
  });

  it("escapes a meter's name and id", () => {
    const el = strip(topologyOf({ 'm"x': meter("meter_a", "<b>bold</b>") }), IMPORTING);
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector(".meter-tile")!.getAttribute("data-meter-uuid")).toBe('m"x');
  });

  it("updates its readings in place", () => {
    const topology = topologyOf({ "meter-a": meter("meter_a") });
    const el = strip(topology, IMPORTING);
    const tile = el.querySelector(".meter-tile");

    updateMetersDOM(el, hassWith({ "sensor.meter_a_power": "-75", "sensor.meter_a_produced_energy": wh("900") }), topology);

    expect(el.querySelector(".meter-tile")).toBe(tile);
    expect(text(el.querySelector(".meter-power"))).toBe("-75W");
    expect(text(el.querySelector(".meter-direction"))).toBe("exporting");
    expect(text(el.querySelector(".meter-imported"))).toBe("-- imported");
    expect(text(el.querySelector(".meter-exported"))).toBe("0.9 kWh exported");
  });
});

describe("the fallback site sum", () => {
  it("leaves out a meter outside the panel, measured or not", () => {
    // The site sensor has no state, so the Site stat falls back to the circuits' sum.
    const topology = { ...topologyOf({ kitchen: hosted("kitchen", 1), "meter-a": meter("meter_a") }), panel_entities: { site_power: "sensor.site_power" } };
    for (const meterPower of ["850", "unknown"]) {
      const hass = hassWith({ "sensor.kitchen_power": "300", "sensor.meter_a_power": meterPower });
      const root = document.createElement("div");
      root.innerHTML = buildPanelStatsHTML(topology, CONFIG);

      updateCircuitDOM(root, hass, topology, CONFIG, new Map(), undefined);

      const consumption = root.querySelector(".stat-consumption .stat-value")!;
      expect(consumption.textContent).toBe("0.3");
      expect(consumption.classList.contains("stat-partial")).toBe(false);
    }
  });
});

describe("a meter outside the panel in the list views", () => {
  const CIRCUITS = { on: hosted("on", 1), off: hosted("off", 2, "OPEN"), "meter-a": meter("meter_a") };
  const TOPOLOGY = topologyOf(CIRCUITS);

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

  const HASS = hassWith({ "sensor.on_power": "30", "sensor.off_power": "0", "sensor.meter_a_power": "50" });

  it("is never sorted as off: it sorts by its reading among the circuits that are on", () => {
    const root = listOf(HASS, ["off", "meter-a", "on"]);
    new ListViewController(new DashboardController()).updateCollapsedRows(root, HASS, TOPOLOGY, CONFIG);
    // Sorted as off, it would follow the circuit that is on, whatever its reading.
    expect(order(root)).toEqual(["meter-a", "on", "off"]);
  });

  it("is drawn with its reading, never as off, and with no on/off control", () => {
    const root = listOf(HASS, ["meter-a"]);
    const row = root.querySelector(".list-row")!;
    expect(row.classList.contains("circuit-off")).toBe(false);
    expect(row.querySelector(".toggle-pill")).toBeNull();
    expect(row.querySelector(".list-status-badge")).toBeNull();
    expect(text(row.querySelector(".list-power-value"))).toBe("50W");

    new ListViewController(new DashboardController()).updateCollapsedRows(root, HASS, TOPOLOGY, CONFIG);
    expect(row.classList.contains("circuit-off")).toBe(false);
    expect(text(row.querySelector(".list-power-value"))).toBe("50W");
  });

  it("keeps its expanded chart undimmed through a live update", () => {
    const root = document.createElement("div");
    root.innerHTML = buildExpandedChartHTML("meter-a", CIRCUITS["meter-a"], HASS, CONFIG, null);
    for (const chart of root.querySelectorAll(".chart-container")) chart.remove();
    const slot = root.querySelector(".circuit-slot")!;
    expect(slot.classList.contains("circuit-off")).toBe(false);

    updateCircuitDOM(root, HASS, TOPOLOGY, CONFIG, new Map(), undefined);

    expect(slot.classList.contains("circuit-off")).toBe(false);
  });
});

describe("the card", () => {
  const mounted: HTMLElement[] = [];
  afterEach(() => {
    for (const el of mounted.splice(0)) el.remove();
  });

  it("draws the Meters strip above the grid and keeps it current", async () => {
    const topology = { circuits: { kitchen: hosted("kitchen", 1), "meter-a": meter("meter_a") }, panel_size: 32 };
    const states = (power: string) =>
      Object.fromEntries(
        Object.entries({ "sensor.kitchen_power": "300", "sensor.meter_a_power": power }).map(([entity_id, state]) => [
          entity_id,
          { entity_id, state, attributes: {}, last_changed: "", last_updated: "" },
        ])
      );
    const connection = new FakeConnection();
    const callWS = (async (msg: Record<string, unknown>) => (msg.type === "span_panel/panel_topology" ? topology : [])) as HomeAssistant["callWS"];
    const card = document.createElement("span-panel-card") as HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };
    card.setConfig({ device_id: "panel-1" });
    document.body.appendChild(card);
    mounted.push(card);
    card.hass = hassOn(connection, { callWS, states: states("850") });

    await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".meters-strip")).not.toBeNull());
    const content = card.shadowRoot!.querySelector("#card-content")!;
    const children = [...content.children];
    const stripIndex = children.findIndex(el => el.classList.contains("meters-strip"));
    const gridIndex = children.findIndex(el => el.classList.contains("panel-grid"));
    expect(stripIndex).toBeGreaterThanOrEqual(0);
    expect(stripIndex).toBeLessThan(gridIndex);
    expect(content.querySelector('.panel-grid [data-uuid="meter-a"]')).toBeNull();

    card.hass = hassOn(connection, { callWS, states: states("-60") });
    await vi.waitFor(() => expect(text(content.querySelector(".meter-direction"))).toBe("exporting"));
    expect(text(content.querySelector(".meter-power"))).toBe("-60W");
  });
});
