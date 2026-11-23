import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { CardConfig, HomeAssistant, PanelTopology } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";
import "../src/card/span-panel-card.js";
import { DEVICE_REGISTRY, ENTITY_REGISTRY, ENTRY_RELOADS, FakeConnection, flush, hassWith } from "./fake-connection.js";

/**
 * Lovelace detaches and re-attaches a cached card on every view switch, and the
 * editor preview calls `setConfig` on a connected card on every edit. Each
 * subscription is held as the promise it was handed, so exactly one of each is
 * live however those calls interleave with the subscribes resolving.
 */

const mockDiscover = vi.mocked(discoverTopology);
type Card = HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };

const SWITCH = "switch.kitchen_breaker";
const STATUS = "binary_sensor.span_panel_status";
/** The kitchen circuit's own device, which its label is read from. */
const KITCHEN_DEVICE = "device-kitchen";

function topology(withSwitch: boolean): PanelTopology {
  return {
    circuits: {
      kitchen: {
        name: "Kitchen",
        device_id: KITCHEN_DEVICE,
        tabs: [1],
        entities: withSwitch ? { power: "sensor.kitchen_power", switch: SWITCH } : { power: "sensor.kitchen_power" },
        is_user_controllable: true,
        relay_state: "CLOSED",
      },
    },
    panel_entities: { panel_status: STATUS },
    panel_size: 32,
    panel_device_id: "panel-1",
    config_entry_id: "entry-1",
  } as unknown as PanelTopology;
}

/** Home Assistant for `user`, of whom the frontend says nothing unless given one. */
function hassFor(connection: FakeConnection, user?: HomeAssistant["user"]): HomeAssistant {
  const state = (entity_id: string, s: string) => ({ entity_id, state: s, attributes: {}, last_changed: "", last_updated: "" });
  return hassWith(connection, {
    user,
    states: { [SWITCH]: state(SWITCH, "on"), "sensor.kitchen_power": state("sensor.kitchen_power", "120"), [STATUS]: state(STATUS, "on") },
    callWS: (async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "config/area_registry/list":
          return [{ area_id: "kitchen", name: "Kitchen Area" }];
        case "config/entity_registry/list":
          return [{ entity_id: "sensor.kitchen_power", area_id: "kitchen" }];
        case "config/device_registry/list":
          return [];
        default:
          return {};
      }
    }) as HomeAssistant["callWS"],
  });
}

const mounted: HTMLElement[] = [];
let watch: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  watch = vi.spyOn(ErrorStore.prototype, "watchPanelStatus");
  mockDiscover.mockImplementation(async () => ({ topology: topology(true), panelSize: 32 }));
});

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
  mockDiscover.mockReset();
});

async function mount(connection: FakeConnection, user?: HomeAssistant["user"]): Promise<Card> {
  const card = document.createElement("span-panel-card") as Card;
  card.setConfig({ device_id: "panel-1" } as CardConfig);
  document.body.appendChild(card);
  mounted.push(card);
  card.hass = hassFor(connection, user);
  await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
  await flush();
  return card;
}

/** A `device_registry_updated` event for an update, with the old value of each field it changed. */
function deviceUpdate(device_id: string, changes: Record<string, unknown>): unknown {
  return { event_type: DEVICE_REGISTRY, data: { action: "update", device_id, changes } };
}

function renamedKitchen(): PanelTopology {
  const renamed = topology(true);
  renamed.circuits.kitchen!.name = "Cooking";
  return renamed;
}

function reload(connection: FakeConnection): void {
  connection.emit(ENTRY_RELOADS, [{ type: null, entry: { entry_id: "entry-1", domain: "span_panel", state: "loaded" } }]);
  connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: "entry-1", domain: "span_panel", state: "setup_in_progress" } }]);
  connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: "entry-1", domain: "span_panel", state: "loaded" } }]);
}

