import { describe, it, expect, vi } from "vitest";
import type { Circuit, HomeAssistant, PanelTopology } from "../src/types.js";
import { discoverTopology, isTopologyPending, subscribePanelEntryLoads } from "../src/card/card-discovery.js";
import { ErrorStore } from "../src/core/error-store.js";
import { RetryManager } from "../src/core/retry-manager.js";
import { ENTRY_RELOADS, FakeConnection, hassWith } from "./fake-connection.js";
import { PANEL, SECOND_PANEL, SECOND_SPAN_ENTRY, SPAN_ENTRY } from "./hass-registries.js";

// A card configured before Home Assistant 2026.8 can hold a device id that no
// longer names a device in the device list: that release split every device
// shared between integrations into one device per integration, each with a new
// id. The integration still answers the old id.
const OLD_ID = "panel-before-2026-8";
const CURRENT_ID = "panel-now";

function hassAnswering(topology: Partial<PanelTopology>, devices: object[]): HomeAssistant {
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "span_panel/panel_topology":
        return { circuits: {}, panel_size: 32, ...topology };
      case "config/device_registry/list":
        return devices;
      case "config/area_registry/list":
      case "config/entity_registry/list":
        return [];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  return { callWS } as unknown as HomeAssistant;
}

// From SPAN Panel 2.3.0 each circuit is a child device of its panel, and its
// topology record names that device. The record's own `name` is the circuit's
// name in the SPAN app; the device's is what Home Assistant shows, and the
// user's rename of it comes first.
describe("topology path labels a circuit by its device when the record carries device_id", () => {
  const PANEL = { id: CURRENT_ID, name: "SPAN Panel", parent_device_id: null, via_device_id: null };

  function circuit(record: Partial<Circuit>): Circuit {
    return { name: "Kitchen Outlets", tabs: [7], entities: {}, ...record };
  }

  async function labelOf(record: Partial<Circuit>, devices: object[]): Promise<string | undefined> {
    const hass = hassAnswering({ device_id: CURRENT_ID, circuits: { "b-7": circuit(record) } }, [PANEL, ...devices]);
    const { topology } = await discoverTopology(hass, CURRENT_ID);
    return topology?.circuits["b-7"]?.name;
  }

  it("takes the device's name where it differs from the record's", async () => {
    const device = { id: "device-b-7", name: "Circuit 7", name_by_user: null, parent_device_id: CURRENT_ID };

    expect(await labelOf({ name: "", device_id: "device-b-7" }, [device])).toBe("Circuit 7");
  });

  it("takes the user's rename of the device first", async () => {
    const device = { id: "device-b-7", name: "Kitchen Outlets", name_by_user: "Coffee Bar", parent_device_id: CURRENT_ID };

    expect(await labelOf({ device_id: "device-b-7" }, [device])).toBe("Coffee Bar");
  });

  it.each([
    ["names no device, as from an integration that predates circuit devices", {}],
    ["names none for this circuit", { device_id: null }],
    ["names a device the list does not hold", { device_id: "gone" }],
  ])("keeps the record's name where it %s", async (_case, record) => {
    const device = { id: "device-b-7", name: "Kitchen Outlets", name_by_user: "Coffee Bar", parent_device_id: CURRENT_ID };

    expect(await labelOf(record, [device])).toBe("Kitchen Outlets");
  });

  it("keeps the record's name where the device has none", async () => {
    const device = { id: "device-b-7", name: null, name_by_user: null, parent_device_id: CURRENT_ID };

    expect(await labelOf({ device_id: "device-b-7" }, [device])).toBe("Kitchen Outlets");
  });

  // A charger's feed circuit keeps its sensors on the charger's device, which
  // the integration names with the panel's name in front. Its record names the
  // circuit's own device, which holds its breaker switch, or none: never the
  // charger's.
  describe("for a charger's feed circuit", () => {
    const charger = { id: "charger-device", name: "SPAN Panel EV Charger (FLEX⁺)", name_by_user: null, via_device_id: CURRENT_ID, parent_device_id: null };
    const feed = { name: "FLEX⁺", tabs: [30, 32], entities: { power: "sensor.span_panel_ev_charger_flex_power" } };

    it("keeps the record's name where the circuit has no device, without the panel's name the charger's carries", async () => {
      expect(await labelOf({ ...feed, device_id: null }, [charger])).toBe("FLEX⁺");
    });

    it("takes the name of the circuit's own device where it has one", async () => {
      const device = { id: "device-ev-1", name: "FLEX⁺", name_by_user: "Garage Charger", parent_device_id: CURRENT_ID };

      expect(await labelOf({ ...feed, device_id: "device-ev-1" }, [charger, device])).toBe("Garage Charger");
    });
  });
});

