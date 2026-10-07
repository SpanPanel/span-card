import { describe, it, expect } from "vitest";
import { sameTopologyStructure } from "../src/core/topology-structure.js";
import type { Circuit, PanelTopology } from "../src/types.js";

function topologyWith(circuit: Partial<Circuit>): PanelTopology {
  return {
    circuits: { kitchen: { name: "Kitchen", tabs: [1], entities: { switch: "switch.kitchen_breaker" }, ...circuit } },
    panel_size: 32,
  } as unknown as PanelTopology;
}

describe("sameTopologyStructure", () => {
  it("ignores the circuits' live relay and priority fields", () => {
    const before = topologyWith({ relay_state: "CLOSED", relay_state_target: "CLOSED", priority: "NEVER", priority_target: "NEVER" });
    const after = topologyWith({ relay_state: "OPEN", relay_state_target: "OPEN", priority: "OFF_GRID", priority_target: "OFF_GRID" });
    expect(sameTopologyStructure(after, before)).toBe(true);
  });

  it("sees a change to anything else", () => {
    expect(sameTopologyStructure(topologyWith({ entities: {} }), topologyWith({}))).toBe(false);
    expect(sameTopologyStructure(topologyWith({ name: "Garage" }), topologyWith({}))).toBe(false);
    expect(sameTopologyStructure(topologyWith({}), null)).toBe(false);
  });

  it("does not modify either topology", () => {
    const before = topologyWith({ relay_state: "CLOSED" });
    sameTopologyStructure(topologyWith({ relay_state: "OPEN" }), before);
    expect(before.circuits.kitchen?.relay_state).toBe("CLOSED");
  });
});
