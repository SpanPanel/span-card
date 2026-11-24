import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Storage } from "happy-dom";
import type { DeviceRegistryEntry } from "../src/core/registry-types.js";
import type { HomeAssistant, PanelDevice, PanelTopology } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";
import { FavoritesController } from "../src/core/favorites-controller.js";
import { ListViewController } from "../src/core/list-view-controller.js";
import { AdoptedTab } from "../src/panel/tab-adopted.js";
import { DashboardTab } from "../src/panel/tab-dashboard.js";
import { SpanPanelElement } from "../src/panel/span-panel.js";
import { DEVICE_REGISTRY, ENTITY_REGISTRY, ENTRY_RELOADS, FakeConnection, flush, hassWith } from "./fake-connection.js";

/**
 * The frontend attaches the sidebar dashboard once and discards it as the user
 * navigates away. It keeps one reload subscription while attached, lets every
 * subscription go as it is detached, and leaves nothing running that work
 * landing after the detach would start; a re-seed reporting many loaded panels
 * refreshes the panel list once.
 */

const mockDiscover = vi.mocked(discoverTopology);
type Panel = HTMLElement & { hass: HomeAssistant };

function device(n: number): PanelDevice {
  return { id: `panel-${n}`, name: `Panel ${n}`, config_entry_id: `entry-${n}`, identifiers: [["span_panel", `sp3-test-00${n}`]], via_device_id: null };
}

/**
 * A circuit's device as the raw device list sends it: a child of panel `n`, with
 * a `parent_device_id` and no `via_device_id` key.
 */
function circuitDevice(n: number, circuitId: string): DeviceRegistryEntry {
  return {
    id: `circuit-device-${n}-${circuitId}`,
    name: `Circuit ${circuitId}`,
    name_by_user: null,
    config_entry_id: `entry-${n}`,
    identifiers: [["span_panel", `sp3-test-00${n}_circuit_${circuitId}`]],
    parent_device_id: `panel-${n}`,
    area_id: null,
  };
}

/**
 * Panel `n`'s device as a helper's config entry owns it: Home Assistant 2026.8
 * split a device the panel shared with a helper into one per entry, each with
 * the panel's identifiers and name.
 */
function helperCopy(n: number): DeviceRegistryEntry {
  return { ...device(n), id: `panel-twin-${n}`, config_entry_id: `helper-entry-${n}` };
}

/** The integration's config entries, which `config_entries/get` lists for its domain: one for each panel the tests use. */
const SPAN_ENTRIES = [1, 2, 3, 4].map(n => ({ entry_id: `entry-${n}`, domain: "span_panel" }));

function statusOf(deviceId: string): string {
  return `binary_sensor.${deviceId.replace("-", "_")}_status`;
}

/** What the device registry list answers: panels, and whatever else a test puts beside them. */
let devices: DeviceRegistryEntry[] = [];
let favorites: Record<string, { circuits: string[]; sub_devices: string[] }> = {};
let deviceListCalls = 0;
/** What `get_monitoring_status` answers; null answers nothing. */
let monitoring: Record<string, unknown> | null = null;
/** The entity states Home Assistant holds. */
let states: HomeAssistant["states"] = {};
/** Every relay or priority change sent. */
let controlSends: Record<string, unknown>[] = [];

function hassFor(connection: FakeConnection): HomeAssistant {
  return hassWith(connection, {
    states,
    callWS: (async (msg: Record<string, unknown>) => {
      if (msg.type === "call_service" && (msg.domain === "switch" || msg.domain === "select")) controlSends.push(msg);
      if (msg.type === "config/device_registry/list") {
        deviceListCalls += 1;
        return devices;
      }
      if (msg.type === "config_entries/get" && msg.domain === "span_panel") return SPAN_ENTRIES;
      if (msg.type === "call_service" && msg.service === "get_favorites") return { response: { favorites } };
      if (msg.type === "call_service" && msg.service === "get_monitoring_status" && monitoring) return { response: monitoring };
      if (msg.type === "span_panel/adopted/list") return { devices: [] };
      return {};
    }) as HomeAssistant["callWS"],
  });
}

