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
 * The sidebar dashboard is detached and re-attached as the user navigates. On
 * re-attach it must watch its panel's status again and keep exactly one reload
 * subscription; a re-seed reporting many loaded panels refreshes the panel list once.
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

function hassFor(connection: FakeConnection): HomeAssistant {
  return hassWith(connection, {
    callWS: (async (msg: Record<string, unknown>) => {
      if (msg.type === "config/device_registry/list") {
        deviceListCalls += 1;
        return devices;
      }
      if (msg.type === "config_entries/get" && msg.domain === "span_panel") return SPAN_ENTRIES;
      if (msg.type === "call_service" && msg.service === "get_favorites") return { response: { favorites } };
      if (msg.type === "call_service" && msg.service === "get_monitoring_status" && monitoring) return { response: monitoring };
      return {};
    }) as HomeAssistant["callWS"],
  });
}

const mounted: HTMLElement[] = [];
let watch: ReturnType<typeof vi.spyOn>;
let watchMany: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Node 25+ defines its own `localStorage`, undefined without
  // `--localstorage-file`, and it shadows happy-dom's; the element reads it.
  vi.stubGlobal("localStorage", new Storage());
  localStorage.clear();
  devices = [device(1)];
  favorites = {};
  deviceListCalls = 0;
  monitoring = null;
  watch = vi.spyOn(ErrorStore.prototype, "watchPanelStatus");
  watchMany = vi.spyOn(ErrorStore.prototype, "watchPanelStatuses");
  vi.spyOn(DashboardTab.prototype, "render").mockResolvedValue(null);
  mockDiscover.mockImplementation(async (_hass, deviceId) => ({
    topology: { circuits: {}, panel_entities: { panel_status: statusOf(String(deviceId)) } } as unknown as PanelTopology,
    panelDevice: null,
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
  it("re-watches a real panel's status on re-attach, with one reload subscription", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    watch.mockClear();

    panel.remove();
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
    document.body.appendChild(panel);

    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
  });

  it("re-applies the favorites view's watch on re-attach", async () => {
    favorites = { "panel-1": { circuits: ["c1"], sub_devices: [] } };
    localStorage.setItem("span_panel_selected", "favorites");
    const panelTopology = { circuits: {}, panel_entities: { panel_status: statusOf("panel-1") } } as unknown as PanelTopology;
    vi.spyOn(FavoritesController.prototype, "build").mockResolvedValue({
      topology: { circuits: {}, sub_devices: {}, _favoriteRefs: {} },
      entryIds: [],
      perPanelStats: [{ panelDeviceId: "panel-1", panelName: "Panel 1", topology: panelTopology }],
    } as unknown as Awaited<ReturnType<FavoritesController["build"]>>);
    const expected = [{ entityId: statusOf("panel-1"), panelName: "Panel 1" }];
    const panel = await mount(new FakeConnection(), () => expect(watchMany).toHaveBeenLastCalledWith(expected));
    watchMany.mockClear();

    panel.remove();
    document.body.appendChild(panel);

    await vi.waitFor(() => expect(watchMany).toHaveBeenLastCalledWith(expected));
  });

  it("subscribes reloads once when an element connected without hass receives it", async () => {
    const connection = new FakeConnection();
    const panel = document.createElement("span-panel") as Panel;
    document.body.appendChild(panel);
    mounted.push(panel);
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);

    panel.hass = hassFor(connection);
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
    panel.hass = hassFor(connection);
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
  });

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

  it("keeps exactly one area subscription across a fast detach and re-attach on the area tab (re-review S1)", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection, () => expect(watch).toHaveBeenCalledWith(statusOf("panel-1")));
    connection.hold = true;
    (panel as unknown as { _activeTab: string })._activeTab = "area";
    await vi.waitFor(() => expect(connection.live(ENTITY_REGISTRY)).toBe(1));
    const first = connection.subscriptions.find(s => s.key === ENTITY_REGISTRY)!;

    // Detach while the area subscribe is still pending, and re-attach at once.
    panel.remove();
    document.body.appendChild(panel);
    connection.release();
    await flush();
    connection.release();
    await flush();

    expect(first.unsubscribed).toBe(true);
    expect(connection.live(ENTITY_REGISTRY)).toBe(1);
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
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
    resolveArea({ topology: { circuits: {}, panel_entities: {} } as unknown as PanelTopology, panelDevice: null, panelSize: 32 });
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
      panelDevice: null,
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
