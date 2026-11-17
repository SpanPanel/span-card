import { INTEGRATION_DOMAIN } from "../constants.js";
import { isPanelDevice } from "./registry-types.js";
import type { DeviceRegistryEntry } from "./registry-types.js";
import type { RetryManager } from "./retry-manager.js";
import type { HomeAssistant } from "../types.js";

/** A config entry as `config_entries/get` lists it; only the field read here. */
interface ConfigEntryListing {
  entry_id: string;
}

/**
 * The error ids the two requests report under, one each, so that one's
 * success clears only its own error and not the other's.
 */
const DEVICES_ERROR_ID = "fetch:devices";
const ENTRIES_ERROR_ID = "fetch:config_entries";

/**
 * The SPAN panels Home Assistant holds, in the device registry's order: the
 * devices `isPanelDevice` takes for panels, judged against the integration's
 * own config entries. Any user may list config entries, so this answers for a
 * user who is not an administrator too.
 *
 * Through `retry` where given, each request under an error id of its own.
 */
export async function discoverPanelDevices(hass: HomeAssistant, retry?: RetryManager | null): Promise<DeviceRegistryEntry[]> {
  const devicesMsg = { type: "config/device_registry/list" };
  const entriesMsg = { type: "config_entries/get", domain: INTEGRATION_DOMAIN };
  const [devices, entries] = await Promise.all([
    retry ? retry.callWS<DeviceRegistryEntry[]>(hass, devicesMsg, { errorId: DEVICES_ERROR_ID }) : hass.callWS<DeviceRegistryEntry[]>(devicesMsg),
    retry ? retry.callWS<ConfigEntryListing[]>(hass, entriesMsg, { errorId: ENTRIES_ERROR_ID }) : hass.callWS<ConfigEntryListing[]>(entriesMsg),
  ]);
  const spanEntryIds = new Set(entries.map(entry => entry.entry_id));
  return devices.filter(device => isPanelDevice(device, spanEntryIds));
}

/**
 * The integration's config entries as the frontend's registries name them,
 * without asking Home Assistant: the entry that owns the device of each of the
 * integration's entities in `hass.entities`, the integration's entities sitting
 * on devices its own entry registered. `hass.entities` holds enabled entities
 * only, so an entry none of whose entities is enabled is not among them; its
 * panel would have no reading to show.
 */
export function spanEntryIdsOf(hass: HomeAssistant): Set<string> {
  const entryIds = new Set<string>();
  for (const entity of Object.values(hass.entities ?? {})) {
    if (entity.platform !== INTEGRATION_DOMAIN || !entity.device_id) continue;
    const owner = hass.devices?.[entity.device_id]?.config_entry_id;
    if (owner) entryIds.add(owner);
  }
  return entryIds;
}
