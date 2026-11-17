import type { DeviceRegistryEntry, EntityDisplayEntry } from "../src/core/registry-types.js";
import type { HomeAssistant } from "../src/types.js";

/**
 * The integration's devices as the frontend keeps them in `hass.devices`, every
 * name and id illustrative. The frontend completes a circuit's child device
 * from its panel's entry and gives it `via_device_id: null`; a battery is a
 * regular device reached through its panel. Each panel has a config entry of
 * the integration's, which owns the panel and its devices.
 */
export const SERIAL = "sp3-test-001";
export const SPAN_ENTRY = "span-entry-1";
export const SECOND_SPAN_ENTRY = "span-entry-2";
/** A helper's config entry, from a helper linked to the first panel before Home Assistant 2026.8. */
export const HELPER_ENTRY = "helper-entry-1";

export const PANEL: DeviceRegistryEntry = {
  id: "panel-device-1",
  name: "SPAN Panel",
  name_by_user: null,
  config_entry_id: SPAN_ENTRY,
  identifiers: [["span_panel", SERIAL]],
  via_device_id: null,
  parent_device_id: null,
};

/**
 * The device the helper's entry owns since Home Assistant 2026.8 split the
 * device it shared with the panel: a copy of the panel's, its SPAN identifier
 * included, under the helper's entry.
 */
export const PANEL_TWIN: DeviceRegistryEntry = { ...PANEL, id: "panel-twin-1", config_entry_id: HELPER_ENTRY };

export const SECOND_PANEL: DeviceRegistryEntry = {
  id: "panel-device-2",
  name: "SPAN Panel 2",
  name_by_user: "Garage Panel",
  config_entry_id: SECOND_SPAN_ENTRY,
  identifiers: [["span_panel", "sp3-test-002"]],
  via_device_id: null,
  parent_device_id: null,
};

export const CIRCUIT_DEVICE: DeviceRegistryEntry = {
  id: "circuit-device-1",
  name: "Kitchen Outlets",
  name_by_user: null,
  config_entry_id: SPAN_ENTRY,
  identifiers: [["span_panel", `${SERIAL}_circuit_0123456789abcdef`]],
  via_device_id: null,
  parent_device_id: PANEL.id,
};

export const BATTERY_DEVICE: DeviceRegistryEntry = {
  id: "bess-device-1",
  name: "SPAN Panel Battery",
  name_by_user: null,
  config_entry_id: SPAN_ENTRY,
  identifiers: [["span_panel", `${SERIAL}_bess`]],
  via_device_id: PANEL.id,
  parent_device_id: null,
};

export const OTHER_DEVICE: DeviceRegistryEntry = {
  id: "other-device-1",
  name: "Thermostat",
  name_by_user: null,
  config_entry_id: "other-entry-1",
  identifiers: [["other_domain", "thermostat-1"]],
  via_device_id: null,
  parent_device_id: null,
};

/**
 * A Home Assistant whose registries hold these devices and entities, with no
 * states. Its backend answers the device registry list with the devices and
 * the integration's config entries with `spanEntries`, and nothing else.
 */
export function hassWithRegistries(
  devices: DeviceRegistryEntry[],
  entities: EntityDisplayEntry[] = [],
  spanEntries: string[] = [SPAN_ENTRY, SECOND_SPAN_ENTRY]
): HomeAssistant {
  const callWS = <T>(msg: Record<string, unknown>): Promise<T> => {
    if (msg.type === "config/device_registry/list") return Promise.resolve(structuredClone(devices) as T);
    if (msg.type === "config_entries/get" && msg.domain === "span_panel")
      return Promise.resolve(spanEntries.map(entry_id => ({ entry_id, domain: "span_panel" })) as T);
    return Promise.reject(new Error(`unexpected ${String(msg.type)}`));
  };
  return {
    states: {},
    services: {},
    language: "en",
    callService: () => Promise.reject(new Error("no backend")),
    callWS,
    devices: Object.fromEntries(devices.map(device => [device.id, device])),
    entities: Object.fromEntries(entities.map(entity => [entity.entity_id, entity])),
  };
}