const mounted: HTMLElement[] = [];
let watch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Node 25+ defines its own `localStorage`, undefined without
  // `--localstorage-file`, and it shadows happy-dom's; the element reads it.
  vi.stubGlobal("localStorage", new Storage());
  localStorage.clear();
  devices = [device(1)];
  favorites = {};
  deviceListCalls = 0;
  monitoring = null;
  states = {};
  controlSends = [];
  watch = vi.spyOn(ErrorStore.prototype, "watchPanelStatus");
  vi.spyOn(DashboardTab.prototype, "render").mockResolvedValue(null);
  mockDiscover.mockImplementation(async (_hass, deviceId) => ({
    topology: { circuits: {}, panel_entities: { panel_status: statusOf(String(deviceId)) } } as unknown as PanelTopology,
    panelSize: 32,
  }));
});

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockDiscover.mockReset();
});

async function mount(connection: FakeConnection, waitFor: () => void): Promise<Panel> {
  const panel = document.createElement("span-panel") as Panel;
  panel.hass = hassFor(connection);
  document.body.appendChild(panel);
  mounted.push(panel);
  await vi.waitFor(waitFor);
  await flush();
  return panel;
}

function loaded(...ids: number[]): unknown {
  return ids.map(n => ({ type: null, entry: { entry_id: `entry-${n}`, domain: "span_panel", state: "loaded" } }));
}

