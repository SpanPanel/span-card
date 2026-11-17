import type { DeviceRegistryEntry, EntityDisplayEntry } from "../src/core/registry-types.js";
import type { HomeAssistant } from "../src/types.js";

/**
 * The integration's devices as the frontend keeps them in `hass.devices`, every
 * name and id illustrative. The frontend completes a circuit's child device
 * from its panel's entry and gives it `via_device_id: null`; a battery is a
 * regular device reached through its panel.
 */
export const SERIAL = "sp3-test-001";

export const PANEL: DeviceRegistryEntry = {
  id: "panel-device-1",
  name: "SPAN Panel",
  name_by_user: null,
  identifiers: [["span_panel", SERIAL]],
  via_device_id: null,
  parent_device_id: null,
};

export const SECOND_PANEL: DeviceRegistryEntry = {
  id: "panel-device-2",
  name: "SPAN Panel 2",
  name_by_user: "Garage Panel",
  identifiers: [["span_panel", "sp3-test-002"]],
  via_device_id: null,
  parent_device_id: null,
};

export const CIRCUIT_DEVICE: DeviceRegistryEntry = {
  id: "circuit-device-1",
  name: "Kitchen Outlets",
  name_by_user: null,
  config_entry_id: "entry-1",
  identifiers: [["span_panel", `${SERIAL}_circuit_0123456789abcdef`]],
  via_device_id: null,
  parent_device_id: PANEL.id,
};

export const BATTERY_DEVICE: DeviceRegistryEntry = {
  id: "bess-device-1",
  name: "SPAN Panel Battery",
  name_by_user: null,
  identifiers: [["span_panel", `${SERIAL}_bess`]],
  via_device_id: PANEL.id,
  parent_device_id: null,
};

export const OTHER_DEVICE: DeviceRegistryEntry = {
  id: "other-device-1",
  name: "Thermostat",
  name_by_user: null,
  identifiers: [["other_domain", "thermostat-1"]],
  via_device_id: null,
  parent_device_id: null,
};

/** A Home Assistant whose registries hold these devices and entities, with no states and no backend. */
export function hassWithRegistries(devices: DeviceRegistryEntry[], entities: EntityDisplayEntry[] = []): HomeAssistant {
  return {
    states: {},
    services: {},
    language: "en",
    callService: () => Promise.reject(new Error("no backend")),
    callWS: () => Promise.reject(new Error("no backend")),
    devices: Object.fromEntries(devices.map(device => [device.id, device])),
    entities: Object.fromEntries(entities.map(entity => [entity.entity_id, entity])),
  };
}
