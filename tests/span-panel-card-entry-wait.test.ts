import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { CardConfig, HomeAssistant, PanelTopology } from "../src/types.js";
import type { DeviceRegistryEntry } from "../src/core/registry-types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import "../src/card/span-panel-card.js";
import { ENTRY_RELOADS, FakeConnection, flush, hassWith } from "./fake-connection.js";
import { PANEL, SECOND_PANEL, SECOND_SPAN_ENTRY, SPAN_ENTRY } from "./hass-registries.js";

/**
 * Until the panel's config entry has loaded, `panel_topology` gives no
 * topology: the integration answers `not_loaded` while Home Assistant starts,
 * while setup retries a panel it cannot reach, and during a reload; Home
 * Assistant answers `unknown_command` before the integration has registered
 * it; and a lost connection rejects the call. A card that asks then says it is
 * waiting, with no error, and asks again once the entry has loaded. Any other
 * failure is final until Retry or a new config.
 */

const mockDiscover = vi.mocked(discoverTopology);
type Card = HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };
type Discovered = Awaited<ReturnType<typeof discoverTopology>>;

const NOT_LOADED = { code: "not_loaded", message: "SPAN Panel integration is not loaded" };
const UNKNOWN_COMMAND = { code: "unknown_command", message: "Unknown command." };
/** What home-assistant-js-websocket 9.8.0 rejects a command with when the connection is lost. */
const CONNECTION_LOST_RESULT = { type: "result", success: false, error: { code: 3, message: "Connection lost" } };
const WAITING = "Waiting for SPAN Panel to load...";
const CONNECTING = "Connecting to SPAN Panel...";
const FAILED = "Unable to connect to SPAN Panel";
/** A device id saved before Home Assistant 2026.8, which the device list no longer holds; the integration still answers it. */
const OLD_PANEL_ID = "panel-before-2026-8";

function topology(name = "Kitchen"): PanelTopology {
  return {
    circuits: {
      kitchen: { name, tabs: [1], entities: { power: "sensor.kitchen_power" }, is_user_controllable: true, relay_state: "CLOSED" },
    },
    panel_size: 32,
    panel_device_id: PANEL.id,
    config_entry_id: SPAN_ENTRY,
  } as unknown as PanelTopology;
}

function found(name = "Kitchen"): Discovered {
  return { topology: topology(name), panelSize: 32 };
}

/** One config entry change, as `config_entries/subscribe` reports it: in a batch of the current entries where `type` is null. */
function change(entry_id: string, state: string, type: "updated" | null = null, domain = "span_panel"): unknown {
  return { type, entry: { entry_id, domain, state } };
}

/** Home Assistant whose device registry list holds `devices`, answering `panel_topology` with `topologyAnswer`. */
function hassFor(connection: FakeConnection, devices: DeviceRegistryEntry[], topologyAnswer: () => Promise<unknown> = async () => ({})): HomeAssistant {
  return hassWith(connection, {
    callWS: (async (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "config/device_registry/list":
          return structuredClone(devices);
        case "config/area_registry/list":
        case "config/entity_registry/list":
          return [];
        case "span_panel/panel_topology":
          return topologyAnswer();
        default:
          return {};
      }
    }) as HomeAssistant["callWS"],
  });
}

const mounted: HTMLElement[] = [];

async function mount(
  connection: FakeConnection,
  { deviceId = PANEL.id, devices = [PANEL, SECOND_PANEL] }: { deviceId?: string; devices?: DeviceRegistryEntry[] } = {}
): Promise<Card> {
  const card = document.createElement("span-panel-card") as Card;
  card.setConfig({ device_id: deviceId } as CardConfig);
  document.body.appendChild(card);
  mounted.push(card);
  card.hass = hassFor(connection, devices);
  return card;
}

/** Mount a card whose first discovery is refused as not loaded, and wait for it to start waiting. */
async function mountWaiting(connection: FakeConnection, options: { deviceId?: string; devices?: DeviceRegistryEntry[] } = {}): Promise<Card> {
  const card = await mount(connection, options);
  await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
  await flush();
  return card;
}

