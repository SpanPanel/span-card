import { describe, it, expect, vi } from "vitest";
import type { Circuit, HomeAssistant, PanelDevice, PanelTopology } from "../src/types.js";
import { discoverTopology, panelConfigEntryId } from "../src/card/card-discovery.js";

// A card configured before Home Assistant 2026.8 can hold a device id that no
// longer names a device: that release split every device shared between
// integrations into one device per integration, each with a new id. The
// integration still answers the old id, and says which device it became.
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

describe("discoverTopology", () => {
  it("finds the panel by the device topology names, not the id the card holds", async () => {
    const hass = hassAnswering({ device_id: OLD_ID, panel_device_id: CURRENT_ID, config_entry_id: "entry-1" }, [
      { id: CURRENT_ID, name: "SPAN Panel", config_entry_id: "entry-1" },
    ]);

    const { panelDevice } = await discoverTopology(hass, OLD_ID);

    expect(panelDevice?.id).toBe(CURRENT_ID);
    expect(panelDevice?.config_entry_id).toBe("entry-1");
  });

  it("falls back to the id the card holds when topology names no device", async () => {
    const hass = hassAnswering({ device_id: CURRENT_ID }, [{ id: CURRENT_ID, name: "SPAN Panel", config_entry_id: "entry-1" }]);

    const { panelDevice } = await discoverTopology(hass, CURRENT_ID);

    expect(panelDevice?.id).toBe(CURRENT_ID);
  });
});

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
});

describe("panelConfigEntryId", () => {
  const device: PanelDevice = { id: CURRENT_ID, config_entry_id: "from-device" };

  it("takes the entry topology names", () => {
    const topology = { circuits: {}, config_entry_id: "from-topology" } as PanelTopology;
    expect(panelConfigEntryId(topology, device)).toBe("from-topology");
  });

  it("falls back to the panel device's own entry", () => {
    expect(panelConfigEntryId({ circuits: {} }, device)).toBe("from-device");
  });

  it("answers null when neither names one", () => {
    expect(panelConfigEntryId(null, null)).toBeNull();
  });
});