describe("span-panel-card subscriptions", () => {
  it("re-attach restores exactly one of each, and watches the panel status again", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    watch.mockClear();

    card.remove();
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
    expect(connection.live(ENTITY_REGISTRY)).toBe(0);

    document.body.appendChild(card);
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
    expect(connection.live(ENTITY_REGISTRY)).toBe(1);
    expect(watch).toHaveBeenCalledWith(STATUS);
  });

  it("subscribes nothing while detached during first discovery, and one of each on re-attach", async () => {
    const connection = new FakeConnection();
    let resolve: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolve = r)));
    const card = document.createElement("span-panel-card") as Card;
    card.setConfig({ device_id: "panel-1" } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);
    card.hass = hassFor(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalled());

    card.remove();
    resolve({ topology: topology(true), panelSize: 32 });
    await flush();
    expect(connection.subscriptions).toHaveLength(0);

    document.body.appendChild(card);
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
    expect(connection.live(ENTITY_REGISTRY)).toBe(1);
  });

  it("survives a detach and re-attach before the subscribes resolve", async () => {
    const connection = new FakeConnection();
    connection.hold = true;
    const card = await mount(connection);
    const first = connection.subscriptions.find(s => s.key === ENTRY_RELOADS)!;

    card.remove();
    document.body.appendChild(card);
    connection.release();
    await flush();
    connection.release();
    await flush();

    expect(connection.live(ENTRY_RELOADS)).toBe(1);
    expect(connection.live(ENTITY_REGISTRY)).toBe(1);
    expect(first.unsubscribed).toBe(true);
  });

  it("re-fetches on re-attach once the new subscription's first batch reports the entry loaded", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const seed = [{ type: null, entry: { entry_id: "entry-1", domain: "span_panel", state: "loaded" } }];
    // On first attach the first batch only seeds.
    connection.emit(ENTRY_RELOADS, seed);
    await flush();
    expect(mockDiscover).toHaveBeenCalledTimes(1);

    card.remove();
    document.body.appendChild(card);
    await flush();
    connection.emit(ENTRY_RELOADS, seed);

    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));
  });

  it("detaches in setConfig even when no discovery follows", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);

    card.setConfig({ device_id: "" } as CardConfig);
    await flush();

    expect(connection.live(ENTRY_RELOADS)).toBe(0);
    expect(connection.live(ENTITY_REGISTRY)).toBe(0);
  });

  it("does not stack subscriptions when the editor preview calls setConfig on a connected card", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);

    card.setConfig({ device_id: "panel-1" } as CardConfig);
    card.hass = hassFor(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));
    await flush();

    expect(connection.live(ENTRY_RELOADS)).toBe(1);
    expect(connection.live(ENTITY_REGISTRY)).toBe(1);
  });

  it("re-fetches when its entry finishes loading, adds no subscription, and follows areas on the new topology", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    expect(card.shadowRoot!.querySelector(".toggle-pill")).not.toBeNull();
    const refetched = topology(false);
    mockDiscover.mockImplementation(async () => ({ topology: refetched, panelSize: 32 }));

    reload(connection);
    await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".toggle-pill")).toBeNull());
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
    expect(connection.live(ENTITY_REGISTRY)).toBe(1);

    connection.emit(ENTITY_REGISTRY, {});
    await vi.waitFor(() => expect(refetched.circuits.kitchen?.area).toBe("Kitchen Area"));
  });

  it("does not re-render, or re-lock the switches, for a refresh whose topology is unchanged", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const grid = card.shadowRoot!.querySelector(".panel-grid");
    const shell = card.shadowRoot!.querySelector(".span-card")!;
    shell.classList.remove("switches-disabled");

    reload(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));
    await flush();

    expect(card.shadowRoot!.querySelector(".panel-grid")).toBe(grid);
    expect(shell.classList.contains("switches-disabled")).toBe(false);
  });

  it("re-renders a refresh whose topology changed", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const grid = card.shadowRoot!.querySelector(".panel-grid");
    mockDiscover.mockImplementation(async () => ({ topology: topology(false), panelSize: 32 }));

    reload(connection);
    await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".panel-grid")).not.toBe(grid));
    expect(card.shadowRoot!.querySelector(".toggle-pill")).toBeNull();
  });

  it("adopts a refresh that changes only a breaker's relay state, without re-rendering or re-locking", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const grid = card.shadowRoot!.querySelector(".panel-grid");
    const shell = card.shadowRoot!.querySelector(".span-card")!;
    shell.classList.remove("switches-disabled");
    const opened = topology(true);
    opened.circuits.kitchen!.relay_state = "OPEN";
    mockDiscover.mockImplementation(async () => ({ topology: opened, panelSize: 32 }));

    reload(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));
    await flush();

    expect(card.shadowRoot!.querySelector(".panel-grid")).toBe(grid);
    expect(shell.classList.contains("switches-disabled")).toBe(false);
    // The card's topology now carries it, as the relay's last-resort fallback.
    expect((card as unknown as { _topology: PanelTopology })._topology.circuits.kitchen?.relay_state).toBe("OPEN");
    // And so does the controller, which the toggle and the live updater read.
    expect((card as unknown as { _ctrl: DashboardController })._ctrl.topology?.circuits.kitchen?.relay_state).toBe("OPEN");
  });

  it("re-renders a refresh that changes structure along with a relay state", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const grid = card.shadowRoot!.querySelector(".panel-grid");
    const changed = topology(false);
    changed.circuits.kitchen!.relay_state = "OPEN";
    mockDiscover.mockImplementation(async () => ({ topology: changed, panelSize: 32 }));

    reload(connection);
    await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".panel-grid")).not.toBe(grid));
    expect(card.shadowRoot!.querySelector(".toggle-pill")).toBeNull();
  });

  it("drops a refresh that straddles a setConfig to another panel", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    let resolveStale: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveStale = r)));
    reload(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));

    const other = topology(true);
    other.circuits.kitchen!.name = "Garage";
    mockDiscover.mockImplementation(async () => ({ topology: other, panelSize: 32 }));
    card.setConfig({ device_id: "panel-2" } as CardConfig);
    card.hass = hassFor(connection);
    await vi.waitFor(() => expect(card.shadowRoot!.textContent).toContain("Garage"));

    const stale = topology(true);
    stale.circuits.kitchen!.name = "Stale";
    resolveStale({ topology: stale, panelSize: 32 });
    await flush();

    expect(card.shadowRoot!.textContent).toContain("Garage");
    expect(card.shadowRoot!.textContent).not.toContain("Stale");
  });

  it("drops a refresh that straddles a detach", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    let resolveStale: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveStale = r)));
    reload(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));

    card.remove();
    resolveStale({ topology: topology(false), panelSize: 32 });
    await flush();

    expect(card.shadowRoot!.querySelector(".toggle-pill")).not.toBeNull();
  });

  it("refreshes an admin's card from panel_topology in one attempt, and keeps its topology when that fails", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    const add = vi.spyOn(ErrorStore.prototype, "add");
    mockDiscover.mockRejectedValue({ code: "unknown_error", message: "not loaded" });

    reload(connection);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));
    await flush();

    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), "panel-1", null);
    expect(add).not.toHaveBeenCalled();
    // A kept topology renders the next view; a nulled one would leave the grid in place.
    card.shadowRoot!.querySelector<HTMLElement>('.shared-tab[data-tab="activity"]')!.click();
    expect(card.shadowRoot!.querySelector(".list-row")).not.toBeNull();
  });

  it("refreshes the card of a user who is not an administrator from panel_topology, which answers every user, in one attempt", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection, { is_admin: false });
    const add = vi.spyOn(ErrorStore.prototype, "add");
    mockDiscover.mockImplementation(async () => ({ topology: topology(false), panelSize: 32 }));

    reload(connection);
    await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".toggle-pill")).toBeNull());

    expect(mockDiscover).toHaveBeenCalledTimes(2);
    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), "panel-1", null);
    expect(add).not.toHaveBeenCalled();
  });
});

