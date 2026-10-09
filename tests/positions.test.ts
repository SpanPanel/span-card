import { describe, it, expect, vi } from "vitest";
import type { Circuit, HomeAssistant, PanelTopology } from "../src/types.js";
import { discoverTopology } from "../src/card/card-discovery.js";
import { t } from "../src/i18n.js";

function circuit(name: string, tabs: number[]): Circuit {
  return { name, tabs, entities: {} };
}

/** Circuits on tabs 1…14, so the size they imply is 14. */
const CIRCUITS: Record<string, Circuit> = {
  "c-1": circuit("Kitchen", [1]),
  "c-2": circuit("Dryer", [11, 13]),
  "c-3": circuit("Office", [14]),
};

function hassAnswering(topology: Partial<PanelTopology> & Record<string, unknown>): HomeAssistant {
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "span_panel/panel_topology":
        return { circuits: {}, ...topology };
      case "config/device_registry/list":
      case "config/area_registry/list":
      case "config/entity_registry/list":
        return [];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  return { callWS } as unknown as HomeAssistant;
}

describe("the panel size topology reports", () => {
  it("is taken when it is a positive integer", async () => {
    const { panelSize } = await discoverTopology(hassAnswering({ circuits: CIRCUITS, panel_size: 32 }), "panel-1");
    expect(panelSize).toBe(32);
  });

  it("falls back to the circuits when absent", async () => {
    const { panelSize } = await discoverTopology(hassAnswering({ circuits: CIRCUITS }), "panel-1");
    expect(panelSize).toBe(14);
  });

  it.each([0, -2, 12.5, Number.NaN, "32", null])("falls back to the circuits when it is %s", async size => {
    const { panelSize } = await discoverTopology(hassAnswering({ circuits: CIRCUITS, panel_size: size }), "panel-1");
    expect(panelSize).toBe(14);
  });

  it("fails to load when it is 0 and nothing else places a breaker", async () => {
    await expect(discoverTopology(hassAnswering({ panel_size: 0 }), "panel-1")).rejects.toThrow(t("card.topology_error"));
  });
});
