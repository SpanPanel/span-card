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
import { MONITORING_RATING_CHANGED, subscribeMonitoringRatingChanges } from "../src/core/rating-events.js";
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
  return { event_type: MONITORING_RATING_CHANGED, data: { config_entry_id: entryId, circuit_ids: circuitIds } };
}

describe("subscribeMonitoringRatingChanges", () => {
  it("listens for the integration's monitoring-rating event", async () => {
    const connection = new FakeConnection();
    await subscribeMonitoringRatingChanges(hassWith(connection), "entry-1", vi.fn());

    expect(MONITORING_RATING_CHANGED).toBe("span_panel_monitoring_rating_changed");
    expect(connection.live("span_panel_monitoring_rating_changed")).toBe(1);
  });

  it("calls back for an event on its own entry", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    await subscribeMonitoringRatingChanges(hassWith(connection), "entry-1", onChange);

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores an event for another entry, even for the same circuit id", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    await subscribeMonitoringRatingChanges(hassWith(connection), "entry-1", onChange);

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-2", ["c-1"]));

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([[null], [undefined], ["entry-1"], [{}], [{ data: null }], [{ data: {} }], [{ data: { config_entry_id: 1 } }]])(
    "ignores a malformed event %j",
    async event => {
      const connection = new FakeConnection();
      const onChange = vi.fn();
      await subscribeMonitoringRatingChanges(hassWith(connection), "entry-1", onChange);

      connection.emit(MONITORING_RATING_CHANGED, event);

      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it("stops calling back once unsubscribed", async () => {
    const connection = new FakeConnection();
    const onChange = vi.fn();
    const unsubscribe = await subscribeMonitoringRatingChanges(hassWith(connection), "entry-1", onChange);
    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(1);

    unsubscribe();

    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(0);
    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("subscribes to nothing, and returns a no-op, without a connection", async () => {
    const hass = { states: {}, services: {}, language: "en" } as unknown as HomeAssistant;
    const unsubscribe = await subscribeMonitoringRatingChanges(hass, "entry-1", vi.fn());
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

function circuit(panel: number | null, effective: number | null, userSet = false): Circuit {
  return {
    name: "Oven",
    tabs: [1],
    entities: { power: "sensor.oven_power" },
    voltage: 240,
    breaker_rating_a: panel,
    monitoring_rating_a: effective,
    monitoring_rating_user_set: userSet,
  };
}

function topologyOf(c: Circuit, entryId = ENTRY): PanelTopology {
  return { circuits: { "c-1": c }, panel_size: 32, panel_device_id: "panel-1", config_entry_id: entryId } as unknown as PanelTopology;
}

function monitoringFor(c: Circuit): Record<string, unknown> {
  return {
    response: {
      enabled: true,
      circuits: {
        "sensor.oven_power": {
          name: "Oven",
          breaker_rating_a: c.breaker_rating_a,
          monitoring_rating_a: c.monitoring_rating_a,
          monitoring_rating_user_set: c.monitoring_rating_user_set,
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
  ctrl.showBreakerRating = true;
  ctrl.init(topologyOf(initial), {} as CardConfig, hass, ENTRY);
  await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);
  return { root, panel, ctrl, callWS, setStatus: c => (status = monitoringFor(c)) };
}

const section = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="breaker-section"]');
const input = (p: SidePanel): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>('[data-role="breaker-input"]')!;
const judged = (p: SidePanel): string | undefined => p.shadowRoot!.querySelector('[data-role="judged-against"]')?.textContent ?? undefined;
const reset = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="breaker-reset"]');

describe("the Monitoring section's judged-against line", () => {
  it("names the rating the point is judged against, with the user-set form naming the panel's", async () => {
    expect(judged((await openOven(circuit(30, 30))).panel)).toBe("Judged against: 30 A");
    expect(judged((await openOven(circuit(20, 50, true))).panel)).toBe("Judged against: 50 A, set by you (panel: 20 A)");
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

  it("rebuilds the Breaker section from the integration's answer, dropping what was typed", async () => {
    const open = await openOven(circuit(20, 20));
    expect(reset(open.panel)).toBeNull();
    input(open.panel).value = "45";
    const before = section(open.panel);

    const after = circuit(20, 50, true);
    open.setStatus(after);
    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(after));

    expect(section(open.panel)).not.toBe(before);
    expect(input(open.panel).value).toBe("50");
    expect(reset(open.panel)).not.toBeNull();
    expect(open.panel.shadowRoot!.querySelector('[data-role="breaker-panel-rating"]')!.textContent).toContain("20");
    expect(judged(open.panel)).toBe("Judged against: 50 A, set by you (panel: 20 A)");
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
    expect(input(open.panel).value).toBe("20");
  });

  it("drops a typed value still waiting out its debounce, so a refusal leaves the integration's rating", async () => {
    const open = await openOven(circuit(20, 20));
    const sent = vi.spyOn(open.panel as unknown as { _callDomainService: () => Promise<unknown> }, "_callDomainService");
    input(open.panel).value = "45";
    input(open.panel).dispatchEvent(new Event("input"));

    await open.ctrl.refreshCircuitSidePanel(open.root, ENTRY, topologyOf(circuit(20, 20)));
    vi.advanceTimersByTime(1000);

    expect(sent).not.toHaveBeenCalled();
    expect(input(open.panel).value).toBe("20");
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

  it("marks a user-set rating, naming the panel's, and leaves the mains unmarked", async () => {
    const container = await render({
      circuits: { "sensor.a": { name: "Oven", breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true } },
      mains: { "sensor.m": { name: "Mains L1", breaker_rating_a: 200, monitoring_rating_a: 200, monitoring_rating_user_set: false } },
    });
    const [mains, oven] = cells(container);

    expect(oven!.querySelector(".rating-user-set")!.getAttribute("title")).toBe("Set by you; panel: 20 A");
    expect(oven!.textContent).toContain("50A");
    expect(mains!.querySelector(".rating-user-set")).toBeNull();
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

  function hassFor(connection: FakeConnection): HomeAssistant {
    return hassWith(connection, {
      callWS: (async (msg: Record<string, unknown>) => {
        if (msg.service === "get_monitoring_status") monitoringCalls += 1;
        if (msg.type === "config/device_registry/list") return [];
        return {};
      }) as HomeAssistant["callWS"],
    });
  }

  async function mount(connection: FakeConnection): Promise<Card> {
    const card = document.createElement("span-panel-card") as Card;
    card.setConfig({ device_id: "panel-1" } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);
    card.hass = hassFor(connection);
    await vi.waitFor(() => expect(connection.subscriptions.length).toBeGreaterThan(0));
    await flush();
    return card;
  }

  beforeEach(() => {
    monitoringCalls = 0;
    mockDiscover.mockImplementation(async () => ({ topology: cardTopology(circuit(20, 20)), panelDevice: null, panelSize: 32 }));
    mockFallback.mockRejectedValue(new Error("no fallback"));
  });
  afterEach(() => {
    for (const el of mounted.splice(0)) el.remove();
    vi.restoreAllMocks();
    mockDiscover.mockReset();
    mockFallback.mockReset();
  });

  it("re-fetches topology and monitoring, and redraws the rating, on an event for its entry", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    expect(card.shadowRoot!.textContent).toContain("20A");
    expect(card.shadowRoot!.querySelector(".rating-user-set")).toBeNull();
    const fetches = mockDiscover.mock.calls.length;
    const status = monitoringCalls;
    mockDiscover.mockImplementation(async () => ({ topology: cardTopology(circuit(20, 50, true)), panelDevice: null, panelSize: 32 }));

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent(ENTRY, ["oven"]));

    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBeGreaterThan(fetches));
    await vi.waitFor(() => expect(monitoringCalls).toBeGreaterThan(status));
    // The grid's label is the panel's rating, unmarked, whatever the user sets for monitoring.
    expect(card.shadowRoot!.textContent).toContain("20A");
    expect(card.shadowRoot!.textContent).not.toContain("50A");
    expect(card.shadowRoot!.querySelector(".rating-user-set")).toBeNull();
  });

  it("does nothing on an event for another entry", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const fetches = mockDiscover.mock.calls.length;
    const status = monitoringCalls;

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-2", ["oven"]));
    await flush();

    expect(mockDiscover.mock.calls.length).toBe(fetches);
    expect(monitoringCalls).toBe(status);
    expect(card.shadowRoot!.textContent).toContain("20A");
  });

  it("unsubscribes when it is detached, and subscribes again on re-attach", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(1);

    card.remove();
    await flush();
    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(0);

    document.body.appendChild(card);
    await flush();
    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(1);
  });

  it("does not subscribe when its topology came from the entity fallback", async () => {
    const connection = new FakeConnection();
    mockDiscover.mockRejectedValue(new Error("not an administrator"));
    mockFallback.mockImplementation(async () => ({ topology: cardTopology(circuit(null, null)), panelDevice: null, panelSize: 32 }));

    await mount(connection);

    expect(connection.subscriptions.filter(s => s.key === MONITORING_RATING_CHANGED)).toHaveLength(0);
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
  let render: ReturnType<typeof vi.spyOn>;
  let refreshSidePanel: ReturnType<typeof vi.spyOn>;
  let invalidate: ReturnType<typeof vi.spyOn>;

  function panelHass(connection: FakeConnection, isAdmin = true, favorites: Record<string, unknown> = {}): HomeAssistant {
    return hassWith(connection, {
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

    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(2);
  });

  it("subscribes nothing for a non-administrator", async () => {
    const connection = new FakeConnection();
    await mount(connection, false);

    expect(connection.subscriptions.filter(s => s.key === MONITORING_RATING_CHANGED)).toHaveLength(0);
  });

  it("re-renders the shown panel, with fresh monitoring, on an event for its entry", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    const renders = render.mock.calls.length;
    rendered = topologyOf(circuit(20, 50, true));

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(render.mock.calls.length).toBeGreaterThan(renders));
    expect(invalidate).toHaveBeenCalled();
    expect(refreshSidePanel).toHaveBeenCalledWith("entry-1", rendered);
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
    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(cell()?.querySelector(".rating-user-set")).not.toBeNull());
    expect(cell()!.textContent).toContain("50A");
    expect(cell()!.querySelector(".rating-user-set")!.getAttribute("title")).toBe("Set by you; panel: 20 A");
  });

  it("redraws a circuit panel open on a list tab, in place, on an event for its entry", async () => {
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
    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledWith(content(), "entry-1", rendered));
    // The subtitle is the panel's rating, which a monitoring rating does not change.
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

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));

    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledWith(panel.shadowRoot!.getElementById("tab-content"), "entry-1", rendered));
    expect(refreshSidePanel).not.toHaveBeenCalled();
  });

  it("does nothing for an event on a panel it is not showing", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    const renders = render.mock.calls.length;
    const fetches = mockDiscover.mock.calls.length;
    rendered = topologyOf(circuit(20, 50, true));

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-2"));
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

    connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));
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

    for (let i = 0; i < 5; i += 1) connection.emit(MONITORING_RATING_CHANGED, ratingEvent("entry-1"));
    await flush();
    expect(mockDiscover.mock.calls.length).toBe(fetches + 1);

    const stale = topologyOf(circuit(20, 40, true));
    gates[0]!(stale);
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(fetches + 2));
    const last = topologyOf(circuit(20, 50, true));
    gates[1]!(last);
    await vi.waitFor(() => expect(refreshSidePanel).toHaveBeenLastCalledWith("entry-1", last));
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

    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(0);
  });

  it("unsubscribes from every entry when detached", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);

    panel.remove();
    await flush();

    expect(connection.live(MONITORING_RATING_CHANGED)).toBe(0);
  });
});