describe("span-panel subscriptions", () => {
  it("refreshes the panel list once for a re-seed that reports three other loaded panels", async () => {
    devices = [device(1), device(2), device(3), device(4)];
    const connection = new FakeConnection();
    await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    connection.emit(ENTRY_RELOADS, loaded(1, 2, 3, 4));
    await flush();
    const before = deviceListCalls;

    connection.emit(ENTRY_RELOADS, loaded(1, 2, 3, 4));

    await vi.waitFor(() => expect(deviceListCalls).toBe(before + 1));
    await flush();
    expect(deviceListCalls).toBe(before + 1);
  });

  it("hears reloads from a panel that _refreshPanels added", async () => {
    const connection = new FakeConnection();
    await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    connection.emit(ENTRY_RELOADS, loaded(1));
    devices = [device(1), device(2)];
    connection.emit("device_registry_updated", {});
    await flush();
    const before = deviceListCalls;

    connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: "entry-2", domain: "span_panel", state: "loaded" } }]);

    await vi.waitFor(() => expect(deviceListCalls).toBe(before + 1));
  });

  /** The panel dropdown's choices, by device id. */
  function listedPanels(panel: Panel): string[] {
    const select = panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select");
    if (!select) throw new Error("no panel dropdown");
    return Array.from(select.options).map(option => option.value);
  }

  it("the sidebar never selects a circuit device as the default panel", async () => {
    // The circuit devices sort ahead of their panel, where the default is taken from.
    devices = [circuitDevice(1, "a"), circuitDevice(1, "b"), device(1)];

    const panel = await mount(new FakeConnection(), () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));

    expect(mockDiscover.mock.calls.map(call => call[1])).toEqual(["panel-1"]);
    expect(listedPanels(panel)).toEqual(["panel-1"]);
  });

  it("keeps a circuit device out of the panel list when the device registry changes", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    const before = deviceListCalls;

    // The integration's conversion adds the circuit devices; a second panel shows the list was re-read.
    devices = [circuitDevice(1, "a"), device(1), circuitDevice(2, "a"), device(2)];
    connection.emit("device_registry_updated", {});
    await vi.waitFor(() => expect(deviceListCalls).toBe(before + 1));
    await vi.waitFor(() => expect(listedPanels(panel)).toHaveLength(2));

    expect(listedPanels(panel)).toEqual(["panel-1", "panel-2"]);
  });

  it("lists a panel once, and selects it, where a helper's copy of its device is listed first", async () => {
    devices = [helperCopy(1), device(1)];

    const panel = await mount(new FakeConnection(), () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));

    expect(mockDiscover.mock.calls.map(call => call[1])).toEqual(["panel-1"]);
    expect(listedPanels(panel)).toEqual(["panel-1"]);
  });

  it("keeps a helper's copy of a panel's device out of the panel list when the device registry changes", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    const before = deviceListCalls;

    // A second panel shows the list was re-read.
    devices = [helperCopy(1), device(1), helperCopy(2), device(2)];
    connection.emit("device_registry_updated", {});
    await vi.waitFor(() => expect(deviceListCalls).toBe(before + 1));
    await vi.waitFor(() => expect(listedPanels(panel)).toHaveLength(2));

    expect(listedPanels(panel)).toEqual(["panel-1", "panel-2"]);
  });

  it("falls to another panel, never a circuit device, when the selected panel is removed", async () => {
    devices = [device(1), device(2)];
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));

    devices = [circuitDevice(2, "a"), device(2)];
    connection.emit("device_registry_updated", {});

    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(statusOf("panel-2")));
    expect(listedPanels(panel)).toEqual(["panel-2"]);
    expect(localStorage.getItem("span_panel_selected")).toBe("panel-2");
  });

  it("stops the intervals a render landing after the frontend discarded the dashboard started", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    const intervals: string[] = [];
    vi.spyOn(DashboardController.prototype, "startIntervals").mockImplementation(() => void intervals.push("start"));
    vi.spyOn(DashboardController.prototype, "stopIntervals").mockImplementation(() => void intervals.push("stop"));
    let resolveActivity: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveActivity = r)));
    const calls = mockDiscover.mock.calls.length;
    (panel as unknown as { _activeTab: string })._activeTab = "activity";
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));

    // The user navigates away while By Activity reads its topology: the frontend detaches the dashboard and discards it.
    panel.remove();
    resolveActivity({ topology: { circuits: {}, panel_entities: {} } as unknown as PanelTopology, panelSize: 32 });
    await vi.waitFor(() => expect(intervals).toContain("start"));
    await flush();

    expect(intervals.at(-1)).toBe("stop");
  });

  it("does not subscribe the area tab on an element detached while the tab rendered", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    // The render's last step before it subscribes; stubbed so no interval outlives the test.
    const started = vi.spyOn(DashboardController.prototype, "startIntervals").mockImplementation(() => {});
    let resolveArea: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveArea = r)));
    const calls = mockDiscover.mock.calls.length;
    (panel as unknown as { _activeTab: string })._activeTab = "area";
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));

    panel.remove();
    resolveArea({ topology: { circuits: {}, panel_entities: {} } as unknown as PanelTopology, panelSize: 32 });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    await flush();

    expect(connection.live(ENTITY_REGISTRY)).toBe(0);
  });

  /** The kitchen circuit's own device, which its label is read from. */
  const KITCHEN_DEVICE = "circuit-device-1-kitchen";

  /** Panel 1's topology with one circuit; `name` is structure, `relay` is live. */
  function kitchenTopology(relay: string, name = "Kitchen"): Awaited<ReturnType<typeof discoverTopology>> {
    return {
      topology: {
        circuits: { kitchen: { name, device_id: KITCHEN_DEVICE, tabs: [1], entities: { power: "sensor.kitchen_power" }, relay_state: relay } },
        panel_entities: { panel_status: statusOf("panel-1") },
        panel_device_id: "panel-1",
      } as unknown as PanelTopology,
      panelSize: 32,
    };
  }

  async function onActivityTab(connection: FakeConnection): Promise<ReturnType<typeof vi.spyOn>> {
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    mockDiscover.mockImplementation(async () => kitchenTopology("CLOSED"));
    const rendered = vi.spyOn(ListViewController.prototype, "renderActivityView");
    (panel as unknown as { _activeTab: string })._activeTab = "activity";
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(1));
    // The subscription's first batch only seeds.
    connection.emit(ENTRY_RELOADS, loaded(1));
    await flush();
    return rendered;
  }

  it("re-fetches on a re-seed and leaves the view alone when only live fields changed", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    const calls = mockDiscover.mock.calls.length;
    mockDiscover.mockImplementation(async () => kitchenTopology("OPEN"));

    connection.emit(ENTRY_RELOADS, loaded(1));
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));
    await flush();

    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("re-renders on a re-seed when the topology's structure changed", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    mockDiscover.mockImplementation(async () => kitchenTopology("CLOSED", "Garage"));

    connection.emit(ENTRY_RELOADS, loaded(1));

    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
  });

  /** Panel 1's kitchen topology, saying whether the user may operate the panel's controls. */
  function withControlAccess(control_access: { may_operate: boolean; reason: string | null }): Awaited<ReturnType<typeof discoverTopology>> {
    const result = kitchenTopology("CLOSED");
    return { ...result, topology: { ...result.topology!, control_access } as PanelTopology };
  }

  it("re-renders on a re-seed when the access the user has to the panel's controls changed", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    mockDiscover.mockImplementation(async () => withControlAccess({ may_operate: false, reason: "admin_only" }));

    connection.emit(ENTRY_RELOADS, loaded(1));

    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
  });

  it("gives a circuit side panel left open the access a re-seed brings, and re-renders the view once it closes", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    const panel = mounted[0] as Panel;
    const sidePanel = panel.shadowRoot!.getElementById("tab-content")!.querySelector("span-side-panel") as HTMLElement & {
      open(config: unknown): void;
      close(): void;
      refreshControlAccess(access: unknown): void;
    };
    sidePanel.open({
      uuid: "kitchen",
      name: "Kitchen",
      members: [{ uuid: "kitchen", circuit: kitchenTopology("CLOSED").topology!.circuits.kitchen }],
      capacityA: null,
      entities: { power: "sensor.kitchen_power" },
      relay_state: "CLOSED",
      monitoringInfo: null,
      graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
      configEntryId: "entry-1",
      controlAccess: { mayOperate: true, reason: null },
    });
    const refreshed = vi.spyOn(sidePanel, "refreshControlAccess");
    mockDiscover.mockImplementation(async () => withControlAccess({ may_operate: false, reason: "admin_only" }));

    connection.emit(ENTRY_RELOADS, loaded(1));

    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith({ mayOperate: false, reason: "admin_only" }));
    await flush();
    expect(rendered).toHaveBeenCalledTimes(1);

    sidePanel.close();
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
  });

  /** A `device_registry_updated` event for an update, with the old value of each field it changed. */
  function deviceUpdate(device_id: string, changes: Record<string, unknown>): unknown {
    return { event_type: DEVICE_REGISTRY, data: { action: "update", device_id, changes } };
  }

  // A circuit is labelled by its device, which the user renames in Home
  // Assistant with no reload of the panel's entry.
  it("re-renders the view when a circuit device it shows is renamed", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    mockDiscover.mockImplementation(async () => kitchenTopology("CLOSED", "Cooking"));

    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: null }));

    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
  });

  it("leaves the view alone for a device change that is no rename of a device it shows", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    const calls = mockDiscover.mock.calls.length;

    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { area_id: null }));
    connection.emit(DEVICE_REGISTRY, deviceUpdate("device-of-another-panel", { name_by_user: null }));
    connection.emit(DEVICE_REGISTRY, { event_type: DEVICE_REGISTRY, data: { action: "create", device_id: KITCHEN_DEVICE } });
    await flush();

    expect(mockDiscover.mock.calls.length).toBe(calls);
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("answers a burst of renames with one fetch in flight and one more after it", async () => {
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    let resolveFirst: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveFirst = r)));
    const calls = mockDiscover.mock.calls.length;

    for (let i = 0; i < 3; i += 1) connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name: "Kitchen" }));
    await flush();
    expect(mockDiscover.mock.calls.length).toBe(calls + 1);

    resolveFirst(kitchenTopology("CLOSED"));
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 2));
    await flush();
    expect(mockDiscover.mock.calls.length).toBe(calls + 2);
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  it("drops a queued rename check once the view no longer shows the panel", async () => {
    const render = vi.spyOn(AdoptedTab.prototype, "render");
    const connection = new FakeConnection();
    await onActivityTab(connection);
    let resolveFirst: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveFirst = r)));
    const calls = mockDiscover.mock.calls.length;
    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: null }));
    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: "Cooking" }));
    await flush();

    // The user leaves for a tab that renders no topology while the first check is fetching.
    (document.querySelector("span-panel") as unknown as { _activeTab: string })._activeTab = "adopted";
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    resolveFirst(kitchenTopology("CLOSED", "Cooking"));
    await flush();
    await flush();

    expect(mockDiscover.mock.calls.length).toBe(calls + 1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  /** Switch the open view to `tab`, the way the tab bar's click handler does. */
  function showTab(panel: Panel, tab: string): void {
    (panel as unknown as { _activeTab: string })._activeTab = tab;
  }

  it("keeps the dashboard's view when a re-seed changes only live fields", async () => {
    const render = vi.spyOn(DashboardTab.prototype, "render").mockResolvedValue(kitchenTopology("CLOSED").topology);
    const connection = new FakeConnection();
    await mount(connection, () => expect(render).toHaveBeenCalledTimes(1));
    connection.emit(ENTRY_RELOADS, loaded(1));
    await flush();
    const calls = mockDiscover.mock.calls.length;
    mockDiscover.mockImplementation(async () => kitchenTopology("OPEN"));

    connection.emit(ENTRY_RELOADS, loaded(1));
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));
    await flush();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("does not override a re-render that lands while the comparison is fetching", async () => {
    devices = [device(1), device(2)];
    const connection = new FakeConnection();
    const rendered = await onActivityTab(connection);
    let resolveCompare: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveCompare = r)));
    const calls = mockDiscover.mock.calls.length;
    connection.emit(ENTRY_RELOADS, loaded(1));
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));

    // The user switches panels while panel 1's topology is being compared.
    const select = document.querySelector("span-panel")!.shadowRoot!.querySelector<HTMLSelectElement>("#panel-select")!;
    select.value = "panel-2";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(2));
    const schedule = vi.spyOn(SpanPanelElement.prototype as unknown as { _scheduleTabRender: () => Promise<void> }, "_scheduleTabRender");

    // Panel 1 changed structure, but the view now shows panel 2.
    resolveCompare(kitchenTopology("CLOSED", "Garage"));
    await flush();

    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps an unsaved monitoring edit across a re-seed that changes only live fields", async () => {
    monitoring = {
      enabled: true,
      global_settings: { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 },
    };
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    mockDiscover.mockImplementation(async () => kitchenTopology("CLOSED"));
    showTab(panel, "monitoring");
    const field = (): HTMLInputElement | null => panel.shadowRoot!.querySelector<HTMLInputElement>("#g-continuous");
    await vi.waitFor(() => expect(field()).not.toBeNull());
    connection.emit(ENTRY_RELOADS, loaded(1));
    await flush();
    const edited = field()!;
    edited.value = "93";
    const calls = mockDiscover.mock.calls.length;
    mockDiscover.mockImplementation(async () => kitchenTopology("OPEN"));

    connection.emit(ENTRY_RELOADS, loaded(1));
    await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));
    await flush();

    expect(field()).toBe(edited);
    expect(edited.value).toBe("93");
  });

  // The monitoring status names a circuit as the SPAN app does; the tab's rows
  // go by the label the topology fetched beside it carries, which is the
  // circuit's device's name, and follow a rename of that device.
  it("labels the Monitoring tab's rows by the topology's circuit labels, and again when a circuit's device is renamed", async () => {
    monitoring = {
      enabled: true,
      global_settings: { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 },
      circuits: { "sensor.kitchen_power": { name: "Kitchen Outlets", monitoring_enabled: true } },
      mains: {},
    };
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    mockDiscover.mockImplementation(async () => kitchenTopology("CLOSED", "Coffee Bar"));
    const row = (): string | null | undefined =>
      panel.shadowRoot!.querySelector(`.circuit-toggle[data-entity="sensor.kitchen_power"]`)?.closest("label")?.querySelector("span")?.textContent;

    showTab(panel, "monitoring");
    await vi.waitFor(() => expect(row()).toBe("Coffee Bar"));

    mockDiscover.mockImplementation(async () => kitchenTopology("CLOSED", "Espresso Corner"));
    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: "Coffee Bar" }));

    await vi.waitFor(() => expect(row()).toBe("Espresso Corner"));
  });

  it("refreshes the Adopted tab's rows in place on a re-seed, without re-rendering it", async () => {
    const render = vi.spyOn(AdoptedTab.prototype, "render");
    const refresh = vi.spyOn(AdoptedTab.prototype, "refresh");
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    showTab(panel, "adopted");
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    connection.emit(ENTRY_RELOADS, loaded(1));
    await flush();

    connection.emit(ENTRY_RELOADS, loaded(1));

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  describe("in the favorites view", () => {
    function favoritesOf(...panelIds: number[]): typeof favorites {
      return Object.fromEntries(panelIds.map(n => [`panel-${n}`, { circuits: [`c${n}`], sub_devices: [] }]));
    }

    /** The favorites view, built from the panels in `resolved`; any other panel's fetch failed at build time. */
    async function mountFavorites(connection: FakeConnection, resolved: number[]): Promise<ReturnType<typeof vi.spyOn>> {
      localStorage.setItem("span_panel_selected", "favorites");
      const build = vi.spyOn(FavoritesController.prototype, "build").mockResolvedValue({
        topology: { circuits: {}, sub_devices: {}, _favoriteRefs: {} },
        entryIds: [],
        awaitingPanelIds: [],
        perPanelStats: resolved.map(n => ({
          panelDeviceId: `panel-${n}`,
          panelName: `Panel ${n}`,
          topology: { circuits: {}, panel_entities: { panel_status: statusOf(`panel-${n}`) } } as unknown as PanelTopology,
        })),
      } as unknown as Awaited<ReturnType<FavoritesController["build"]>>);
      await mount(connection, () => expect(build).toHaveBeenCalledTimes(1));
      connection.emit(ENTRY_RELOADS, loaded(1, 2));
      await flush();
      return build;
    }

    it("ignores a re-seed of a panel that has no favorites, and keeps an unchanged one", async () => {
      devices = [device(1), device(2)];
      favorites = favoritesOf(1);
      const connection = new FakeConnection();
      const build = await mountFavorites(connection, [1]);
      const calls = mockDiscover.mock.calls.length;

      connection.emit(ENTRY_RELOADS, loaded(1, 2));
      await vi.waitFor(() => expect(mockDiscover.mock.calls.length).toBe(calls + 1));
      await flush();

      expect(build).toHaveBeenCalledTimes(1);
      expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), "panel-1", null);
    });

    it("checks only the panel whose device was renamed", async () => {
      devices = [device(1), device(2)];
      favorites = favoritesOf(1, 2);
      const connection = new FakeConnection();
      localStorage.setItem("span_panel_selected", "favorites");
      const build = vi.spyOn(FavoritesController.prototype, "build").mockResolvedValue({
        topology: { circuits: {}, sub_devices: {}, _favoriteRefs: {} },
        entryIds: [],
        awaitingPanelIds: [],
        perPanelStats: [1, 2].map(n => ({
          panelDeviceId: `panel-${n}`,
          panelName: `Panel ${n}`,
          topology: {
            circuits: { [`c${n}`]: { name: `Circuit ${n}`, device_id: `circuit-device-${n}-c${n}`, tabs: [1], entities: {} } },
            panel_entities: { panel_status: statusOf(`panel-${n}`) },
            panel_device_id: `panel-${n}`,
          } as unknown as PanelTopology,
        })),
      } as unknown as Awaited<ReturnType<FavoritesController["build"]>>);
      await mount(connection, () => expect(build).toHaveBeenCalledTimes(1));
      connection.emit(ENTRY_RELOADS, loaded(1, 2));
      await flush();
      const calls = mockDiscover.mock.calls.length;

      connection.emit(DEVICE_REGISTRY, {
        event_type: DEVICE_REGISTRY,
        data: { action: "update", device_id: "circuit-device-2-c2", changes: { name_by_user: null } },
      });

      // The re-fetched topology differs from the one the view was built from, so the view rebuilds.
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
      expect(mockDiscover.mock.calls.slice(calls).map(call => call[1])).toEqual(["panel-2"]);
    });

    it("rebuilds for a panel with favorites whose fetch failed at build time", async () => {
      devices = [device(1), device(2)];
      favorites = favoritesOf(1, 2);
      const connection = new FakeConnection();
      const build = await mountFavorites(connection, [1]);

      connection.emit(ENTRY_RELOADS, loaded(1, 2));

      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    });
  });
});

