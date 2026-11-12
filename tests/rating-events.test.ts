import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Storage } from "happy-dom";
import type { CardConfig, Circuit, HomeAssistant, PanelDevice, PanelTopology } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
  discoverEntitiesFallback: vi.fn(),
}));

import { discoverEntitiesFallback, discoverTopology } from "../src/card/card-discovery.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { FavoritesController } from "../src/core/favorites-controller.js";
import { PACKAGE_RATINGS_CHANGED, subscribePackageRatingChanges } from "../src/core/rating-events.js";
import { ErrorStore } from "../src/core/error-store.js";
import { DashboardTab } from "../src/panel/tab-dashboard.js";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import "../src/core/side-panel.js";
import "../src/card/span-panel-card.js";
import "../src/panel/span-panel.js";
import { FakeConnection, flush, hassWith } from "./fake-connection.js";

const mockDiscover = vi.mocked(discoverTopology);
const mockFallback = vi.mocked(discoverEntitiesFallback);

function ratingEvent(entryId: string, circuitIds: string[] = ["c-1"]): unknown {
  return { event_type: PACKAGE_RATINGS_CHANGED, data: { config_entry_id: entryId, circuit_ids: circuitIds } };
}

describe("subscribePackageRatingChanges", () => {
  it("listens for the integration's package ratings event", async () => {
    const connection = new FakeConnection();
    await subscribePackageRatingChanges(hassWith(connection), "entry-1", vi.fn());

    expect(PACKAGE_RATINGS_CHANGED).toBe("span_panel_package_ratings_changed");
    expect(connection.live("span_panel_package_ratings_changed")).toBe(1);
  });

  it("calls back for an event on its own entry", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    await subscribePackageRatingChanges(hassWith(connection), "entry-1", onChange);

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("hands the callback the circuits the event names", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    await subscribePackageRatingChanges(hassWith(connection), "entry-1", onChange);

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1", ["c-1", "c-2"]));

    expect(onChange).toHaveBeenCalledWith(new Set(["c-1", "c-2"]));
  });

  it.each([[{}], [{ circuit_ids: "c-1" }], [{ circuit_ids: [1] }]])("hands it null, any circuit, for an event that names none %j", async extra => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    await subscribePackageRatingChanges(hassWith(connection), "entry-1", onChange);

    connection.emit(PACKAGE_RATINGS_CHANGED, { event_type: PACKAGE_RATINGS_CHANGED, data: { config_entry_id: "entry-1", ...extra } });

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("ignores an event for another entry, even for the same circuit id", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    await subscribePackageRatingChanges(hassWith(connection), "entry-1", onChange);

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-2", ["c-1"]));

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], ["entry-1"], [{}], [{ data: null }], [{ data: {} }], [{ data: { config_entry_id: 1 } }]])(
    "ignores a malformed event %j",
    async event => {
      const connection = new FakeConnection();
      const onChange = vi.fn();
      await subscribePackageRatingChanges(hassWith(connection), "entry-1", onChange);

      connection.emit(PACKAGE_RATINGS_CHANGED, event);

      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it("stops calling back once unsubscribed", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    const unsubscribe = await subscribePackageRatingChanges(hassWith(connection), "entry-1", onChange);
    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(1);

    unsubscribe();

    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(0);
    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("subscribes to nothing, and returns a no-op, without a connection", async () => {
    const hass = { states: {}, services: {}, language: "en" } as unknown as HomeAssistant;
    const unsubscribe = await subscribePackageRatingChanges(hass, "entry-1", vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});

// ── An open circuit side panel ────────────────────────────────────────────

type SidePanel = HTMLElement & {
  hass: HomeAssistant;
  errorStore: ErrorStore | null;
  open(config: unknown): void;
  readonly openCircuit: { uuid: string; configEntryId: string | null } | null;
};

const ENTRY = "entry-1";

/** The Oven as the topology describes it; a user-set rating is a tandem copied from the SPAN app, the panel's rating first. */
function circuit(panel: number | null, monitoring: number | null, userSet = false): Circuit {
  return {
    name: "Oven",
    tabs: [1],
    entities: { power: "sensor.oven_power" },
    voltage: 240,
    breaker_rating_a: panel,
    monitoring_rating_a: monitoring,
    monitoring_rating_user_set: userSet,
    package_ratings_a: userSet && panel !== null && monitoring !== null ? [panel, monitoring - panel] : null,
  };
}

function topologyOf(c: Circuit, entryId = ENTRY): PanelTopology {
  return {
    circuits: { "c-1": c },
    panel_size: 32,
    panel_device_id: "panel-1",
    config_entry_id: entryId,
    monitoring_rating_offered: true,
  } as unknown as PanelTopology;
}

/** A `get_monitoring_status` answer with the circuit monitored, keyed as the integration keys it: its current sensor, else its power sensor. */
function monitoringFor(c: Circuit): Record<string, unknown> {
  return {
    response: {
      enabled: true,
      circuits: {
        [c.entities.current ?? c.entities.power!]: {
          name: "Oven",
          breaker_rating_a: c.breaker_rating_a,
          monitoring_rating_a: c.monitoring_rating_a,
          monitoring_rating_user_set: c.monitoring_rating_user_set,
          package_ratings_a: c.package_ratings_a,
          monitoring_enabled: true,
        },
      },
    },
  };
}

interface OpenPanel {
  root: HTMLElement;
  panel: SidePanel;
  ctrl: DashboardController;
  callWS: ReturnType<typeof vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>>;
  setStatus(c: Circuit): void;
}

const mounted: HTMLElement[] = [];

/** Opens the dashboard's circuit panel on the Oven, through the controller, as a gear click does. */
async function openOven(initial: Circuit): Promise<OpenPanel> {
  let status: Record<string, unknown> = monitoringFor(initial);
  const callWS = vi.fn(async (msg: Record<string, unknown>) => {
    if (msg.service === "get_monitoring_status") return status;
    if (msg.service === "get_graph_settings") return { response: {} };
    return {};
  });
  const hass = { states: {}, services: {}, language: "en", callService: async () => undefined, callWS } as unknown as HomeAssistant;
  const root = document.createElement("div");
  root.innerHTML = `<div class="gear-icon" data-uuid="c-1"></div><span-side-panel></span-side-panel>`;
  document.body.appendChild(root);
  mounted.push(root);
  const panel = root.querySelector("span-side-panel") as SidePanel;
  const ctrl = new DashboardController();
  ctrl.showMonitoring = true;
  ctrl.init(topologyOf(initial), {} as CardConfig, hass, ENTRY);
  await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);
  return { root, panel, ctrl, callWS, setStatus: c => (status = monitoringFor(c)) };
}

const section = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-section"]');
const input = (p: SidePanel): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>('[data-role="rating-input"]')!;
const judged = (p: SidePanel): string | undefined => p.shadowRoot!.querySelector('[data-role="judged-against"]')?.textContent ?? undefined;
const reset = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-reset"]');

describe("the Monitoring section's judged-against line", () => {
  it("names the rating the point is judged against, with a copied package named beside the panel's rating", async () => {
    expect(judged((await openOven(circuit(30, 30))).panel)).toBe("Judged against: 30 A");
    expect(judged((await openOven(circuit(20, 50, true))).panel)).toBe("Judged against 50 A: 20-30 from your SPAN app (the panel publishes 20 A)");
  });

  it("says there is no rating when the point has none", async () => {
    expect(judged((await openOven(circuit(null, null))).panel)).toBe("Judged against: no rating");
  });
});

describe("refreshCircuitSidePanel", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.useRealTimers();
    for (const el of mounted.splice(0)) el.remove();
  });

  it("patches the package ratings editor in place from the integration's answer, its unfocused field showing the copy", async () => {
    const open = await openOven(circuit(20, 20));
    expect(reset(open.panel)).toBeNull();
    input(open.panel).value = "45";
    const before = section(open.panel);

    const after = circuit(20, 50, true);
    open.setStatus(after);
    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after));

    expect(section(open.panel)).toBe(before);
    expect(input(open.panel).value).toBe("30");
    expect(reset(open.panel)).not.toBeNull();
    expect(open.panel.shadowRoot!.querySelector('[data-role="rating-panel-rating"]')!.textContent).toContain("20");
    expect(judged(open.panel)).toBe("Judged against 50 A: 20-30 from your SPAN app (the panel publishes 20 A)");
    // The subtitle is the panel's rating, which a monitoring rating does not change.
    expect(open.panel.shadowRoot!.querySelector(".subtitle")!.textContent).toBe("20A \u00b7 240V \u00b7 Tabs [1]");
  });

  it("drops the reset button when a clear returns the circuit to the panel's rating", async () => {
    const open = await openOven(circuit(20, 50, true));
    expect(reset(open.panel)).not.toBeNull();

    const after = circuit(20, 20);
    open.setStatus(after);
    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after));

    expect(reset(open.panel)).toBeNull();
    expect(input(open.panel).value).toBe("");
  });

  it("keeps a value being typed in the focused field across a refresh, and sends it when committed", async () => {
    const open = await openOven(circuit(20, 20));
    const sent = vi.spyOn(open.panel as unknown as { _callDomainService: (s: string, d: Record<string, unknown>) => Promise<unknown> }, "_callDomainService");
    const field = input(open.panel);
    field.focus();
    field.value = "3";
    field.dispatchEvent(new Event("input"));

    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(circuit(20, 20)));
    vi.advanceTimersByTime(1000);
    field.value = "30";
    field.dispatchEvent(new Event("input"));

    expect(input(open.panel)).toBe(field);
    expect(field.value).toBe("30");
    expect(sent).not.toHaveBeenCalled();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(sent).toHaveBeenCalledWith("set_circuit_package_ratings", expect.objectContaining({ package_ratings_a: [20, 30] }));
  });

  it("keeps the editor where it was: after the judged-against line, above the Global/Custom choice", async () => {
    const open = await openOven(circuit(20, 20));

    const after = circuit(20, 50, true);
    open.setStatus(after);
    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after));

    const editor = section(open.panel)!;
    expect(editor.previousElementSibling?.getAttribute("data-role")).toBe("judged-against");
    expect(editor.nextElementSibling?.classList.contains("radio-group")).toBe(true);
  });

  it("keeps a threshold value being typed, and still sends it, across a rebuild", async () => {
    const open = await openOven(circuit(20, 20));
    const sent = vi.spyOn(open.panel as unknown as { _callDomainService: (s: string, d: Record<string, unknown>) => Promise<unknown> }, "_callDomainService");
    const threshold = (): HTMLInputElement => open.panel.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;
    const typing = threshold();
    typing.value = "65";
    typing.dispatchEvent(new Event("input"));

    const after = circuit(20, 50, true);
    open.setStatus(after);
    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after));
    vi.advanceTimersByTime(1000);

    expect(threshold()).toBe(typing);
    expect(threshold().value).toBe("65");
    expect(sent).toHaveBeenCalledWith("set_circuit_threshold", expect.objectContaining({ continuous_threshold_pct: 65 }));
  });

  it("adds the editor, in its place, when a circuit first has a panel rating to judge against", async () => {
    const open = await openOven(circuit(null, null));
    expect(section(open.panel)).toBeNull();

    const after = circuit(20, 20);
    open.setStatus(after);
    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after));

    const editor = section(open.panel)!;
    expect(editor).not.toBeNull();
    expect(input(open.panel).value).toBe("");
    expect(editor.previousElementSibling?.getAttribute("data-role")).toBe("judged-against");
    expect(editor.nextElementSibling?.classList.contains("radio-group")).toBe(true);
  });

  it("hands the open panel the global thresholds of the status it re-reads", async () => {
    const open = await openOven(circuit(20, 20));
    const globals = { continuous_threshold_pct: 150, spike_threshold_pct: 200 };
    open.callWS.mockImplementation(async (msg: Record<string, unknown>) =>
      msg.service === "get_monitoring_status" ? { response: { ...(monitoringFor(circuit(20, 20)).response as object), global_settings: globals } } : {}
    );

    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(circuit(20, 20)));

    expect((open.panel as unknown as { ratingsState: { monitoringGlobals: unknown } }).ratingsState.monitoringGlobals).toEqual(globals);
  });

  it("applies nothing when the panel is reopened on another circuit while the status is fetched", async () => {
    const open = await openOven(circuit(20, 20));
    let release: () => void = () => {};
    const answered = monitoringFor(circuit(20, 50, true));
    open.callWS.mockImplementation(
      (msg: Record<string, unknown>) =>
        new Promise(resolve => {
          if (msg.service === "get_monitoring_status") release = () => resolve(answered);
          else resolve({});
        })
    );
    const refreshed = vi.spyOn(open.panel as unknown as { refreshRating: (view: unknown) => void }, "refreshRating");

    const refresh = open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(circuit(20, 50, true)));
    open.panel.open({
      uuid: "c-2",
      name: "Dryer",
      entities: {},
      showMonitoring: true,
      monitoringRatingOffered: true,
      monitoringInfo: { monitoring_enabled: true },
      graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
      members: [{ uuid: "c-2", circuit: { ...circuit(30, 30), name: "Dryer" } }],
      capacityA: null,
      configEntryId: ENTRY,
    });
    release();
    await refresh;

    expect(refreshed).not.toHaveBeenCalled();
    expect(open.panel.openCircuit?.uuid).toBe("c-2");
  });

  it("leaves the open panel alone for an event that names other circuits only", async () => {
    const open = await openOven(circuit(20, 20));
    const before = section(open.panel);
    open.callWS.mockClear();

    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(circuit(20, 50, true)), new Set(["c-9"]));

    expect(section(open.panel)).toBe(before);
    expect(judged(open.panel)).toBe("Judged against: 20 A");
    expect(open.callWS).not.toHaveBeenCalled();
  });

  it("redraws the open panel for an event that names its circuit", async () => {
    const open = await openOven(circuit(20, 20));
    const after = circuit(20, 50, true);
    open.setStatus(after);

    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after), new Set(["c-9", "c-1"]));

    expect(judged(open.panel)).toBe("Judged against 50 A: 20-30 from your SPAN app (the panel publishes 20 A)");
  });

  it("leaves a panel open for another entry alone", async () => {
    const open = await openOven(circuit(20, 20));
    const before = section(open.panel);

    await open.ctrl.refreshCircuitSidePanel(open.root, "entry-2", topologyOf(circuit(20, 50, true), "entry-2"));

    expect(section(open.panel)).toBe(before);
    expect(judged(open.panel)).toBe("Judged against: 20 A");
  });

  it("does nothing when no circuit panel is open", async () => {
    const open = await openOven(circuit(20, 20));
    open.panel.close();
    open.callWS.mockClear();

    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(circuit(20, 50, true)));

    expect(open.callWS).not.toHaveBeenCalled();
  });
});