function text(card: Card): string {
  return card.shadowRoot!.textContent ?? "";
}

function banner(card: Card): ShadowRoot | null {
  return card.shadowRoot!.querySelector("span-error-banner")?.shadowRoot ?? null;
}

function bannerMessages(card: Card): string[] {
  return [...(banner(card)?.querySelectorAll(".banner-row .message") ?? [])].map(el => el.textContent ?? "");
}

function grid(card: Card): Element | null {
  return card.shadowRoot!.querySelector(".panel-grid");
}

function retry(card: Card): void {
  banner(card)!.querySelector<HTMLButtonElement>(".retry-btn")!.click();
}

/** Hand the card Home Assistant again, as the frontend does on every state change, `times` times. */
async function updateHass(card: Card, connection: FakeConnection, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    card.hass = hassFor(connection, [PANEL, SECOND_PANEL]);
    await flush();
  }
}

beforeEach(() => {
  mockDiscover.mockRejectedValueOnce(NOT_LOADED).mockResolvedValue(found());
});

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
  mockDiscover.mockReset();
});

describe("span-panel-card waiting for its panel's entry to load", () => {
  it("says it is waiting, with no error, where panel_topology answers not_loaded, while the panel's entry is set up, retried or reloaded", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValue(NOT_LOADED);
    const connection = new FakeConnection();

    const card = await mountWaiting(connection);

    await vi.waitFor(() => expect(text(card)).toContain(WAITING));
    expect(text(card)).not.toContain(CONNECTING);
    expect(bannerMessages(card)).toEqual([]);
    expect(card.shadowRoot!.querySelector('[role="status"]')?.textContent?.trim()).toBe(WAITING);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
  });

  it("asks panel_topology once and spends no retries on an entry that has not loaded", async () => {
    const actual = await vi.importActual<typeof import("../src/card/card-discovery.js")>("../src/card/card-discovery.js");
    mockDiscover.mockReset();
    mockDiscover.mockImplementation(actual.discoverTopology);
    let asked = 0;
    const connection = new FakeConnection();
    const card = document.createElement("span-panel-card") as Card;
    card.setConfig({ device_id: PANEL.id } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);

    card.hass = hassFor(connection, [PANEL], async () => {
      asked += 1;
      throw NOT_LOADED;
    });

    // Well inside the first retry's one-second wait.
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1), { timeout: 500 });
    expect(asked).toBe(1);
    await vi.waitFor(() => expect(text(card)).toContain(WAITING));
    expect(bannerMessages(card)).toEqual([]);
  });

  it("asks again once the panel's entry finishes loading, draws the panel, and ends the wait", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    const wait = connection.subscriptions.find(s => s.key === ENTRY_RELOADS)!;
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_retry"), change(SECOND_SPAN_ENTRY, "loaded")]);
    await flush();
    expect(mockDiscover).toHaveBeenCalledTimes(1);

    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded", "updated")]);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(mockDiscover).toHaveBeenCalledTimes(2);
    expect(text(card)).not.toContain(WAITING);
    expect(wait.unsubscribed).toBe(true);
    // The card's own reload subscription, which a discovered card holds.
    expect(connection.live(ENTRY_RELOADS)).toBe(1);
  });

  it("asks again at once where the panel's entry is already loaded in the subscription's first batch", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);

    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(mockDiscover).toHaveBeenCalledTimes(2);
  });

  it("waits for the entry the device list says owns the panel, not another panel's", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_retry"), change(SECOND_SPAN_ENTRY, "setup_retry")]);

    connection.emit(ENTRY_RELOADS, [change(SECOND_SPAN_ENTRY, "loaded", "updated")]);
    await flush();

    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(text(card)).toContain(WAITING);
  });

  it("takes the load of any of the integration's entries for a device id from before 2026.8, which the device list does not hold", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection, { deviceId: OLD_PANEL_ID });
    // An entry of another integration is no SPAN panel's, loaded or not.
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_retry"), change("hue-entry-1", "loaded", null, "hue")]);
    await flush();
    expect(mockDiscover).toHaveBeenCalledTimes(1);

    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded", "updated")]);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), OLD_PANEL_ID, expect.anything());
  });

  it("asks once more, on the one subscription, where another panel's entry is already loaded and the panel's is not", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValue(NOT_LOADED);
    const connection = new FakeConnection();
    const card = await mountWaiting(connection, { deviceId: OLD_PANEL_ID });

    connection.emit(ENTRY_RELOADS, [change(SECOND_SPAN_ENTRY, "loaded"), change("span-entry-3", "loaded"), change(SPAN_ENTRY, "setup_retry")]);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));
    await flush();
    await flush();

    // One ask for the two loaded entries, and no subscription after it to report them again.
    expect(mockDiscover).toHaveBeenCalledTimes(2);
    expect(connection.subscriptions.filter(s => s.key === ENTRY_RELOADS)).toHaveLength(1);
    expect(text(card)).toContain(WAITING);

    mockDiscover.mockResolvedValue(found());
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded", "updated")]);
    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
  });

  it("keeps the discovery-failed error and its Retry for any other refusal, and does not wait", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce({ code: "not_span_panel", message: "Device is not a SPAN Panel device" }).mockResolvedValue(found());
    const connection = new FakeConnection();
    const card = await mount(connection);

    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
    expect(text(card)).not.toContain(WAITING);
    expect(text(card)).not.toContain(CONNECTING);
    expect(connection.live(ENTRY_RELOADS)).toBe(0);

    retry(card);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(mockDiscover).toHaveBeenCalledTimes(2);
  });

  it("ends the wait with the discovery-failed error where the next ask is refused otherwise", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce(NOT_LOADED).mockRejectedValue({ code: "device_not_found", message: "Device not found" });
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    const wait = connection.subscriptions.find(s => s.key === ENTRY_RELOADS)!;

    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);

    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
    expect(banner(card)!.querySelector(".retry-btn")).not.toBeNull();
    expect(text(card)).not.toContain(WAITING);
    expect(wait.unsubscribed).toBe(true);
  });

  it("unsubscribes the wait when detached, and waits again on re-attach, taking an entry that loaded meanwhile", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);

    card.remove();
    await flush();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
    expect(mockDiscover).toHaveBeenCalledTimes(1);

    document.body.appendChild(card);
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
    expect(connection.subscriptions.filter(s => s.key === ENTRY_RELOADS)).toHaveLength(2);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
  });

  it("ignores a load reported to a wait already torn down", async () => {
    const connection = new FakeConnection();
    connection.hold = true;
    const card = await mount(connection);
    await vi.waitFor(() => expect(connection.subscriptions.filter(s => s.key === ENTRY_RELOADS)).toHaveLength(1));
    const wait = connection.subscriptions.find(s => s.key === ENTRY_RELOADS)!;

    card.remove();
    connection.release();
    await flush();
    wait.callback([change(SPAN_ENTRY, "loaded")]);
    await flush();

    expect(wait.unsubscribed).toBe(true);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
  });

  it("drops the wait on setConfig to another panel, and discovers that panel", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    const wait = connection.subscriptions.find(s => s.key === ENTRY_RELOADS)!;
    mockDiscover.mockResolvedValue(found("Garage"));

    card.setConfig({ device_id: SECOND_PANEL.id } as CardConfig);
    card.hass = hassFor(connection, [PANEL, SECOND_PANEL]);

    await vi.waitFor(() => expect(text(card)).toContain("Garage"));
    expect(wait.unsubscribed).toBe(true);
    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), SECOND_PANEL.id, expect.anything());
    const asked = mockDiscover.mock.calls.length;
    wait.callback([change(SPAN_ENTRY, "loaded")]);
    await flush();
    expect(mockDiscover.mock.calls.length).toBe(asked);
  });

  it("drops an ask on the entry's load that straddles a setConfig to another panel", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    let resolveStale: (value: Discovered) => void = () => {};
    mockDiscover.mockImplementationOnce(() => new Promise(r => (resolveStale = r)));
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);
    await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));

    mockDiscover.mockResolvedValue(found("Garage"));
    card.setConfig({ device_id: SECOND_PANEL.id } as CardConfig);
    card.hass = hassFor(connection, [PANEL, SECOND_PANEL]);
    await vi.waitFor(() => expect(text(card)).toContain("Garage"));

    resolveStale(found("Stale"));
    await flush();

    expect(text(card)).toContain("Garage");
    expect(text(card)).not.toContain("Stale");
  });

  it("re-fetches from panel_topology on a later reload of the entry it waited for", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);
    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    await flush();
    mockDiscover.mockResolvedValue(found("Cooking"));

    // The card's own reload subscription: its first batch seeds, a reload then reports the entry loaded.
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_in_progress", "updated")]);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded", "updated")]);

    await vi.waitFor(() => expect(text(card)).toContain("Cooking"));
    expect(mockDiscover).toHaveBeenCalledTimes(3);
    expect(mockDiscover).toHaveBeenLastCalledWith(expect.anything(), PANEL.id, null);
  });

  it("waits, with no error, where Home Assistant does not know panel_topology yet, and draws the panel once the entry loads", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce(UNKNOWN_COMMAND).mockResolvedValue(found());
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    await vi.waitFor(() => expect(text(card)).toContain(WAITING));
    expect(bannerMessages(card)).toEqual([]);

    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_in_progress")]);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded", "updated")]);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(mockDiscover).toHaveBeenCalledTimes(2);
  });

  it("waits where the connection is lost mid-call, asking once, and draws the panel once the re-seed after the reconnect reports the entry loaded", async () => {
    const actual = await vi.importActual<typeof import("../src/card/card-discovery.js")>("../src/card/card-discovery.js");
    mockDiscover.mockReset();
    mockDiscover.mockImplementation(actual.discoverTopology);
    let asked = 0;
    const connection = new FakeConnection();
    const card = document.createElement("span-panel-card") as Card;
    card.setConfig({ device_id: PANEL.id } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);

    card.hass = hassFor(connection, [PANEL], async () => {
      asked += 1;
      if (asked === 1) throw CONNECTION_LOST_RESULT;
      return topology();
    });

    // Well inside the first retry's one-second wait.
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1), { timeout: 500 });
    expect(asked).toBe(1);
    await vi.waitFor(() => expect(text(card)).toContain(WAITING));
    expect(bannerMessages(card)).toEqual([]);
    // The subscription's first batch, as Home Assistant comes back up: the entry is not loaded yet.
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "not_loaded")]);
    await flush();
    expect(asked).toBe(1);

    // The library replays the subscription after the reconnect, and its first batch is a re-seed.
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(asked).toBe(2);
  });

  it("asks nothing more on hass updates after a failure, so a later answer neither draws the panel under the error nor waits behind it", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce({ code: "not_span_panel", message: "Device is not a SPAN Panel device" }).mockResolvedValue(found());
    const connection = new FakeConnection();
    const card = await mount(connection);
    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));

    await updateHass(card, connection, 3);

    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(grid(card)).toBeNull();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
    expect(bannerMessages(card)).toEqual([FAILED]);
  });

  it("clears the error and asks again on Retry, once, after hass updates that asked nothing", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce({ code: "device_not_found", message: "Device not found" }).mockResolvedValue(found());
    const connection = new FakeConnection();
    const card = await mount(connection);
    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
    await updateHass(card, connection, 2);

    retry(card);

    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    expect(mockDiscover).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([]));
  });

  it("keeps a failure across a detach and re-attach, showing the error and its Retry again", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValueOnce({ code: "device_not_found", message: "Device not found" }).mockResolvedValue(found());
    const connection = new FakeConnection();
    const card = await mount(connection);
    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));

    card.remove();
    await flush();
    document.body.appendChild(card);
    await updateHass(card, connection, 2);

    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(text(card)).not.toContain(CONNECTING);
    retry(card);
    await vi.waitFor(() => expect(grid(card)).not.toBeNull());
  });

  describe("a failure that lands while an ask on the entry's load is still in flight", () => {
    interface Settle {
      resolve: (value: Discovered) => void;
      reject: (err: unknown) => void;
    }

    /**
     * A card waits; its entry loads, so it asks again, and that ask is held in
     * flight; the entry is then removed, which fails discovery while the ask is
     * still in flight.
     */
    async function failWhileAskInFlight(connection: FakeConnection): Promise<{ card: Card; settle: Settle }> {
      let settle: Settle = { resolve: () => {}, reject: () => {} };
      mockDiscover.mockReset();
      mockDiscover.mockRejectedValueOnce(NOT_LOADED).mockImplementationOnce(() => new Promise<Discovered>((resolve, reject) => (settle = { resolve, reject })));
      const card = await mountWaiting(connection);
      connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded")]);
      await vi.waitFor(() => expect(mockDiscover).toHaveBeenCalledTimes(2));

      connection.emit(ENTRY_RELOADS, [{ type: "removed", entry: { entry_id: SPAN_ENTRY, domain: "span_panel", state: "not_loaded", disabled_by: null } }]);
      await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
      return { card, settle };
    }

    it("drops that ask, so its answer draws no panel under the error", async () => {
      const connection = new FakeConnection();
      const { card, settle } = await failWhileAskInFlight(connection);

      settle.resolve(found());
      await flush();
      await flush();

      expect(grid(card)).toBeNull();
      expect(bannerMessages(card)).toEqual([FAILED]);
      expect(connection.live(ENTRY_RELOADS)).toBe(0);
    });

    it("drops that ask, so its not_loaded starts no wait hidden behind the error, and a re-attach shows the error and its Retry again", async () => {
      const connection = new FakeConnection();
      const { card, settle } = await failWhileAskInFlight(connection);

      settle.reject(NOT_LOADED);
      await flush();
      await flush();
      expect(connection.live(ENTRY_RELOADS)).toBe(0);
      expect(bannerMessages(card)).toEqual([FAILED]);

      card.remove();
      await flush();
      document.body.appendChild(card);
      await flush();

      await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
      expect(banner(card)!.querySelector(".retry-btn")).not.toBeNull();
      expect(connection.live(ENTRY_RELOADS)).toBe(0);
    });

    it("lets Retry, pressed while that ask is still in flight, supersede it", async () => {
      const connection = new FakeConnection();
      const { card, settle } = await failWhileAskInFlight(connection);
      mockDiscover.mockResolvedValue(found("Fresh"));

      retry(card);
      await vi.waitFor(() => expect(text(card)).toContain("Fresh"));
      settle.resolve(found("Stale"));
      await flush();
      await flush();

      expect(text(card)).toContain("Fresh");
      expect(text(card)).not.toContain("Stale");
      expect(bannerMessages(card)).toEqual([]);
    });
  });
});

