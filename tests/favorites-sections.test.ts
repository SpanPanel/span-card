import { describe, it, expect } from "vitest";
import { groupFavoritesByPanel } from "../src/core/favorites-sections.js";
import type { FavoriteRef, PanelTopology } from "../src/types.js";

function topo(circuitNames: Record<string, string>): PanelTopology {
  return {
    circuits: Object.fromEntries(
      Object.entries(circuitNames).map(([uuid, name]) => [uuid, { name, tabs: [], entities: {} } as PanelTopology["circuits"][string]])
    ),
    device_name: "",
    panel_entities: {},
  } as PanelTopology;
}

describe("groupFavoritesByPanel", () => {
  it("returns an empty array when favRefs has no circuit entries", () => {
    const favRefs: Record<string, FavoriteRef> = {};
    const perPanelInfo = new Map();
    expect(groupFavoritesByPanel(favRefs, perPanelInfo)).toEqual([]);
  });

  it("filters out 'sub_device' kind refs — only circuits are included", () => {
    const favRefs: Record<string, FavoriteRef> = {
      "p1|u1": { panelDeviceId: "p1", kind: "circuit", targetId: "u1", configEntryId: "e1" },
      "p1|sd1": { panelDeviceId: "p1", kind: "sub_device", targetId: "sd1", configEntryId: "e1" },
    };
    const perPanelInfo = new Map([["p1", { panelName: "Panel 1", topology: topo({ u1: "Kitchen" }), configEntryId: "e1" }]]);
    const result = groupFavoritesByPanel(favRefs, perPanelInfo);
    expect(result).toHaveLength(1);
    expect(result[0]?.favoriteCircuitUuids.size).toBe(1);
    expect(result[0]?.favoriteCircuitUuids.has("u1")).toBe(true);
    expect(result[0]?.favoriteCircuitUuids.has("sd1")).toBe(false);
  });

  it("groups favorite circuits by their panelDeviceId", () => {
    const favRefs: Record<string, FavoriteRef> = {
      "p1|u1": { panelDeviceId: "p1", kind: "circuit", targetId: "u1", configEntryId: "e1" },
      "p1|u2": { panelDeviceId: "p1", kind: "circuit", targetId: "u2", configEntryId: "e1" },
      "p2|u3": { panelDeviceId: "p2", kind: "circuit", targetId: "u3", configEntryId: "e2" },
    };
    const perPanelInfo = new Map([
      ["p1", { panelName: "Panel A", topology: topo({ u1: "Kitchen", u2: "Living" }), configEntryId: "e1" }],
      ["p2", { panelName: "Panel B", topology: topo({ u3: "Garage" }), configEntryId: "e2" }],
    ]);
    const result = groupFavoritesByPanel(favRefs, perPanelInfo);
    expect(result).toHaveLength(2);
    const byId = new Map(result.map(s => [s.panelDeviceId, s]));
    expect(byId.get("p1")?.favoriteCircuitUuids.size).toBe(2);
    expect(byId.get("p2")?.favoriteCircuitUuids.size).toBe(1);
  });

  it("sorts sections alphabetically by panelName", () => {
    const favRefs: Record<string, FavoriteRef> = {
      "pZ|u1": { panelDeviceId: "pZ", kind: "circuit", targetId: "u1", configEntryId: "eZ" },
      "pA|u2": { panelDeviceId: "pA", kind: "circuit", targetId: "u2", configEntryId: "eA" },
    };
    const perPanelInfo = new Map([
      ["pZ", { panelName: "Zeta Panel", topology: topo({ u1: "A" }), configEntryId: "eZ" }],
      ["pA", { panelName: "Alpha Panel", topology: topo({ u2: "B" }), configEntryId: "eA" }],
    ]);
    const result = groupFavoritesByPanel(favRefs, perPanelInfo);
    expect(result.map(s => s.panelName)).toEqual(["Alpha Panel", "Zeta Panel"]);
  });

  it("drops refs whose panelDeviceId is missing from perPanelInfo", () => {
    const favRefs: Record<string, FavoriteRef> = {
      "known|u1": { panelDeviceId: "known", kind: "circuit", targetId: "u1", configEntryId: "e1" },
      "ghost|u2": { panelDeviceId: "ghost", kind: "circuit", targetId: "u2", configEntryId: "e2" },
    };
    const perPanelInfo = new Map([["known", { panelName: "Known", topology: topo({ u1: "K" }), configEntryId: "e1" }]]);
    const result = groupFavoritesByPanel(favRefs, perPanelInfo);
    expect(result).toHaveLength(1);
    expect(result[0]?.panelDeviceId).toBe("known");
  });
});
