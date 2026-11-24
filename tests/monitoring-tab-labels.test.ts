import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { discoverTopology } from "../src/card/card-discovery.js";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { setLanguage } from "../src/i18n.js";
import type { HomeAssistant, MonitoringPointInfo, PanelTopology } from "../src/types.js";
import { ErrorStore } from "../src/core/error-store.js";

// From SPAN Panel 2.3.0 each circuit is a child device of its panel, and every
// view labels a circuit by that device's name, the user's rename of it first.
// The monitoring status names each circuit as the SPAN app does, which is ""
// for a circuit with no name there. The Monitoring tab's rows go by the label
// the other views show: the one discovery wrote into the panel's topology.

type Message = Record<string, unknown>;

const PANEL_ID = "panel-device";

/** Each circuit's monitoring entry is keyed by its current sensor, else its power sensor. */
const KITCHEN = "sensor.kitchen_outlets_current";
const UNNAMED = "sensor.circuit_5_current";
const OVEN = "sensor.oven_power";
const FEED = "sensor.span_panel_ev_charger_flex_current";
const SHED = "sensor.old_shed_current";
const NAMELESS = "sensor.nameless_current";
const MAINS = "sensor.span_panel_upstream_l1_current";

/** The topology's circuit records, as the integration sends them: each names its device and carries its name in the SPAN app. */
const RECORDS: Record<string, unknown> = {
  "b-7": { name: "Kitchen Outlets", device_id: "device-b-7", tabs: [7], entities: { current: KITCHEN, power: "sensor.kitchen_outlets_power" } },
  // No name in the SPAN app: the integration names its device by its position.
  "b-5": { name: null, device_id: "device-b-5", tabs: [5], entities: { current: UNNAMED, power: "sensor.circuit_5_power" } },
  // No current sensor, so its monitoring entry goes by its power sensor.
  "b-9": { name: "Oven", device_id: "device-b-9", tabs: [9, 11], entities: { power: OVEN } },
  // A charger's feed circuit with no device of its own keeps its record's name.
  "ev-1": { name: "FLEX⁺", device_id: null, tabs: [30, 32], entities: { current: FEED, power: "sensor.span_panel_ev_charger_flex_power" } },
};

const DEVICES = [
  { id: PANEL_ID, name: "SPAN Panel", name_by_user: null, parent_device_id: null, via_device_id: null },
  // The user renamed the Kitchen Outlets circuit's device in Home Assistant.
  { id: "device-b-7", name: "Kitchen Outlets", name_by_user: "Coffee Bar", parent_device_id: PANEL_ID },
  { id: "device-b-5", name: "Circuit 5", name_by_user: null, parent_device_id: PANEL_ID },
  { id: "device-b-9", name: "Oven", name_by_user: null, parent_device_id: PANEL_ID },
];

const LIMITS = { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 };

function point(name: string): MonitoringPointInfo {
  return { name, monitoring_enabled: true, has_override: false, breaker_rating_a: 20, monitoring_rating_a: 20, ...LIMITS };
}

/** The monitoring status, which names each circuit as the SPAN app does. */
function statusCircuits(): Record<string, MonitoringPointInfo> {
  return {
    [KITCHEN]: point("Kitchen Outlets"),
    [UNNAMED]: point(""),
    [OVEN]: point("Oven"),
    [FEED]: point("FLEX⁺"),
    // Circuits the topology does not hold.
    [SHED]: point("Old Shed"),
    [NAMELESS]: point(""),
  };
}

interface Install {
  hass: HomeAssistant;
  /** Every service call other than the status read, as sent. */
  saves: Message[];
}

/** A converted install: the integration's topology and monitoring status, and Home Assistant's device list. */
function install(): Install {
  const circuits = statusCircuits();
  const saves: Message[] = [];
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    switch (msg.type) {
      case "span_panel/panel_topology":
        return { circuits: structuredClone(RECORDS), panel_size: 32, device_id: PANEL_ID, panel_device_id: PANEL_ID };
      case "config/device_registry/list":
        return DEVICES;
      case "config/area_registry/list":
      case "config/entity_registry/list":
        return [];
      default:
        break;
    }
    if (msg.service === "get_monitoring_status") {
      return { response: { enabled: true, global_settings: LIMITS, circuits: structuredClone(circuits), mains: { [MAINS]: point("Upstream L1") } } };
    }
    const data = (msg.service_data ?? {}) as Message;
    saves.push({ service: msg.service, ...data });
    if (msg.service === "set_circuit_threshold" && typeof data.circuit_id === "string") {
      circuits[data.circuit_id] = { ...circuits[data.circuit_id]!, monitoring_enabled: data.monitoring_enabled === true, has_override: true };
    }
    return {};
  });
  const callService = vi.fn(
    async (domain: string, service: string, data: Message): Promise<unknown> => callWS({ type: "call_service", domain, service, service_data: data })
  );
  // An administrator, who may change monitoring.
  return { hass: { states: {}, services: {}, language: "en", user: { is_admin: true }, callService, callWS } as unknown as HomeAssistant, saves };
}

const mounted: HTMLElement[] = [];
beforeEach(() => setLanguage("en"));
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function mountContainer(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  const container = document.createElement("div");
  host.attachShadow({ mode: "open" }).appendChild(container);
  return container;
}

