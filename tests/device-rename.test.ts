import { describe, it, expect, vi } from "vitest";
import { renamedDeviceId, subscribeDeviceRenames, topologyNamesDevice } from "../src/core/device-rename.js";
import type { PanelTopology } from "../src/types.js";
import { DEVICE_REGISTRY, FakeConnection, hassWith } from "./fake-connection.js";

/**
 * A circuit is labelled by its device's name, and the user renames that device
 * in Home Assistant without the integration reloading. The device registry's
 * event is then the only word of it: `{ action, device_id, changes }`, where
 * `changes` holds the old value of each field an update changed.
 */

const PANEL = "panel-now";
const KITCHEN = "device-kitchen";
const BATTERY = "device-battery";

/** A `device_registry_updated` event as the websocket delivers it. */
function deviceEvent(data: Record<string, unknown>): unknown {
  return { event_type: DEVICE_REGISTRY, data, origin: "LOCAL", time_fired: "2026-01-01T00:00:00+00:00" };
}

function update(device_id: string, changes: Record<string, unknown>): unknown {
  return deviceEvent({ action: "update", device_id, changes });
}

function topology(overrides: Partial<PanelTopology> = {}): PanelTopology {
  return {
    panel_device_id: PANEL,
    circuits: {
      kitchen: { name: "Kitchen", tabs: [1], entities: {}, device_id: KITCHEN },
      garage: { name: "Garage", tabs: [2], entities: {}, device_id: null },
      attic: { name: "Attic", tabs: [3], entities: {} },
    },
    sub_devices: { [BATTERY]: { name: "Battery", type: "bess", entities: {} } },
    ...overrides,
  };
}

describe("renamedDeviceId", () => {
  it("names the device the user renamed", () => {
    expect(renamedDeviceId(update(KITCHEN, { name_by_user: null }))).toBe(KITCHEN);
  });

  it("names the device the integration renamed", () => {
    expect(renamedDeviceId(update(KITCHEN, { name: "Kitchen" }))).toBe(KITCHEN);
  });

  it("names it when the rename came with another change", () => {
    expect(renamedDeviceId(update(KITCHEN, { area_id: "pantry", name_by_user: "Cooking" }))).toBe(KITCHEN);
  });

  it.each([
    ["an update that changed no name", update(KITCHEN, { area_id: null })],
    ["a device created", deviceEvent({ action: "create", device_id: KITCHEN })],
    ["a device removed", deviceEvent({ action: "remove", device_id: KITCHEN, device: { name: "Kitchen" } })],
    ["an update that says nothing of what changed", deviceEvent({ action: "update", device_id: KITCHEN })],
    ["an update that names no device", deviceEvent({ action: "update", changes: { name: "Kitchen" } })],
    ["an event with no data", { event_type: DEVICE_REGISTRY }],
    ["no event at all", null],
  ])("is null for %s", (_case, event) => {
    expect(renamedDeviceId(event)).toBeNull();
  });
});

describe("topologyNamesDevice", () => {
  it.each([
    ["the panel's device", PANEL],
    ["a circuit's own device", KITCHEN],
    ["a battery's or a charger's device", BATTERY],
  ])("is true for %s", (_case, deviceId) => {
    expect(topologyNamesDevice(topology(), deviceId)).toBe(true);
  });

  it("finds the panel by the id the card asked with where the topology names no current one", () => {
    expect(topologyNamesDevice(topology({ panel_device_id: undefined, device_id: PANEL }), PANEL)).toBe(true);
  });

  it("takes the panel's current device over the id the card asked with", () => {
    const remapped = topology({ panel_device_id: PANEL, device_id: "panel-before-2026-8" });

    expect(topologyNamesDevice(remapped, "panel-before-2026-8")).toBe(false);
  });

  it("is false for any other device", () => {
    expect(topologyNamesDevice(topology(), "device-of-another-panel")).toBe(false);
  });

  it("is false for every device where the topology has no sub-devices and no circuit with a device", () => {
    const bare: PanelTopology = { circuits: { attic: { name: "Attic", tabs: [3], entities: {} } } };

    expect(topologyNamesDevice(bare, KITCHEN)).toBe(false);
  });
});

describe("subscribeDeviceRenames", () => {
  async function subscribed(getTopology: () => PanelTopology | null = () => topology()) {
    const connection = new FakeConnection();
    const renamed = vi.fn();
    const unsubscribe = await subscribeDeviceRenames(hassWith(connection), getTopology, renamed);
    return { connection, renamed, unsubscribe };
  }

  it("calls back when a device the topology names is renamed", async () => {
    const { connection, renamed } = await subscribed();

    connection.emit(DEVICE_REGISTRY, update(KITCHEN, { name_by_user: null }));

    expect(renamed).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a rename of a device the topology does not name", async () => {
    const { connection, renamed } = await subscribed();

    connection.emit(DEVICE_REGISTRY, update("device-of-another-panel", { name_by_user: null }));

    expect(renamed).not.toHaveBeenCalled();
  });

  it("stays quiet for a change that is no rename", async () => {
    const { connection, renamed } = await subscribed();

    connection.emit(DEVICE_REGISTRY, update(KITCHEN, { area_id: null }));
    connection.emit(DEVICE_REGISTRY, {});

    expect(renamed).not.toHaveBeenCalled();
  });

  it("asks for the topology when the event arrives, so a re-fetched one is the one it reads", async () => {
    let current: PanelTopology | null = null;
    const { connection, renamed } = await subscribed(() => current);
    connection.emit(DEVICE_REGISTRY, update(KITCHEN, { name: "Kitchen" }));
    expect(renamed).not.toHaveBeenCalled();

    current = topology();
    connection.emit(DEVICE_REGISTRY, update(KITCHEN, { name: "Kitchen" }));

    expect(renamed).toHaveBeenCalledTimes(1);
  });

  it("stops listening when unsubscribed", async () => {
    const { connection, renamed, unsubscribe } = await subscribed();

    unsubscribe();
    connection.emit(DEVICE_REGISTRY, update(KITCHEN, { name_by_user: null }));

    expect(connection.live(DEVICE_REGISTRY)).toBe(0);
    expect(renamed).not.toHaveBeenCalled();
  });
});
