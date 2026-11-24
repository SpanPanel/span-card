import { describe, it, expect, vi } from "vitest";
import type { Circuit, HomeAssistant, PanelTopology } from "../src/types.js";
import { discoverTopology, subscribePanelEntryLoads } from "../src/card/card-discovery.js";
import { ENTRY_RELOADS, FakeConnection, hassWith } from "./fake-connection.js";
import { HELPER_ENTRY, PANEL, PANEL_TWIN, SECOND_PANEL, SECOND_SPAN_ENTRY, SPAN_ENTRY } from "./hass-registries.js";

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

describe("subscribePanelEntryLoads", () => {
  const SEED = (...entries: Array<[string, string, string?]>): unknown[] =>
    entries.map(([entry_id, state, domain = "span_panel"]) => ({ type: null, entry: { entry_id, domain, state, disabled_by: null } }));
  const LOADED = (entry_id: string): unknown[] => [{ type: "updated", entry: { entry_id, domain: "span_panel", state: "loaded", disabled_by: null } }];

  /**
   * The devices Home Assistant 2026.8 split the device it gave an id from before
   * that release, `OLD_ID`, into: the panel's own, under its SPAN entry, and the
   * copy a helper linked to the panel owns, under the helper's entry, which was
   * the old device's primary. Every name and id is illustrative.
   */
  const SPLITS = { [OLD_ID]: { split_ids: [PANEL_TWIN.id, PANEL.id], primary_id: PANEL_TWIN.id } };

  /**
   * Home Assistant answering the device registry list with `devices`, the
   * composite splits with `SPLITS`, and the integration's config entries with
   * the two panels' entries.
   */
  function hassListing(connection: FakeConnection, devices: () => Promise<unknown>): HomeAssistant {
    return hassWith(connection, {
      callWS: (async (msg: Record<string, unknown>) => {
        switch (msg.type) {
          case "config/device_registry/list":
            return devices();
          case "config/device_registry/list_composite_splits":
            return SPLITS;
          case "config_entries/get":
            if (msg.domain === "span_panel") return [SPAN_ENTRY, SECOND_SPAN_ENTRY].map(entry_id => ({ entry_id, domain: "span_panel" }));
            break;
          default:
            break;
        }
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
      { onLoaded, onStatus: () => {} }
    );

    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "loaded"], [SECOND_SPAN_ENTRY, "loaded"]));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    connection.emit(ENTRY_RELOADS, LOADED(SECOND_SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: SPAN_ENTRY, domain: "span_panel", state: "setup_in_progress" } }]);
    connection.emit(ENTRY_RELOADS, LOADED(SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(2);
  });

  it("waits for the entry that owns the panel's split of a device id from before Home Assistant 2026.8, and reports what it says of itself", async () => {
    const connection = new FakeConnection();
    const onLoaded = vi.fn();
    const onStatus = vi.fn();
    await subscribePanelEntryLoads(
      hassListing(connection, async () => [PANEL_TWIN, PANEL, SECOND_PANEL]),
      OLD_ID,
      { onLoaded, onStatus }
    );

    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "setup_retry"], [SECOND_SPAN_ENTRY, "loaded"], [HELPER_ENTRY, "loaded", "utility_meter"]));
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onStatus.mock.calls).toEqual([["loading"]]);
    connection.emit(ENTRY_RELOADS, LOADED(SECOND_SPAN_ENTRY));
    expect(onLoaded).not.toHaveBeenCalled();
    connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: SPAN_ENTRY, domain: "span_panel", state: "setup_error", disabled_by: null } }]);
    expect(onStatus.mock.calls).toEqual([["loading"], ["setup_failed"]]);
    connection.emit(ENTRY_RELOADS, LOADED(SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["names no device the list holds, nor one 2026.8 split", "device-gone"],
    ["names a device no entry of the integration's owns", PANEL_TWIN.id],
  ])("reports at once that the panel has no entry where the id %s, and subscribes to nothing", async (_case, deviceId) => {
    const connection = new FakeConnection();
    const onLoaded = vi.fn();
    const onStatus = vi.fn();

    const unsubscribe = await subscribePanelEntryLoads(
      hassListing(connection, async () => [PANEL_TWIN, PANEL, SECOND_PANEL]),
      deviceId,
      { onLoaded, onStatus }
    );

    expect(onStatus.mock.calls).toEqual([[null]]);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(connection.subscriptions).toEqual([]);
    await unsubscribe();
  });

  it("waits for any of the integration's entries where the device list is refused by a lost connection, and for the panel's own once the subscription's first batch comes and the list answers", async () => {
    const lost = { type: "result", success: false, error: { code: 3, message: "Connection lost" } };
    let down = true;
    const connection = new FakeConnection();
    const onLoaded = vi.fn();
    const onStatus = vi.fn();
    const subscribed = subscribePanelEntryLoads(
      hassListing(connection, async () => {
        if (down) throw lost;
        return [PANEL, SECOND_PANEL];
      }),
      PANEL.id,
      { onLoaded, onStatus }
    );
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
    const unsubscribe = await subscribed;

    // The connection is back: the subscription's first batch comes, and another panel's entry is loaded.
    down = false;
    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "setup_error"], [SECOND_SPAN_ENTRY, "loaded"]));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(connection.subscriptions.filter(sub => sub.key === ENTRY_RELOADS)).toHaveLength(2));
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));

    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "setup_error"], [SECOND_SPAN_ENTRY, "loaded"]));
    expect(onStatus.mock.calls).toEqual([["setup_failed"]]);
    connection.emit(ENTRY_RELOADS, LOADED(SECOND_SPAN_ENTRY));
    expect(onLoaded).toHaveBeenCalledTimes(1);
    await unsubscribe();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
  });

  it("reports that the panel has no entry where the lookup after a lost connection finds none of the integration's entries owning the device", async () => {
    const lost = { type: "result", success: false, error: { code: 3, message: "Connection lost" } };
    let down = true;
    const connection = new FakeConnection();
    const onStatus = vi.fn();
    const subscribed = subscribePanelEntryLoads(
      hassListing(connection, async () => {
        if (down) throw lost;
        return [PANEL, SECOND_PANEL];
      }),
      "device-gone",
      { onLoaded: () => {}, onStatus }
    );
    await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
    await subscribed;

    down = false;
    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "loaded"]));

    await vi.waitFor(() => expect(onStatus.mock.calls).toEqual([[null]]));
    expect(connection.subscriptions.filter(sub => sub.key === ENTRY_RELOADS)).toHaveLength(1);
  });

  it("reports what the panel's own entry says of itself as it changes, and its removal, and nothing of another panel's", async () => {
    const connection = new FakeConnection();
    const onStatus = vi.fn();
    await subscribePanelEntryLoads(
      hassListing(connection, async () => [PANEL, SECOND_PANEL]),
      PANEL.id,
      { onLoaded: () => {}, onStatus }
    );
    const updated = (entry_id: string, state: string, disabled_by: string | null = null): unknown[] => [
      { type: "updated", entry: { entry_id, domain: "span_panel", state, disabled_by } },
    ];

    connection.emit(ENTRY_RELOADS, SEED([SPAN_ENTRY, "setup_in_progress"], [SECOND_SPAN_ENTRY, "setup_error"]));
    connection.emit(ENTRY_RELOADS, updated(SPAN_ENTRY, "setup_retry"));
    connection.emit(ENTRY_RELOADS, updated(SPAN_ENTRY, "setup_error"));
    connection.emit(ENTRY_RELOADS, updated(SECOND_SPAN_ENTRY, "not_loaded", "user"));
    connection.emit(ENTRY_RELOADS, updated(SPAN_ENTRY, "not_loaded", "user"));
    connection.emit(ENTRY_RELOADS, [{ type: "removed", entry: { entry_id: SPAN_ENTRY, domain: "span_panel", state: "not_loaded", disabled_by: "user" } }]);

    expect(onStatus.mock.calls).toEqual([["loading"], ["setup_failed"], ["disabled"], [null]]);
  });

  it("subscribes to config entries as the card's reload subscription does, and unsubscribes through what it resolves to", async () => {
    const connection = new FakeConnection();
    const unsubscribe = await subscribePanelEntryLoads(
      hassListing(connection, async () => [PANEL]),
      PANEL.id,
      {
        onLoaded: () => {},
        onStatus: () => {},
      }
    );

    expect(connection.subscriptions.map(s => s.message)).toEqual([{ type: "config_entries/subscribe", type_filter: ["device"] }]);
    await unsubscribe();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
  });
});