/** The panel's topology as discovery labels it: each circuit by its device, the user's rename first. */
async function discovered(hass: HomeAssistant): Promise<PanelTopology> {
  const { topology } = await discoverTopology(hass, PANEL_ID);
  if (!topology) throw new Error("no topology discovered");
  return topology;
}

/** The tab drawn with the panel's topology beside it, as the dashboard draws it. */
async function shown(panel: Install): Promise<{ tab: MonitoringTab; container: HTMLElement }> {
  const container = mountContainer();
  const tab = new MonitoringTab(new ErrorStore());
  await tab.render(container, panel.hass, "entry-1", await discovered(panel.hass));
  return { tab, container };
}

/** The name a point's row shows, beside its switch. */
function rowLabel(container: HTMLElement, entity: string): string | null | undefined {
  return container.querySelector(`input[data-entity="${entity}"][type="checkbox"]`)?.closest("label")?.querySelector("span")?.textContent;
}

/** The circuit rows, in the order drawn. */
function rowOrder(container: HTMLElement): (string | undefined)[] {
  return [...container.querySelectorAll<HTMLInputElement>(".circuit-toggle")].map(toggle => toggle.dataset.entity);
}

const field = (container: HTMLElement, entity: string): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(`.threshold-input[data-entity="${entity}"][data-field="spike_threshold_pct"]`)!;

describe("the Monitoring tab's circuit rows", () => {
  it("labels a circuit with no name in the SPAN app by its device's name", async () => {
    const { container } = await shown(install());

    expect(rowLabel(container, UNNAMED)).toBe("Circuit 5");
    expect(field(container, UNNAMED).getAttribute("aria-label")).toBe("Spike (%) for Circuit 5");
  });

  it("labels a circuit by the user's rename of its device", async () => {
    const { container } = await shown(install());

    expect(rowLabel(container, KITCHEN)).toBe("Coffee Bar");
    expect(field(container, KITCHEN).getAttribute("aria-label")).toBe("Spike (%) for Coffee Bar");
  });

  it("labels a circuit whose entry goes by its power sensor, having no current sensor", async () => {
    const panel = install();
    const topology = await discovered(panel.hass);
    topology.circuits["b-9"]!.name = "Range";
    const container = mountContainer();

    await new MonitoringTab(new ErrorStore()).render(container, panel.hass, "entry-1", topology);

    expect(rowLabel(container, OVEN)).toBe("Range");
  });

  it("keeps the record's name for a circuit with no device of its own", async () => {
    const { container } = await shown(install());

    expect(rowLabel(container, FEED)).toBe("FLEX⁺");
  });

  it("orders the rows by the labels they show", async () => {
    const { container } = await shown(install());

    // Circuit 5, Coffee Bar, FLEX⁺, Old Shed, Oven, then the one known only by its entity id.
    expect(rowOrder(container)).toEqual([UNNAMED, KITCHEN, FEED, SHED, OVEN, NAMELESS]);
  });

  it("labels a circuit the topology does not hold by its name in the SPAN app, and by its entity id where it has none", async () => {
    const { container } = await shown(install());

    expect(rowLabel(container, SHED)).toBe("Old Shed");
    expect(rowLabel(container, NAMELESS)).toBe(NAMELESS);
    expect(field(container, NAMELESS).getAttribute("aria-label")).toBe(`Spike (%) for ${NAMELESS}`);
  });

  it("leaves the mains' rows their own names", async () => {
    const { container } = await shown(install());

    expect(rowLabel(container, MAINS)).toBe("Upstream L1");
  });

  it("labels every circuit by its name in the SPAN app where there is no topology to be had", async () => {
    const panel = install();
    const container = mountContainer();

    await new MonitoringTab(new ErrorStore()).render(container, panel.hass, "entry-1", null);

    expect(rowLabel(container, KITCHEN)).toBe("Kitchen Outlets");
    expect(rowLabel(container, UNNAMED)).toBe(UNNAMED);
    expect(rowLabel(container, OVEN)).toBe("Oven");
  });

  it("keeps its labels across a redraw of its own, as after a save", async () => {
    const panel = install();
    const { container } = await shown(panel);
    const toggle = container.querySelector<HTMLInputElement>(`.circuit-toggle[data-entity="${KITCHEN}"]`)!;

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>(`.circuit-toggle[data-entity="${KITCHEN}"]`)).not.toBe(toggle));

    expect(panel.saves).toEqual([{ service: "set_circuit_threshold", circuit_id: KITCHEN, monitoring_enabled: false, config_entry_id: "entry-1" }]);
    expect(rowLabel(container, KITCHEN)).toBe("Coffee Bar");
    expect(rowLabel(container, UNNAMED)).toBe("Circuit 5");
  });

  it("takes the labels of the topology it is drawn with next, as after a rename", async () => {
    const panel = install();
    const { tab, container } = await shown(panel);
    const renamed = await discovered(panel.hass);
    renamed.circuits["b-7"]!.name = "Espresso Corner";

    await tab.render(container, panel.hass, "entry-1", renamed);

    expect(rowLabel(container, KITCHEN)).toBe("Espresso Corner");
  });

  it("never labels another panel's table by the topology it held", async () => {
    const panel = install();
    const { tab, container } = await shown(panel);

    await tab.render(container, panel.hass, "entry-2");

    expect(rowLabel(container, KITCHEN)).toBe("Kitchen Outlets");
  });
});
