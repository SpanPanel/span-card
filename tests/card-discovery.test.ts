import { describe, it, expect, vi } from "vitest";
import type { HomeAssistant, PanelDevice, PanelTopology } from "../src/types.js";
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