// ── The monitoring tab ────────────────────────────────────────────────────

describe("the Monitoring tab's rating cell", () => {
  async function render(status: Record<string, unknown>): Promise<HTMLElement> {
    const hass = {
      states: {},
      services: {},
      language: "en",
      callService: async () => undefined,
      callWS: async () => ({ response: { enabled: true, ...status } }),
    } as unknown as HomeAssistant;
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted.push(container);
    await new MonitoringTab().render(container, hass, ENTRY);
    return container;
  }

  const cells = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>(".rating-cell")];

  it("heads the column and shows a rating per row", async () => {
    const container = await render({
      circuits: { "sensor.a": { name: "Oven", breaker_rating_a: 30, monitoring_rating_a: 30, monitoring_rating_user_set: false } },
      mains: { "sensor.m": { name: "Mains L1", breaker_rating_a: 200, monitoring_rating_a: 200, monitoring_rating_user_set: false } },
    });

    expect(container.querySelector("thead")!.textContent).toContain("Rating");
    expect(cells(container).map(c => c.textContent)).toEqual(["200A", "30A"]);
  });

  it("marks a copied package, naming it and the panel's rating as the side panel does, and leaves the mains unmarked", async () => {
    const container = await render({
      circuits: {
        "sensor.a": { name: "Oven", breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true, package_ratings_a: [20, 30] },
      },
      mains: { "sensor.m": { name: "Mains L1", breaker_rating_a: 200, monitoring_rating_a: 150, monitoring_rating_user_set: true } },
    });
    const [mains, oven] = cells(container);

    expect(oven!.querySelector(".rating-user-set")!.getAttribute("title")).toBe("20-30 from your SPAN app (the panel publishes 20 A)");
    expect(oven!.textContent).toContain("50A");
    expect(mains!.textContent).toBe("150A");
    expect(mains!.querySelector(".rating-user-set")).toBeNull();
  });

  it("gives the mark an accessible name and shows what it says on a tap, as on a touch screen", async () => {
    const container = await render({
      circuits: {
        "sensor.a": { name: "Oven", breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true, package_ratings_a: [20, 30] },
      },
    });
    const mark = container.querySelector<HTMLButtonElement>(".rating-user-set")!;
    const note = container.querySelector<HTMLElement>(".rating-copied-note")!;
    expect(mark.tagName).toBe("BUTTON");
    expect(mark.getAttribute("aria-label")).toBe("20-30 from your SPAN app (the panel publishes 20 A)");
    expect(note.hidden).toBe(true);

    mark.click();
    expect(note.hidden).toBe(false);
    expect(mark.getAttribute("aria-expanded")).toBe("true");

    mark.click();
    expect(note.hidden).toBe(true);
    expect(mark.getAttribute("aria-expanded")).toBe("false");
  });

  it("says there is no rating for a point with none", async () => {
    const container = await render({ circuits: { "sensor.a": { name: "Meter", breaker_rating_a: null, monitoring_rating_a: null } } });

    expect(cells(container).map(c => c.textContent)).toEqual(["no rating"]);
  });

  it("escapes a hostile point name beside the new cell", async () => {
    const container = await render({ circuits: { "sensor.a": { name: "<img src=x>", breaker_rating_a: 15, monitoring_rating_a: 15 } } });

    expect(container.querySelector("img")).toBeNull();
    expect(cells(container)).toHaveLength(1);
  });
});

