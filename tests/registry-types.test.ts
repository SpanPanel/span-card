import { describe, it, expect } from "vitest";
import { deviceName, isPanelDevice, owningPanelDevice, sharesOwner } from "../src/core/registry-types.js";
import type { DeviceRegistryEntry } from "../src/core/registry-types.js";
import {
  BATTERY_DEVICE,
  CIRCUIT_DEVICE,
  OTHER_DEVICE,
  PANEL as HASS_PANEL,
  PANEL_TWIN,
  SECOND_PANEL,
  SECOND_SPAN_ENTRY,
  SPAN_ENTRY,
} from "./hass-registries.js";

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

/** The integration's config entries in these tests: the one that owns PANEL. */
const SPAN_ENTRIES: ReadonlySet<string> = new Set(["entry-1"]);

describe("isPanelDevice", () => {
  it("accepts a panel", () => {
    expect(isPanelDevice(PANEL, SPAN_ENTRIES)).toBe(true);
  });

  it("accepts a panel from a Home Assistant without child devices, which sends no parent_device_id", () => {
    const panel = {
      id: PANEL_ID,
      name: "SPAN Panel",
      config_entry_id: "entry-1",
      identifiers: [["span_panel", SERIAL]] as [string, string][],
      via_device_id: null,
    };
    expect(isPanelDevice(panel, SPAN_ENTRIES)).toBe(true);
  });

  it("rejects a circuit child device", () => {
    expect("via_device_id" in RAW_CIRCUIT_DEVICE).toBe(false);

    expect(isPanelDevice(RAW_CIRCUIT_DEVICE, SPAN_ENTRIES)).toBe(false);
  });

  it("rejects a battery or charger, which reaches Home Assistant through the panel", () => {
    expect(isPanelDevice({ ...PANEL, id: "bess-1", identifiers: [["span_panel", `${SERIAL}_bess`]], via_device_id: PANEL_ID }, SPAN_ENTRIES)).toBe(false);
  });

  it("rejects another integration's device", () => {
    expect(isPanelDevice({ ...PANEL, id: "other-1", config_entry_id: "other-entry", identifiers: [["other_domain", SERIAL]] }, SPAN_ENTRIES)).toBe(false);
  });

  // Home Assistant 2026.8 split a device several entries shared into one per
  // entry, each keeping the shared device's identifiers.
  it("rejects the device a helper linked to the panel before Home Assistant 2026.8 owns, the panel's SPAN identifier and all", () => {
    expect(isPanelDevice({ ...PANEL, id: "panel-twin", config_entry_id: "helper-entry" }, SPAN_ENTRIES)).toBe(false);
  });

  it("rejects a device with no owner", () => {
    expect(isPanelDevice({ id: "bare-1", identifiers: [["span_panel", SERIAL]] }, SPAN_ENTRIES)).toBe(false);
  });
});

describe("owningPanelDevice", () => {
  // The frontend's `hass.devices`, where a circuit's child device is completed
  // from its panel's entry and carries `via_device_id: null`.
  const byId = (devices: DeviceRegistryEntry[]): Record<string, DeviceRegistryEntry> => Object.fromEntries(devices.map(d => [d.id, d]));
  const ALL = byId([HASS_PANEL, PANEL_TWIN, SECOND_PANEL, CIRCUIT_DEVICE, BATTERY_DEVICE, OTHER_DEVICE]);
  const HASS_SPAN_ENTRIES: ReadonlySet<string> = new Set([SPAN_ENTRY, SECOND_SPAN_ENTRY]);

  it("is a panel itself", () => {
    expect(owningPanelDevice(HASS_PANEL, ALL, HASS_SPAN_ENTRIES)).toBe(HASS_PANEL);
    expect(owningPanelDevice(SECOND_PANEL, ALL, HASS_SPAN_ENTRIES)).toBe(SECOND_PANEL);
  });

  it("is the panel a circuit's child device belongs to", () => {
    expect(owningPanelDevice(CIRCUIT_DEVICE, ALL, HASS_SPAN_ENTRIES)).toBe(HASS_PANEL);
  });

  it("is the panel a circuit's device belongs to as the device registry list sends it, with no via_device_id key", () => {
    expect(owningPanelDevice(RAW_CIRCUIT_DEVICE, byId([PANEL]), SPAN_ENTRIES)).toBe(PANEL);
  });

  it("is the panel a battery or charger is reached through", () => {
    expect(owningPanelDevice(BATTERY_DEVICE, ALL, HASS_SPAN_ENTRIES)).toBe(HASS_PANEL);
  });

  it("is null for another integration's device", () => {
    expect(owningPanelDevice(OTHER_DEVICE, ALL, HASS_SPAN_ENTRIES)).toBeNull();
  });

  it("is null for the device a helper owns, a copy of the panel's", () => {
    expect(owningPanelDevice(PANEL_TWIN, ALL, HASS_SPAN_ENTRIES)).toBeNull();
  });

  it("is null where the device it belongs to is missing", () => {
    expect(owningPanelDevice(CIRCUIT_DEVICE, byId([CIRCUIT_DEVICE]), HASS_SPAN_ENTRIES)).toBeNull();
    expect(owningPanelDevice(BATTERY_DEVICE, byId([BATTERY_DEVICE]), HASS_SPAN_ENTRIES)).toBeNull();
  });

  it("is null where the device it belongs to is not a SPAN panel", () => {
    const onThermostat = { ...BATTERY_DEVICE, via_device_id: OTHER_DEVICE.id };
    expect(owningPanelDevice(onThermostat, ALL, HASS_SPAN_ENTRIES)).toBeNull();
  });

  it("is null where the device it belongs to is the panel's copy a helper owns", () => {
    const onTwin = { ...BATTERY_DEVICE, via_device_id: PANEL_TWIN.id };
    expect(owningPanelDevice(onTwin, ALL, HASS_SPAN_ENTRIES)).toBeNull();
  });

  it("is null for a helper's copy of a battery that points at the panel, which the panel's entry does not own", () => {
    const batteryCopy = { ...BATTERY_DEVICE, id: "bess-copy-1", config_entry_id: "helper-entry-2" };
    expect(owningPanelDevice(batteryCopy, ALL, HASS_SPAN_ENTRIES)).toBeNull();
  });
});

describe("sharesOwner", () => {
  it("holds for each of the panel's own devices, and the panel itself", () => {
    for (const device of [HASS_PANEL, CIRCUIT_DEVICE, BATTERY_DEVICE]) expect(sharesOwner(device, HASS_PANEL)).toBe(true);
  });

  it("fails for a device another entry owns, whatever it points at", () => {
    expect(sharesOwner({ ...BATTERY_DEVICE, config_entry_id: "helper-entry-2" }, HASS_PANEL)).toBe(false);
    expect(sharesOwner(SECOND_PANEL, HASS_PANEL)).toBe(false);
  });

  it("fails for a device with no owner, beside a panel with none", () => {
    expect(sharesOwner({ id: "bare-1" }, { id: "bare-panel" })).toBe(false);
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
