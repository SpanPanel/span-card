import { describe, it, expect, vi } from "vitest";
import type { HomeAssistant, PanelTopology } from "../src/types.js";
import { resolveAndAssignAreas, subscribeAreaUpdates } from "../src/core/area-resolver.js";
import { ENTITY_REGISTRY, FakeConnection } from "./fake-connection.js";

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

describe("subscribeAreaUpdates", () => {
  function hassOn(connection: FakeConnection): HomeAssistant {
    return { ...hassWithPanelIn("Garage"), connection } as unknown as HomeAssistant;
  }

  it("reads the topology once per registry event", async () => {
    const connection = new FakeConnection();
    const topology = topologyWith({ panel_device_id: CURRENT_ID });
    const getTopology = vi.fn(() => topology);
    await subscribeAreaUpdates(hassOn(connection), getTopology, () => {});

    connection.emit(ENTITY_REGISTRY, {});

    await vi.waitFor(() => expect(topology.circuits.kitchen?.area).toBe("Garage"));
    expect(getTopology).toHaveBeenCalledTimes(1);
  });

  it("resolves against whichever topology is current when the event arrives", async () => {
    const connection = new FakeConnection();
    const first = topologyWith({ panel_device_id: CURRENT_ID });
    const second = topologyWith({ panel_device_id: CURRENT_ID });
    let current = first;
    const changed = vi.fn();
    await subscribeAreaUpdates(hassOn(connection), () => current, changed);

    current = second;
    connection.emit(ENTITY_REGISTRY, {});

    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(second.circuits.kitchen?.area).toBe("Garage");
    expect(first.circuits.kitchen?.area).toBeUndefined();
  });

  it("does nothing while there is no topology", async () => {
    const connection = new FakeConnection();
    const changed = vi.fn();
    const hass = hassOn(connection);
    await subscribeAreaUpdates(hass, () => null, changed);

    connection.emit(ENTITY_REGISTRY, {});
    await Promise.resolve();

    expect(changed).not.toHaveBeenCalled();
  });
});