// ── The standalone card ───────────────────────────────────────────────────

type Card = HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };

function cardTopology(c: Circuit): PanelTopology {
  return {
    circuits: { oven: { ...c, is_user_controllable: true, relay_state: "CLOSED" } },
    panel_size: 32,
    panel_device_id: "panel-1",
    config_entry_id: ENTRY,
  } as unknown as PanelTopology;
}

describe("the standalone card", () => {
  let monitoringCalls = 0;
  /** What `get_monitoring_status` answers for the Oven; null answers nothing. */
  let cardStatus: Circuit | null = null;

  function hassFor(connection: FakeConnection, states: HomeAssistant["states"] = {}): HomeAssistant {
    return hassWith(connection, {
      states,
      callWS: (async (msg: Record<string, unknown>) => {
        if (msg.service === "get_monitoring_status") {
          monitoringCalls += 1;
          if (cardStatus) return monitoringFor(cardStatus);
        }
        if (msg.type === "config/device_registry/list") return [];
        return {};
      }) as HomeAssistant["callWS"],
    });
  }

  async function mount(connection: FakeConnection, states: HomeAssistant["states"] = {}): Promise<Card> {
    const card = document.createElement("span-panel-card") as Card;
    card.setConfig({ device_id: "panel-1" } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);
    card.hass = hassFor(connection, states);
    await vi.waitFor(() => expect(connection.subscriptions.length).toBeGreaterThan(0));
    await flush();
    return card;
  }

  beforeEach(() => {
    monitoringCalls = 0;
    cardStatus = null;
    mockDiscover.mockImplementation(async () => ({ topology: cardTopology(circuit(20, 20)), panelDevice: null, panelSize: 32 }));
    mockFallback.mockRejectedValue(new Error("no fallback"));
  });
  afterEach(() => {
    for (const el of mounted.splice(0)) el.remove();
    vi.restoreAllMocks();
    mockDiscover.mockReset();
    mockFallback.mockReset();
  });

  it("re-fetches topology and monitoring, and redraws what is judged against the monitoring rating, on an event for its entry", async () => {
    // A measured 10 A: utilization is 10 A over the monitoring rating, the breaker label the panel's rating.
    const withCurrent = (c: Circuit): Circuit => ({ ...c, entities: { power: "sensor.oven_power", current: "sensor.oven_current" } });
    cardStatus = withCurrent(circuit(20, 20));
    mockDiscover.mockImplementation(async () => ({ topology: cardTopology(withCurrent(circuit(20, 20))), panelDevice: null, panelSize: 32 }));
    const connection = new FakeConnection();
    const card = await mount(connection, { "sensor.oven_current": { entity_id: "sensor.oven_current", state: "10", attributes: {} } });
    const utilization = (): string | undefined => card.shadowRoot!.querySelector(".utilization")?.textContent?.trim();
    const badge = (): HTMLElement | null => card.shadowRoot!.querySelector<HTMLElement>(".breaker-badge");
    expect(utilization()).toBe("50%");
    expect(badge()!.innerHTML).toBe("20A");
    const fetches = mockDiscover.mock.calls.length;
    const status = monitoringCalls;
    cardStatus = withCurrent(circuit(20, 50, true));
    mockDiscover.mockImplementation(async () => ({ topology: cardTopology(withCurrent(circuit(20, 50, true))), panelDevice: null, panelSize: 32 }));

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent(ENTRY, ["oven"]));

    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBeGreaterThan(fetches));
    await vi.waitFor(() => expect(monitoringCalls).toBeGreaterThan(status));
    await vi.waitFor(() => expect(utilization()).toBe("20%"));
    // The grid's label is the panel's rating, unmarked, whatever the user sets for monitoring.
    expect(badge()!.innerHTML).toBe("20A");
    expect(card.shadowRoot!.querySelector(".rating-user-set")).toBeNull();
  });

  it("does nothing on an event for another entry", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const fetches = mockDiscover.mock.calls.length;
    const status = monitoringCalls;

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-2", ["oven"]));
    await flush();

    expect(mockDiscover.mock.calls.length).toBe(fetches);
    expect(monitoringCalls).toBe(status);
    expect(card.shadowRoot!.textContent).toContain("20A");
  });

  it("unsubscribes when it is detached, and subscribes again on re-attach", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(1);

    card.remove();
    await flush();
    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(0);

    document.body.appendChild(card);
    await flush();
    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(1);
  });

  it("does not subscribe when its topology came from the entity fallback", async () => {
    const connection = new FakeConnection();
    mockDiscover.mockRejectedValue(new Error("not an administrator"));
    mockFallback.mockImplementation(async () => ({ topology: cardTopology(circuit(null, null)), panelDevice: null, panelSize: 32 }));

    await mount(connection);

    expect(connection.subscriptions.filter(s => s.key === PACKAGE_RATINGS_CHANGED)).toHaveLength(0);
  });
});

