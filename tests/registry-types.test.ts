import { describe, it, expect } from "vitest";
import { deviceName, entityOwnName, isPanelDevice, owningPanelDevice } from "../src/core/registry-types.js";
import type { DeviceRegistryEntry } from "../src/core/registry-types.js";
import { BATTERY_DEVICE, CIRCUIT_DEVICE, OTHER_DEVICE, PANEL as HASS_PANEL, SECOND_PANEL } from "./hass-registries.js";

// The device list the card reads is the raw `config/device_registry/list`
// answer, not the frontend's `hass.devices`. A circuit is a child device of its
// panel there, and a child device's entry has a `parent_device_id` and no
// `via_device_id` key at all, so "no via_device_id" alone takes it for a panel.
const PANEL_ID = "panel-device-1";
const SERIAL = "sp3-test-001";

/** The panel, as Home Assistant sends a regular device. */
const PANEL: DeviceRegistryEntry = {
  id: PANEL_ID,
  name: "SPAN Panel",
  name_by_user: null,
  config_entry_id: "entry-1",
  identifiers: [["span_panel", SERIAL]],
  via_device_id: null,
  parent_device_id: null,
  area_id: null,
  model: "MAIN 32",
  sw_version: "1.0.0",
};

/** A circuit's device, with every key Home Assistant sends for a child device and no other. */
const RAW_CIRCUIT_DEVICE = {
  area_id: "kitchen",
  config_entry_id: "entry-1",
  config_subentry_id: null,
  created_at: 1763164800,
  disabled_by: null,
  id: "circuit-device-1",
  identifiers: [["span_panel", `${SERIAL}_circuit_0123456789abcdef`]] as [string, string][],
  labels: [],
  modified_at: 1763164800,
  name_by_user: null,
  name: "Kitchen Outlets",
  next_name_part: "area",
  parent_device_id: PANEL_ID,
};

describe("isPanelDevice", () => {
  it("accepts a panel", () => {
    expect(isPanelDevice(PANEL)).toBe(true);
  });

  it("accepts a panel from a Home Assistant without child devices, which sends no parent_device_id", () => {
    expect(isPanelDevice({ id: PANEL_ID, name: "SPAN Panel", identifiers: [["span_panel", SERIAL]], via_device_id: null })).toBe(true);
  });

  it("rejects a circuit child device", () => {
    expect("via_device_id" in RAW_CIRCUIT_DEVICE).toBe(false);

    expect(isPanelDevice(RAW_CIRCUIT_DEVICE)).toBe(false);
  });

  it("rejects a battery or charger, which reaches Home Assistant through the panel", () => {
    expect(isPanelDevice({ ...PANEL, id: "bess-1", identifiers: [["span_panel", `${SERIAL}_bess`]], via_device_id: PANEL_ID })).toBe(false);
  });

  it("rejects another integration's device", () => {
    expect(isPanelDevice({ ...PANEL, id: "other-1", identifiers: [["other_domain", SERIAL]] })).toBe(false);
  });

  it("rejects a device with no identifiers", () => {
    expect(isPanelDevice({ id: "bare-1" })).toBe(false);
  });
});

describe("owningPanelDevice", () => {
  // The frontend's `hass.devices`, where a circuit's child device is completed
  // from its panel's entry and carries `via_device_id: null`.
  const byId = (devices: DeviceRegistryEntry[]): Record<string, DeviceRegistryEntry> => Object.fromEntries(devices.map(d => [d.id, d]));
  const ALL = byId([HASS_PANEL, SECOND_PANEL, CIRCUIT_DEVICE, BATTERY_DEVICE, OTHER_DEVICE]);

  it("is a panel itself", () => {
    expect(owningPanelDevice(HASS_PANEL, ALL)).toBe(HASS_PANEL);
    expect(owningPanelDevice(SECOND_PANEL, ALL)).toBe(SECOND_PANEL);
  });

  it("is the panel a circuit's child device belongs to", () => {
    expect(owningPanelDevice(CIRCUIT_DEVICE, ALL)).toBe(HASS_PANEL);
  });

  it("is the panel a circuit's device belongs to as the device registry list sends it, with no via_device_id key", () => {
    expect(owningPanelDevice(RAW_CIRCUIT_DEVICE, byId([PANEL]))).toBe(PANEL);
  });

  it("is the panel a battery or charger is reached through", () => {
    expect(owningPanelDevice(BATTERY_DEVICE, ALL)).toBe(HASS_PANEL);
  });

  it("is null for another integration's device", () => {
    expect(owningPanelDevice(OTHER_DEVICE, ALL)).toBeNull();
  });

  it("is null where the device it belongs to is missing", () => {
    expect(owningPanelDevice(CIRCUIT_DEVICE, byId([CIRCUIT_DEVICE]))).toBeNull();
    expect(owningPanelDevice(BATTERY_DEVICE, byId([BATTERY_DEVICE]))).toBeNull();
  });

  it("is null where the device it belongs to is not a SPAN panel", () => {
    const onThermostat = { ...BATTERY_DEVICE, via_device_id: OTHER_DEVICE.id };
    expect(owningPanelDevice(onThermostat, ALL)).toBeNull();
  });
});

describe("deviceName", () => {
  it("is the name the user gave the device", () => {
    expect(deviceName({ id: "d", name: "Kitchen Outlets", name_by_user: "Counter Sockets" })).toBe("Counter Sockets");
  });

  it("is the integration's name where the user gave none", () => {
    expect(deviceName({ id: "d", name: "Kitchen Outlets", name_by_user: null })).toBe("Kitchen Outlets");
    expect(deviceName({ id: "d", name: "Kitchen Outlets" })).toBe("Kitchen Outlets");
  });

  it("passes over an empty user name", () => {
    expect(deviceName({ id: "d", name: "Kitchen Outlets", name_by_user: "" })).toBe("Kitchen Outlets");
  });

  it("drops the space around a name", () => {
    expect(deviceName({ id: "d", name: "ignored", name_by_user: "  Counter Sockets " })).toBe("Counter Sockets");
  });

  it("is empty for a device with no name", () => {
    expect(deviceName({ id: "d", name: null, name_by_user: null })).toBe("");
    expect(deviceName({ id: "d" })).toBe("");
  });
});

describe("entityOwnName", () => {
  const POWER = { entity_id: "sensor.kitchen_power", unique_id: "span_sp3-test-001_b-7_power" };

  it("takes the user's name before the integration's", () => {
    expect(entityOwnName({ ...POWER, name: "Coffee Bar Power", original_name: "Power" })).toBe("Coffee Bar Power");
  });

  it("takes the integration's name where the user gave none", () => {
    expect(entityOwnName({ ...POWER, name: null, original_name: "Power" })).toBe("Power");
  });

  it('is "" for an entity with neither', () => {
    expect(entityOwnName({ ...POWER, name: null, original_name: null })).toBe("");
    expect(entityOwnName(POWER)).toBe("");
  });

  it("keeps a user's \"\", which is how the registry says the entity goes by its device's name alone", () => {
    expect(entityOwnName({ ...POWER, name: "", original_name: "Power" })).toBe("");
  });
});