describe("span-panel-card, where the panel's entry failed to set up or is disabled", () => {
  const SETUP_FAILED = "SPAN Panel could not be set up. Check Settings → Devices & services.";
  const DISABLED = "This SPAN Panel is disabled. Enable it in Settings → Devices & services.";

  /** The panel's entry, as `config_entries/subscribe` reports it, with who disabled it. */
  function entryChange(state: string, type: "updated" | "removed" | null = null, disabled_by: string | null = null): unknown {
    return { type, entry: { entry_id: SPAN_ENTRY, domain: "span_panel", state, disabled_by } };
  }

  function alertLine(card: Card): string | null {
    return card.shadowRoot!.querySelector('[role="alert"]')?.textContent?.trim() ?? null;
  }

  it.each([
    ["setup_error", "setup_error", null, SETUP_FAILED],
    ["migration_error", "migration_error", null, SETUP_FAILED],
    ["failed_unload", "failed_unload", null, SETUP_FAILED],
    ["disabled", "not_loaded", "user", DISABLED],
  ])(
    "says so, and where to look, where the entry is %s, waits again as it is set up again, and draws the panel once it loads",
    async (_name, state, disabledBy, said) => {
      const connection = new FakeConnection();
      const card = await mountWaiting(connection);

      connection.emit(ENTRY_RELOADS, [entryChange(state, null, disabledBy)]);

      await vi.waitFor(() => expect(alertLine(card)).toBe(said));
      expect(text(card)).not.toContain(WAITING);
      expect(bannerMessages(card)).toEqual([]);
      expect(mockDiscover).toHaveBeenCalledTimes(1);

      connection.emit(ENTRY_RELOADS, [entryChange("setup_in_progress", "updated")]);
      await vi.waitFor(() => expect(text(card)).toContain(WAITING));
      expect(alertLine(card)).toBeNull();

      connection.emit(ENTRY_RELOADS, [entryChange("loaded", "updated")]);
      await vi.waitFor(() => expect(grid(card)).not.toBeNull());
    }
  );

  it("says set-up failed once the entry fails while the card waits", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    connection.emit(ENTRY_RELOADS, [entryChange("setup_in_progress")]);
    await vi.waitFor(() => expect(text(card)).toContain(WAITING));

    connection.emit(ENTRY_RELOADS, [entryChange("setup_error", "updated")]);

    await vi.waitFor(() => expect(alertLine(card)).toBe(SETUP_FAILED));
  });

  it("ends the wait with the discovery-failed error and its Retry where the panel's entry is removed", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection);
    connection.emit(ENTRY_RELOADS, [entryChange("setup_retry")]);

    connection.emit(ENTRY_RELOADS, [entryChange("not_loaded", "removed")]);

    await vi.waitFor(() => expect(bannerMessages(card)).toEqual([FAILED]));
    expect(banner(card)!.querySelector(".retry-btn")).not.toBeNull();
    expect(text(card)).not.toContain(WAITING);
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
  });

  it("keeps waiting for a device id from before 2026.8, whose entry it cannot tell, whatever an entry says of itself", async () => {
    const connection = new FakeConnection();
    const card = await mountWaiting(connection, { deviceId: OLD_PANEL_ID });

    connection.emit(ENTRY_RELOADS, [entryChange("setup_error")]);
    await flush();

    expect(text(card)).toContain(WAITING);
    expect(alertLine(card)).toBeNull();
  });
});

