import { describe, it, expect, vi, afterEach } from "vitest";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";
import { discoverTopology } from "../src/card/card-discovery.js";
import { buildGridHTML } from "../src/core/grid-renderer.js";
import { positionRange, positionRowCount, type PositionRange } from "../src/helpers/layout.js";
import { t } from "../src/i18n.js";
import "../src/card/span-panel-card.js";
import { FakeConnection, hassWith } from "./fake-connection.js";

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

const HASS = { states: {}, services: {}, language: "en" } as unknown as HomeAssistant;

function topologyWith(fields: Partial<PanelTopology>): PanelTopology {
  return { circuits: {}, ...fields };
}

function grid(topology: PanelTopology, positions: PositionRange): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = buildGridHTML(topology, positions, HASS, {}, null);
  return div;
}

function labels(el: ParentNode): number[] {
  return [...el.querySelectorAll(".tab-label")].map(label => Number(label.textContent)).sort((a, b) => a - b);
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

describe("positionRange", () => {
  it("is the range the panel reports, over its size", () => {
    const topology = topologyWith({ circuits: { "c-9": circuit("Kitchen", [9, 11]) }, panel_size: 16, first_position: 9, last_position: 24 });
    expect(positionRange(topology, 16)).toEqual({ first: 9, last: 24 });
  });

  it("is 1 to the panel size when no range is reported", () => {
    expect(positionRange(topologyWith({ circuits: CIRCUITS, panel_size: 32 }), 32)).toEqual({ first: 1, last: 32 });
  });

  it("is the reported range when the panel size is 0", () => {
    expect(positionRange(topologyWith({ panel_size: 0, first_position: 1, last_position: 14 }), 0)).toEqual({ first: 1, last: 14 });
  });

  it.each([
    [0, 24],
    [9, 0],
    [24, 9],
    [9.5, 24],
    [null, 24],
  ])("ignores a reported range of %s to %s", (first, last) => {
    const topology = topologyWith({ circuits: CIRCUITS, first_position: first, last_position: last });
    expect(positionRange(topology, 14)).toEqual({ first: 1, last: 14 });
  });

  it("widens to every occupied tab, so no circuit is dropped", () => {
    const topology = topologyWith({ circuits: { ...CIRCUITS, "c-9": circuit("Shop", [50]) }, first_position: 9, last_position: 48 });
    expect(positionRange(topology, 40)).toEqual({ first: 1, last: 50 });
  });

  it("is null when nothing places a breaker", () => {
    expect(positionRange(topologyWith({ panel_size: 0 }), 0)).toBeNull();
    expect(positionRange(null, 32)).toBeNull();
  });

  it("counts the rows the range spans", () => {
    expect(positionRowCount({ first: 1, last: 32 })).toBe(16);
    expect(positionRowCount({ first: 9, last: 24 })).toBe(8);
    expect(positionRowCount({ first: 10, last: 25 })).toBe(9);
  });
});

describe("the grid", () => {
  const NINE_TO_24 = topologyWith({
    circuits: { "c-9": circuit("Kitchen", [9]), "c-12": circuit("Dryer", [12, 14]), "c-24": circuit("Office", [24]) },
    panel_size: 16,
    first_position: 9,
    last_position: 24,
  });

  it("draws rows labelled with the reported positions, and no slot below the first", () => {
    const el = grid(NINE_TO_24, positionRange(NINE_TO_24, 16)!);
    expect(labels(el)).toEqual(range(9, 24));
    // 16 positions, 4 of them occupied by three circuits.
    expect(el.querySelectorAll(".circuit-empty")).toHaveLength(12);
    expect(el.querySelector('.tab-label[style*="grid-row: 1;"]')!.textContent).toBe("9");
  });

  it("draws a breaker above the panel size when the range reaches it", () => {
    const topology = topologyWith({ circuits: { "c-43": circuit("Range", [43, 45]) }, panel_size: 40, first_position: 9, last_position: 48 });
    const slot = grid(topology, positionRange(topology, 40)!).querySelector<HTMLElement>('[data-uuid="c-43"]');
    expect(slot).not.toBeNull();
    // Position 43 is the 18th row from position 9; the slot spans two rows.
    expect(slot!.getAttribute("style")).toContain("grid-row: 18 / span 2");
  });

  it("labels only the positions in range on a row the range starts or ends inside", () => {
    const topology = topologyWith({ first_position: 10, last_position: 25 });
    expect(labels(grid(topology, positionRange(topology, 0)!))).toEqual(range(10, 25));
  });

  it("draws a 1 to 32 range exactly as a 32-space panel that reports none", () => {
    const circuits = { "c-1": circuit("Kitchen", [1]), "c-2": circuit("Dryer", [2, 4]), "c-3": circuit("Range", [29, 31]), "c-4": circuit("Office", [32]) };
    const reported = topologyWith({ circuits, panel_size: 32, first_position: 1, last_position: 32 });
    const unreported = topologyWith({ circuits, panel_size: 32 });
    const html = grid(reported, positionRange(reported, 32)!).innerHTML;
    expect(html).toBe(grid(unreported, positionRange(unreported, 32)!).innerHTML);
    expect(labels(grid(reported, positionRange(reported, 32)!))).toEqual(range(1, 32));
  });
});

describe("a panel that reports size 0 with positions", () => {
  it("loads, rather than failing on its size", async () => {
    const result = await discoverTopology(hassAnswering({ panel_size: 0, first_position: 1, last_position: 14 }), "panel-1");
    expect(result.panelSize).toBe(0);
    expect(positionRange(result.topology, result.panelSize)).toEqual({ first: 1, last: 14 });
  });

  describe("on the card", () => {
    const mounted: HTMLElement[] = [];
    afterEach(() => {
      for (const el of mounted.splice(0)) el.remove();
    });

    it("draws the grid over the reported positions", async () => {
      const topology = { circuits: { "c-9": circuit("Kitchen", [9]) }, panel_size: 0, first_position: 9, last_position: 24 };
      const hass = hassWith(new FakeConnection(), {
        callWS: (async (msg: Record<string, unknown>) => (msg.type === "span_panel/panel_topology" ? topology : [])) as HomeAssistant["callWS"],
      });
      const card = document.createElement("span-panel-card") as HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };
      card.setConfig({ device_id: "panel-1" });
      document.body.appendChild(card);
      mounted.push(card);
      card.hass = hass;

      await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".panel-grid")).not.toBeNull());
      const panelGrid = card.shadowRoot!.querySelector<HTMLElement>(".panel-grid")!;
      expect(labels(panelGrid)).toEqual(range(9, 24));
      expect(panelGrid.getAttribute("style")).toContain("repeat(8, auto)");
    });
  });
});
