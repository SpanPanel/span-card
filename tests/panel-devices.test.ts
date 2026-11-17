import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverPanelDevices, spanEntryIdsOf } from "../src/core/panel-devices.js";
import { ErrorStore } from "../src/core/error-store.js";
import { RetryManager } from "../src/core/retry-manager.js";
import type { HomeAssistant } from "../src/types.js";
import {
  BATTERY_DEVICE,
  BATTERY_LEVEL,
  CIRCUIT_DEVICE,
  CIRCUIT_POWER,
  HELPER_ENTRY,
  HELPER_SENSOR,
  OTHER_DEVICE,
  PANEL,
  PANEL_STATUS,
  PANEL_TWIN,
  SECOND_PANEL,
  SECOND_SPAN_ENTRY,
  SPAN_ENTRY,
  THERMOSTAT,
  hassWithRegistries,
} from "./hass-registries.js";

describe("discoverPanelDevices", () => {
  it("lists the panels the integration's entries own, in the device registry's order", async () => {
    const hass = hassWithRegistries([OTHER_DEVICE, PANEL_TWIN, CIRCUIT_DEVICE, SECOND_PANEL, BATTERY_DEVICE, PANEL]);
    expect((await discoverPanelDevices(hass)).map(device => device.id)).toEqual([SECOND_PANEL.id, PANEL.id]);
  });
});

/** The keys of the errors the store shows. */
function shown(store: ErrorStore): string[] {
  return store.active.map(entry => entry.key);
}

describe("discoverPanelDevices through a retry manager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A Home Assistant whose device list always fails, and whose config entries
   * answer once `gate` opens, after the device list's retries have run out.
   */
  function hassWhoseDeviceListFails(gate: Promise<void>): HomeAssistant {
    return {
      ...hassWithRegistries([PANEL]),
      callWS: async <T>(msg: Record<string, unknown>): Promise<T> => {
        if (msg.type === "config/device_registry/list") throw new Error("device list unavailable");
        await gate;
        return [{ entry_id: SPAN_ENTRY, domain: "span_panel" }] as T;
      },
    };
  }

  it("reports each request under an error id of its own, so a late answer to one leaves the other's error showing", async () => {
    vi.useFakeTimers();
    const store = new ErrorStore();
    let openGate = (): void => undefined;
    const gate = new Promise<void>(resolve => (openGate = resolve));

    const discovery = discoverPanelDevices(hassWhoseDeviceListFails(gate), new RetryManager(store)).catch((err: unknown) => err);
    // The device list's three retries back off 1, 2 and 4 seconds.
    await vi.advanceTimersByTimeAsync(7000);
    expect(await discovery).toBeInstanceOf(Error);
    expect(shown(store)).toEqual(["fetch:devices"]);

    openGate();
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(store)).toEqual(["fetch:devices"]);
    store.dispose();
  });

  it("reports the config entries request under its own error id when it fails", async () => {
    vi.useFakeTimers();
    const store = new ErrorStore();
    const hass: HomeAssistant = {
      ...hassWithRegistries([PANEL]),
      callWS: async <T>(msg: Record<string, unknown>): Promise<T> => {
        if (msg.type === "config/device_registry/list") return [PANEL] as T;
        throw new Error("config entries unavailable");
      },
    };

    const discovery = discoverPanelDevices(hass, new RetryManager(store)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await discovery).toBeInstanceOf(Error);
    expect(shown(store)).toEqual(["fetch:config_entries"]);
    store.dispose();
  });
});

describe("spanEntryIdsOf", () => {
  it("is the entries that own the devices the integration's entities are on", () => {
    const hass = hassWithRegistries(
      [PANEL, PANEL_TWIN, SECOND_PANEL, CIRCUIT_DEVICE, BATTERY_DEVICE, OTHER_DEVICE],
      [PANEL_STATUS, CIRCUIT_POWER, BATTERY_LEVEL, THERMOSTAT, HELPER_SENSOR]
    );
    expect(spanEntryIdsOf(hass)).toEqual(new Set([SPAN_ENTRY]));
  });

  it("names a panel's entry by an entity on any of its devices", () => {
    const secondPanelCircuit = { ...CIRCUIT_DEVICE, id: "circuit-device-2", config_entry_id: SECOND_SPAN_ENTRY, parent_device_id: SECOND_PANEL.id };
    const hass = hassWithRegistries(
      [SECOND_PANEL, secondPanelCircuit],
      [{ entity_id: "sensor.garage_dryer_power", device_id: secondPanelCircuit.id, platform: "span_panel" }]
    );
    expect(spanEntryIdsOf(hass)).toEqual(new Set([SECOND_SPAN_ENTRY]));
  });

  it("never names the entry of a helper whose entity sits on its copy of the panel's device", () => {
    const hass = hassWithRegistries([PANEL, PANEL_TWIN], [PANEL_STATUS, HELPER_SENSOR]);
    expect(spanEntryIdsOf(hass).has(HELPER_ENTRY)).toBe(false);
  });

  it("names nothing for an entity of the integration's on no device, or on one the registry does not hold", () => {
    const hass = hassWithRegistries(
      [PANEL],
      [
        { entity_id: "sensor.span_deviceless", platform: "span_panel" },
        { ...PANEL_STATUS, device_id: "missing-device" },
      ]
    );
    expect(spanEntryIdsOf(hass)).toEqual(new Set());
  });

  it("names nothing before the frontend has loaded the registries", () => {
    const hass = hassWithRegistries([]);
    delete hass.devices;
    delete hass.entities;
    expect(spanEntryIdsOf(hass)).toEqual(new Set());
  });
});