describe("span-panel-card, which starts waiting while the connection is lost", () => {
  const SETUP_FAILED = "SPAN Panel could not be set up. Check Settings \u2192 Devices & services.";

  it("looks the panel's owner up again as the subscription's first batch comes, the connection back, and says set-up failed where the entry did", async () => {
    mockDiscover.mockReset();
    mockDiscover.mockRejectedValue(CONNECTION_LOST_RESULT);
    let down = true;
    const connection = new FakeConnection();
    const card = document.createElement("span-panel-card") as Card;
    card.setConfig({ device_id: PANEL.id } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);
    card.hass = hassWith(connection, {
      callWS: (async (msg: Record<string, unknown>) => {
        if (msg.type !== "config/device_registry/list") return {};
        if (down) throw CONNECTION_LOST_RESULT;
        return [PANEL, SECOND_PANEL];
      }) as HomeAssistant["callWS"],
    });
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
    await vi.waitFor(() => expect(text(card)).toContain(WAITING));

    // Home Assistant is back: the subscription, held while the connection was down, is answered with the current entries.
    down = false;
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_error"), change(SECOND_SPAN_ENTRY, "loaded")]);
    await vi.waitFor(() => expect(connection.subscriptions.filter(sub => sub.key === ENTRY_RELOADS)).toHaveLength(2));
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "setup_error"), change(SECOND_SPAN_ENTRY, "loaded")]);

    await vi.waitFor(() => expect(card.shadowRoot!.querySelector('[role="alert"]')?.textContent?.trim()).toBe(SETUP_FAILED));
    expect(text(card)).not.toContain(WAITING);
  });
});
