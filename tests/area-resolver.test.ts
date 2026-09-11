import { describe, it, expect, vi } from "vitest";
import type { HomeAssistant, PanelTopology } from "../src/types.js";
import { resolveAndAssignAreas } from "../src/core/area-resolver.js";

// A circuit with no area of its own takes the panel device's area. The panel is
// found by the device topology names, because the id a card holds can be one
// from before Home Assistant 2026.8 that the device list no longer contains.
const OLD_ID = "panel-before-2026-8";
const CURRENT_ID = "panel-now";

function hassWithPanelIn(areaName: string): HomeAssistant {
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/area_registry/list":
        return [{ area_id: "garage", name: areaName }];
      case "config/entity_registry/list":
        return [];
      case "config/device_registry/list":
        return [{ id: CURRENT_ID, area_id: "garage" }];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  return { callWS } as unknown as HomeAssistant;
}

function topologyWith(ids: Pick<PanelTopology, "device_id" | "panel_device_id">): PanelTopology {
  return {
    ...ids,
    circuits: { kitchen: { name: "Kitchen", tabs: [1], entities: {} } as unknown as PanelTopology["circuits"][string] },
  };
}

describe("resolveAndAssignAreas", () => {
  it("gives a circuit the area of the panel device topology names", async () => {
    const topology = topologyWith({ device_id: OLD_ID, panel_device_id: CURRENT_ID });

    await resolveAndAssignAreas(hassWithPanelIn("Garage"), topology);

    expect(topology.circuits.kitchen?.area).toBe("Garage");
  });

  it("falls back to the requested device when topology names none", async () => {
    const topology = topologyWith({ device_id: CURRENT_ID });

    await resolveAndAssignAreas(hassWithPanelIn("Garage"), topology);

    expect(topology.circuits.kitchen?.area).toBe("Garage");
  });
});