// ── The sidebar dashboard ─────────────────────────────────────────────────

type Panel = HTMLElement & { hass: HomeAssistant };

function device(n: number): PanelDevice {
  return { id: `panel-${n}`, name: `Panel ${n}`, config_entry_id: `entry-${n}`, identifiers: [["span_panel", `sp3-test-00${n}`]], via_device_id: null };
}

describe("the sidebar dashboard", () => {
  let rendered: PanelTopology;
  /** What `get_monitoring_status` answers for the Oven; null answers nothing. */
  let status: Circuit | null;
  /** The entity states Home Assistant holds. */
  let states: HomeAssistant["states"];
  let render: ReturnType<typeof vi.spyOn>;
  let refreshSidePanel: ReturnType<typeof vi.spyOn>;
  let invalidate: ReturnType<typeof vi.spyOn>;

  function panelHass(connection: FakeConnection, isAdmin = true, favorites: Record<string, unknown> = {}): HomeAssistant {
    return hassWith(connection, {
      states,
      user: { is_admin: isAdmin },
      callWS: (async (msg: Record<string, unknown>) => {
        if (msg.type === "config/device_registry/list") return [device(1), device(2)];
        if (msg.service === "get_favorites") return { response: { favorites } };
        if (msg.service === "get_monitoring_status" && status) return monitoringFor(status);
        return {};
      }) as HomeAssistant["callWS"],
    });
  }

  /** Switch the open view to `tab`, as the tab bar's click handler does. */
  function showTab(panel: Panel, tab: string): void {
    (panel as unknown as { _activeTab: string })._activeTab = tab;
  }

  async function mount(connection: FakeConnection, isAdmin = true): Promise<Panel> {
    const panel = document.createElement("span-panel") as Panel;
    panel.hass = panelHass(connection, isAdmin);
    document.body.appendChild(panel);
    mounted.push(panel);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    await flush();
    return panel;
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", new Storage());
    localStorage.clear();
    rendered = topologyOf(circuit(20, 20));
    status = null;
    states = {};
    mockDiscover.mockImplementation(async () => ({ topology: rendered, panelDevice: null, panelSize: 32 }));
    render = vi.spyOn(DashboardTab.prototype, "render").mockImplementation(async () => rendered);
    refreshSidePanel = vi.spyOn(DashboardTab.prototype, "refreshSidePanel").mockResolvedValue(undefined);
    invalidate = vi.spyOn(DashboardTab.prototype, "invalidateMonitoring");
  });
  afterEach(() => {
    for (const el of mounted.splice(0)) el.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockDiscover.mockReset();
  });

  it("subscribes once per panel entry", async () => {
    const connection = new FakeConnection();
    await mount(connection);

    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(2);
  });

  it("subscribes nothing for a non-administrator", async () => {
    const connection = new FakeConnection();
    await mount(connection, false);

    expect(connection.subscriptions.filter(s => s.key === PACKAGE_RATINGS_CHANGED)).toHaveLength(0);
  });

  it("re-renders the shown panel, with fresh monitoring, on an event for its entry", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    const renders = render.mock.calls.length;
    rendered = topologyOf(circuit(20, 50, true));

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(render.mock.calls.length).toBeGreaterThan(renders));
    expect(invalidate).toHaveBeenCalled();
    expect(refreshSidePanel).toHaveBeenCalledWith("entry-1", rendered, new Set(["c-1"]));
  });

  it("drops the list views' monitoring caches on an event for a panel it shows", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    const list = (panel as unknown as { _listDashCtrl: DashboardController })._listDashCtrl;
    const single = vi.spyOn(list.monitoringCache, "invalidate");
    const multi = vi.spyOn(list.monitoringMultiCache, "invalidate");

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    expect(single).toHaveBeenCalled();
    expect(multi).toHaveBeenCalled();
  });

  it("leaves the Adopted tab as it is, its rows its own, while still dropping the monitoring caches", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    showTab(panel, "adopted");
    const fetches = mockDiscover.mock.calls.length;
    const renders = render.mock.calls.length;

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));
    await flush();
    await flush();

    expect(invalidate).toHaveBeenCalled();
    expect(mockDiscover.mock.calls.length).toBe(fetches);
    expect(render.mock.calls.length).toBe(renders);
    expect(refreshSidePanel).not.toHaveBeenCalled();
  });

  it("redraws the Monitoring tab's rating cell from the new status on an event for its entry", async () => {
    status = circuit(20, 20);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    showTab(panel, "monitoring");
    const cell = (): HTMLElement | null => panel.shadowRoot!.querySelector<HTMLElement>(".rating-cell");
    await vi.waitFor(() => expect(cell()?.textContent).toBe("20A"));
    expect(cell()!.querySelector(".rating-user-set")).toBeNull();

    status = circuit(20, 50, true);
    rendered = topologyOf(status);
    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(cell()?.querySelector(".rating-user-set")).not.toBeNull());
    expect(cell()!.textContent).toContain("50A");
    expect(cell()!.querySelector(".rating-user-set")!.getAttribute("title")).toBe("20-30 from your SPAN app (the panel publishes 20 A)");
  });

  it("redraws a list row's utilization against the new monitoring rating, its breaker label staying the panel's", async () => {
    // A measured 10 A with no monitor figure: the row's utilization is 10 A over the monitoring rating.
    const withCurrent = (c: Circuit): Circuit => ({ ...c, entities: { power: "sensor.oven_power", current: "sensor.oven_current" } });
    states = { "sensor.oven_current": { entity_id: "sensor.oven_current", state: "10", attributes: {} } };
    status = withCurrent(circuit(20, 20));
    rendered = topologyOf(status);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    showTab(panel, "activity");
    const content = (): HTMLElement => panel.shadowRoot!.getElementById("tab-content")!;
    const utilization = (): string | undefined => content().querySelector(".utilization")?.textContent?.trim();
    const badge = (): HTMLElement | null => content().querySelector<HTMLElement>(".breaker-badge");
    await vi.waitFor(() => expect(utilization()).toBe("50%"));
    expect(badge()!.innerHTML).toBe("20A");

    status = withCurrent(circuit(20, 50, true));
    rendered = topologyOf(status);
    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(utilization()).toBe("20%"));
    expect(badge()!.innerHTML).toBe("20A");
    expect(content().querySelector(".rating-user-set")).toBeNull();
  });

  it("hands a rating event to the list controller's open circuit panel, whose subtitle stays the panel's rating", async () => {
    status = circuit(20, 20);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    const refreshList = vi.spyOn(DashboardController.prototype, "refreshCircuitSidePanel");
    showTab(panel, "activity");
    const content = (): HTMLElement => panel.shadowRoot!.getElementById("tab-content")!;
    await vi.waitFor(() => expect(content().querySelector('.gear-icon[data-uuid="c-1"]')).not.toBeNull());
    content().querySelector<HTMLElement>('.gear-icon[data-uuid="c-1"]')!.click();
    const side = (): HTMLElement & { readonly openCircuit: { uuid: string } | null } =>
      content().querySelector("span-side-panel") as HTMLElement & { readonly openCircuit: { uuid: string } | null };
    await vi.waitFor(() => expect(side().openCircuit?.uuid).toBe("c-1"));
    const subtitle = (): string | null | undefined => side().shadowRoot!.querySelector(".subtitle")?.textContent;
    expect(subtitle()).toBe("20A \u00b7 240V \u00b7 Tabs [1]");

    status = circuit(20, 50, true);
    rendered = topologyOf(status);
    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledWith(content(), "entry-1", rendered, new Set(["c-1"])));
    expect(subtitle()).toBe("20A \u00b7 240V \u00b7 Tabs [1]");
    expect(refreshSidePanel).not.toHaveBeenCalled();
    expect(side().openCircuit?.uuid).toBe("c-1");
  });

  it("hands an event for a favorites panel to the list controller's open circuit panel", async () => {
    localStorage.setItem("span_panel_selected", "favorites");
    const build = vi.spyOn(FavoritesController.prototype, "build").mockResolvedValue({
      topology: { circuits: {}, sub_devices: {}, _favoriteRefs: {} },
      entryIds: ["entry-1"],
      perPanelStats: [{ panelDeviceId: "panel-1", panelName: "Panel 1", topology: rendered }],
    } as unknown as Awaited<ReturnType<FavoritesController["build"]>>);
    const refreshList = vi.spyOn(DashboardController.prototype, "refreshCircuitSidePanel").mockResolvedValue(undefined);
    const connection = new FakeConnection();
    const panel = document.createElement("span-panel") as Panel;
    panel.hass = panelHass(connection, true, { "panel-1": { circuits: ["c-1"], sub_devices: [] } });
    document.body.appendChild(panel);
    mounted.push(panel);
    await vi.waitFor(() => expect(build).toHaveBeenCalled());
    await flush();
    rendered = topologyOf(circuit(20, 50, true));

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledWith(panel.shadowRoot!.getElementById("tab-content"), "entry-1", rendered, new Set(["c-1"])));
    expect(refreshSidePanel).not.toHaveBeenCalled();
  });

  it("does nothing for an event on a panel it is not showing", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    const renders = render.mock.calls.length;
    const fetches = mockDiscover.mock.calls.length;
    rendered = topologyOf(circuit(20, 50, true));

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-2"));
    await flush();

    expect(render.mock.calls.length).toBe(renders);
    expect(mockDiscover.mock.calls.length).toBe(fetches);
    expect(refreshSidePanel).not.toHaveBeenCalled();
  });

  it("does not re-render for an event that leaves the topology as it was", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    const renders = render.mock.calls.length;
    const fetches = mockDiscover.mock.calls.length;

    connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));
    // The handler ran: it dropped the cache and re-fetched the topology, found it unchanged.
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBeGreaterThan(fetches));
    expect(invalidate).toHaveBeenCalled();
    await flush();
    await flush();

    expect(render.mock.calls.length).toBe(renders);
  });

  it("answers a burst of events with one fetch in flight and one trailing, and shows the last answer", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    await flush();
    const fetches = mockDiscover.mock.calls.length;
    const gates: Array<(t: PanelTopology) => void> = [];
    mockDiscover.mockImplementation(() => new Promise(resolve => gates.push(topology => resolve({ topology, panelDevice: null, panelSize: 32 }))));

    for (let i = 0; i < 5; i += 1) connection.emit(PACKAGE_RATINGS_CHANGED, ratingEvent("entry-1"));
    await flush();
    expect(mockDiscover.mock.calls.length).toBe(fetches + 1);

    const stale = topologyOf(circuit(20, 40, true));
    gates[0]!(stale);
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(fetches + 2));
    const last = topologyOf(circuit(20, 50, true));
    gates[1]!(last);
    await vi.waitFor(() => expect(refreshSidePanel).toHaveBeenLastCalledWith("entry-1", last, new Set(["c-1"])));
    await flush();

    expect(mockDiscover.mock.calls.length).toBe(fetches + 2);
  });

  it("subscribes nothing when the panel list resolves after the element was detached", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const hass = panelHass(connection);
    panel.hass = {
      ...hass,
      callWS: (async (msg: Record<string, unknown>) => {
        if (msg.type === "config/device_registry/list") {
          await gate;
          return [device(1), device(2), device(3)];
        }
        return hass.callWS(msg);
      }) as HomeAssistant["callWS"],
    };
    connection.emit("device_registry_updated", {});
    await flush();

    panel.remove();
    release();
    await flush();
    await flush();

    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(0);
  });

  it("unsubscribes from every entry when detached", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);

    panel.remove();
    await flush();

    expect(connection.live(PACKAGE_RATINGS_CHANGED)).toBe(0);
  });
});