describe("span-panel, for a user who may not operate every panel's controls", () => {
  const ADMIN_ONLY_HINT = "Only an administrator can operate this panel's controls.";
  const entity = (entity_id: string, state: string) => ({ entity_id, state, attributes: {}, last_changed: "", last_updated: "" });

  /** Panel `n`'s topology: one circuit, `c<n>`, with its relay and priority, saying `control_access` where given. */
  function panelTopology(n: number, control_access?: { may_operate: boolean; reason: string | null }): Awaited<ReturnType<typeof discoverTopology>> {
    return {
      topology: {
        circuits: {
          [`c${n}`]: {
            name: `Circuit ${n}`,
            device_id: `circuit-device-${n}-c${n}`,
            tabs: [1],
            entities: { power: `sensor.c${n}_power`, switch: `switch.c${n}_breaker`, select: `select.c${n}_priority` },
            is_user_controllable: true,
            relay_state: "CLOSED",
          },
        },
        panel_entities: { panel_status: statusOf(`panel-${n}`) },
        panel_device_id: `panel-${n}`,
        ...(control_access ? { control_access } : {}),
      } as unknown as PanelTopology,
      panelSize: 32,
    };
  }

  /** Drag a slider's knob to its end, as a user arms the switches; the layout is given, which happy-dom has none of. */
  function arm(slide: HTMLElement): void {
    const knob = slide.querySelector<HTMLElement>(".slide-confirm-knob")!;
    Object.defineProperty(slide, "offsetWidth", { configurable: true, get: () => 160 });
    Object.defineProperty(knob, "offsetWidth", { configurable: true, get: () => 24 });
    Object.defineProperty(knob, "offsetLeft", { configurable: true, get: () => Number.parseFloat(knob.style.left || "2") });
    knob.dispatchEvent(new MouseEvent("mousedown", { clientX: 2, bubbles: true }));
    slide.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, bubbles: true }));
    slide.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }

  it("gives a circuit side panel open on the By Panel tab the access a re-seed brings, the tab drawn over only once it closes", async () => {
    // The real By Panel tab, its intervals stubbed so none outlives the test.
    vi.mocked(DashboardTab.prototype.render).mockRestore();
    states = { "switch.c1_breaker": entity("switch.c1_breaker", "on") };
    vi.spyOn(DashboardController.prototype, "startIntervals").mockImplementation(() => {});
    mockDiscover.mockImplementation(async () => panelTopology(1));
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    const content = panel.shadowRoot!.getElementById("tab-content")!;
    await vi.waitFor(() => expect(content.querySelector(".panel-grid")).not.toBeNull());
    connection.emit(ENTRY_RELOADS, loaded(1));
    await flush();
    const render = vi.spyOn(DashboardTab.prototype, "render");

    const sidePanel = content.querySelector("span-side-panel") as HTMLElement & {
      hass: HomeAssistant;
      errorStore: ErrorStore;
      open(config: unknown): void;
      close(): void;
    };
    // As the circuit's gear opens it: with Home Assistant, and the dashboard's error store.
    sidePanel.hass = panel.hass;
    sidePanel.errorStore = (panel as unknown as { _errorStore: ErrorStore })._errorStore;
    sidePanel.open({
      uuid: "c1",
      name: "Circuit 1",
      members: [{ uuid: "c1", circuit: panelTopology(1).topology!.circuits.c1 }],
      capacityA: null,
      entities: { power: "sensor.c1_power", select: "select.c1_priority" },
      monitoringInfo: null,
      graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
      configEntryId: "entry-1",
      controlAccess: { mayOperate: true, reason: null },
    });
    const priority = sidePanel.shadowRoot!.querySelector<HTMLSelectElement>('[data-role="shedding-select"]')!;
    expect(priority.title).toBe("");
    mockDiscover.mockImplementation(async () => panelTopology(1, { may_operate: false, reason: "admin_only" }));

    connection.emit(ENTRY_RELOADS, loaded(1));

    await vi.waitFor(() => expect(priority.title).toBe(ADMIN_ONLY_HINT));
    expect(sidePanel.shadowRoot!.querySelector('[data-role="controls-note"]')!.textContent).toBe(ADMIN_ONLY_HINT);
    expect(render).not.toHaveBeenCalled();

    sidePanel.close();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(content.querySelector(".toggle-pill.toggle-forbidden")).not.toBeNull());
  });

  it("draws a Favorites view of two panels with each circuit's toggle as its own panel allows, the slider armable, and why under the other panel's name", async () => {
    devices = [device(1), device(2)];
    favorites = { "panel-1": { circuits: ["c1"], sub_devices: [] }, "panel-2": { circuits: ["c2"], sub_devices: [] } };
    states = { "switch.c1_breaker": entity("switch.c1_breaker", "on"), "switch.c2_breaker": entity("switch.c2_breaker", "on") };
    mockDiscover.mockImplementation(async (_hass, deviceId) =>
      deviceId === "panel-1" ? panelTopology(1, { may_operate: false, reason: "admin_only" }) : panelTopology(2, { may_operate: true, reason: null })
    );
    vi.spyOn(DashboardController.prototype, "startIntervals").mockImplementation(() => {});
    localStorage.setItem("span_panel_selected", "favorites");
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(mockDiscover).toHaveBeenCalledTimes(2));
    const content = panel.shadowRoot!.getElementById("tab-content")!;
    await vi.waitFor(() => expect(content.querySelectorAll(".list-row .toggle-pill")).toHaveLength(2));

    const pill = (circuit: string): HTMLElement => content.querySelector<HTMLElement>(`.list-row[data-row-uuid="${circuit}"] .toggle-pill`)!;
    expect(pill("panel-1|c1").classList.contains("toggle-forbidden")).toBe(true);
    expect(pill("panel-1|c1").title).toBe(ADMIN_ONLY_HINT);
    expect(pill("panel-2|c2").classList.contains("toggle-forbidden")).toBe(false);
    const slide = content.querySelector<HTMLElement>(".favorites-summary .slide-confirm")!;
    expect(slide.classList.contains("slide-confirm-forbidden")).toBe(false);
    expect(content.querySelector('.favorites-summary [data-role="controls-note"]')).toBeNull();

    // Under its own name in the stats grid, the panel the user may not operate says why, and the other says nothing.
    const card = (panelId: string): Element => content.querySelector(`.panel-stats[data-stats-panel-id="${panelId}"]`)!.closest(".favorites-panel-card")!;
    expect(card("panel-1").querySelector('[data-role="controls-note"]')!.textContent).toBe(ADMIN_ONLY_HINT);
    expect(card("panel-2").querySelector('[data-role="controls-note"]')).toBeNull();

    arm(slide);
    pill("panel-1|c1").click();
    pill("panel-1|c1").click();
    pill("panel-2|c2").click();
    await flush();

    expect(controlSends.map(msg => [msg.service, (msg.target as { entity_id: string }).entity_id])).toEqual([["turn_off", "switch.c2_breaker"]]);
    // The taps on the forbidden toggle put why in the banner once, as a transient warning.
    const errors = (panel as unknown as { _errorStore: ErrorStore })._errorStore;
    expect(errors.active.filter(entry => !entry.persistent).map(entry => [entry.key, entry.level, entry.message])).toEqual([
      ["service:relay", "warning", ADMIN_ONLY_HINT],
    ]);
  });
});