/**
 * A circuit is labelled by its device, which the user renames in Home Assistant
 * with no reload of the panel's entry. The device registry's event is the only
 * word of it, so the card re-fetches on it.
 */
describe("span-panel-card device renames", () => {
  it("relabels a showing card when a circuit's device is renamed", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    expect(card.shadowRoot!.textContent).not.toContain("Cooking");
    mockDiscover.mockImplementation(async () => ({ topology: renamedKitchen(), panelSize: 32 }));

    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: null }));

    await vi.waitFor(() => expect(card.shadowRoot!.textContent).toContain("Cooking"));
    expect(mockDiscover).toHaveBeenCalledTimes(2);
    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), "panel-1", null);
  });

  it("relabels the card of a user who is not an administrator from panel_topology", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection, { is_admin: false });
    mockDiscover.mockImplementation(async () => ({ topology: renamedKitchen(), panelSize: 32 }));

    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: null }));

    await vi.waitFor(() => expect(card.shadowRoot!.textContent).toContain("Cooking"));
    expect(mockDiscover).toHaveBeenCalledTimes(2);
    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), "panel-1", null);
  });

  it("does not re-fetch for a device change that is no rename of a device it shows", async () => {
    const connection = new FakeConnection();
    await mount(connection);

    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { area_id: null }));
    connection.emit(DEVICE_REGISTRY, deviceUpdate("device-of-another-panel", { name_by_user: null }));
    connection.emit(DEVICE_REGISTRY, { event_type: DEVICE_REGISTRY, data: { action: "create", device_id: KITCHEN_DEVICE } });
    await flush();

    expect(mockDiscover).toHaveBeenCalledTimes(1);
  });

  it("answers a burst of renames with one fetch in flight and one more after it", async () => {
    const connection = new FakeConnection();
    await mount(connection);
    let resolveFirst: (value: Awaited<ReturnType<typeof discoverTopology>>) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveFirst = r)));

    for (let i = 0; i < 3; i += 1) connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name: "Kitchen" }));
    await flush();
    expect(mockDiscover).toHaveBeenCalledTimes(2);

    resolveFirst({ topology: topology(true), panelSize: 32 });
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(3));
    await flush();
    expect(mockDiscover).toHaveBeenCalledTimes(3);
  });

  it("listens for renames once across a detach and re-attach", async () => {
    const connection = new FakeConnection();
    const card = await mount(connection);
    // Two listen to the device registry: this one, and the area subscription.
    expect(connection.live(DEVICE_REGISTRY)).toBe(2);

    card.remove();
    await flush();
    expect(connection.live(DEVICE_REGISTRY)).toBe(0);

    document.body.appendChild(card);
    await flush();
    expect(connection.live(DEVICE_REGISTRY)).toBe(2);
    mockDiscover.mockClear();
    connection.emit(DEVICE_REGISTRY, deviceUpdate(KITCHEN_DEVICE, { name_by_user: null }));
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(1));
    await flush();
    expect(mockDiscover).toHaveBeenCalledTimes(1);
  });
});