// Until the panel's config entry has loaded, `panel_topology` gives no topology:
// the integration answers `not_loaded` while the entry is set up, retried or
// reloaded, and `no_data` for a loaded entry before its first data; Home
// Assistant answers `unknown_command` before the integration has registered it,
// which it does as its first entry sets up; and home-assistant-js-websocket
// rejects a call the lost connection cut off. Every other refusal is one that
// waiting does not end.
describe("isTopologyPending", () => {
  it.each([
    ["the entry not loaded", { code: "not_loaded", message: "SPAN Panel integration is not loaded" }],
    ["a loaded entry with no data yet", { code: "no_data", message: "SPAN Panel has not yet provided any data" }],
    ["a command Home Assistant does not know yet", { code: "unknown_command", message: "Unknown command." }],
    ["a connection lost, as the error result the library rejects with", { type: "result", success: false, error: { code: 3, message: "Connection lost" } }],
    ["a connection lost, as the bare code the library rejected a queued command with before 9.8.0", 3],
  ])("holds for %s", (_case, err) => {
    expect(isTopologyPending(err)).toBe(true);
  });

  it.each([
    ["a device the registry does not hold", { code: "device_not_found", message: "Device not found" }],
    ["a device no SPAN entry owns", { code: "not_span_panel", message: "Device is not a SPAN Panel device" }],
    ["a circuit's or a sub-device's device", { code: "not_panel_device", message: "Use the SPAN panel device registry ID" }],
    ["any other error Home Assistant answers", { code: "unknown_error", message: "Unknown error" }],
    ["the library's invalid authentication, as an error result", { type: "result", success: false, error: { code: 2, message: "Invalid auth" } }],
    ["the library's invalid authentication, as a bare code", 2],
    ["an Error whose message names a code", new Error("not_loaded")],
    ["a code as text, with no rejection object", "not_loaded"],
    ["null", null],
  ])("fails for %s", (_case, err) => {
    expect(isTopologyPending(err)).toBe(false);
  });

  it.each([
    ["the entry not loaded", { code: "not_loaded", message: "SPAN Panel integration is not loaded" }],
    ["a connection lost", { type: "result", success: false, error: { code: 3, message: "Connection lost" } }],
  ])("is, for %s, what a retry manager built to pass it through hands back from discoverTopology, after one ask", async (_case, refusal) => {
    const callWS = vi.fn(async () => {
      throw refusal;
    });
    const store = new ErrorStore();

    await expect(
      discoverTopology({ callWS } as unknown as HomeAssistant, CURRENT_ID, new RetryManager(store, { passThrough: isTopologyPending }))
    ).rejects.toBe(refusal);

    expect(callWS).toHaveBeenCalledTimes(1);
    expect(store.active).toEqual([]);
    store.dispose();
  });
});

describe("subscribePanelEntryLoads", () => {
  const SEED = (...entries: Array<[string, string, string?]>): unknown[] =>
    entries.map(([entry_id, state, domain = "span_panel"]) => ({ type: null, entry: { entry_id, domain, state } }));
  const LOADED = (entry_id: string): unknown[] => [{ type: "updated", entry: { entry_id, domain: "span_panel", state: "loaded" } }];

  function hassListing(connection: FakeConnection, devices: () => Promise<unknown>): HomeAssistant {
    return hassWith(connection, {
      callWS: (async (msg: Record<string, unknown>) => {
        if (msg.type === "config/device_registry/list") return devices();
        throw new Error(`unexpected websocket call ${String(msg.type)}`);
      }) as HomeAssistant["callWS"],
    });
  }

  it("reports the panel's own entry loading, one already loaded in the first batch included, and no other's", async () => {
    const connection = new FakeConnection();
    const onLoaded = vi.fn();
    await subscribePanelEntryLoads(
      hassListing(connection, async () => [PANEL, SECOND_PANEL]),
      PANEL.id,
      onLoaded
    );

    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "loaded"], [SECOND_SPAN_ENTRY, "loaded"]));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    connection.emit(ENTRY_RELOADS, LOADED(SECOND_SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: SPAN_ENTRY, domain: "span_panel", state: "setup_in_progress" } }]);
    connection.emit(ENTRY_RELOADS, LOADED(SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the device list does not hold the device, as for an id from before Home Assistant 2026.8", async () => [PANEL, SECOND_PANEL]],
    ["the device list holds it with no owner", async () => [{ id: OLD_ID }]],
    [
      "the device list cannot be read",
      async () => {
        throw new Error("connection lost");
      },
    ],
  ])("reports any of the integration's entries loading where %s", async (_case, devices) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connection = new FakeConnection();
    const onLoaded = vi.fn();
    await subscribePanelEntryLoads(hassListing(connection, devices), OLD_ID, onLoaded);

    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "setup_retry"], ["hue-entry-1", "loaded", "hue"]));
    expect(onLoaded).not.toHaveBeenCalled();
    connection.emit(ENTRY_RELOADS, LOADED(SECOND_SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("subscribes to config entries as the card's reload subscription does, and unsubscribes through what it resolves to", async () => {
    const connection = new FakeConnection();
    const unsubscribe = await subscribePanelEntryLoads(
      hassListing(connection, async () => [PANEL]),
      PANEL.id,
      () => {}
    );

    expect(connection.subscriptions.map(s => s.message)).toEqual([{ type: "config_entries/subscribe", type_filter: ["device"] }]);
    await unsubscribe();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
  });
});
