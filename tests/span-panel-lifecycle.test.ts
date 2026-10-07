import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Storage } from "happy-dom";
import type { HomeAssistant, PanelDevice, PanelTopology } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";
import { FavoritesController } from "../src/core/favorites-controller.js";
import { DashboardTab } from "../src/panel/tab-dashboard.js";
import "../src/panel/span-panel.js";
import { ENTITY_REGISTRY, ENTRY_RELOADS, FakeConnection, flush, hassWith } from "./fake-connection.js";

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

function statusOf(deviceId: string): string {
  return `binary_sensor.${deviceId.replace("-", "_")}_status`;
}

let devices: PanelDevice[] = [];
let favorites: Record<string, { circuits: string[]; sub_devices: string[] }> = {};
let deviceListCalls = 0;

function hassFor(connection: FakeConnection): HomeAssistant {
  return hassWith(connection, {
    callWS: (async (msg: Record<string, unknown>) => {
      if (msg.type === "config/device_registry/list") {
        deviceListCalls += 1;
        return devices;
      }
      if (msg.type === "call_service" && msg.service === "get_favorites") return { response: { favorites } };
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
  watch = vi.spyOn(ErrorStore.prototype, "watchPanelStatus");
  watchMany = vi.spyOn(ErrorStore.prototype, "watchPanelStatuses");
  vi.spyOn(DashboardTab.prototype, "render").mockResolvedValue(undefined);
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
});
