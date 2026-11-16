import type { HomeAssistant, PanelTopology } from "../types.js";

/** The bus event the device registry fires for every device it creates, updates or removes. */
export const DEVICE_REGISTRY_UPDATED = "device_registry_updated";

/** The device fields a rename changes: the integration's name for the device, and the user's. */
const NAME_FIELDS = ["name", "name_by_user"] as const;

/**
 * The device a `device_registry_updated` event says was renamed, by the user or
 * by the integration; null for any other event.
 *
 * An update's data is `{ action: "update", device_id, changes }`, where
 * `changes` holds the old value of each field the update changed, so a rename
 * is an update whose changes hold a name. A child device's update, as a
 * circuit's device is of its panel's, has the same shape.
 */
export function renamedDeviceId(event: unknown): string | null {
  if (typeof event !== "object" || event === null || !("data" in event)) return null;
  const { data } = event;
  if (typeof data !== "object" || data === null) return null;
  if (!("action" in data) || data.action !== "update") return null;
  if (!("device_id" in data) || typeof data.device_id !== "string") return null;
  if (!("changes" in data)) return null;
  const { changes } = data;
  if (typeof changes !== "object" || changes === null) return null;
  return NAME_FIELDS.some(field => field in changes) ? data.device_id : null;
}

/**
 * Whether a topology reads a label from the device: the panel's, a circuit's
 * own, or a battery's or a charger's. A rename of any other device changes
 * nothing the topology shows.
 */
export function topologyNamesDevice(topology: PanelTopology, deviceId: string): boolean {
  if ((topology.panel_device_id ?? topology.device_id) === deviceId) return true;
  if (Object.keys(topology.sub_devices ?? {}).includes(deviceId)) return true;
  return Object.values(topology.circuits).some(circuit => circuit.device_id === deviceId);
}

/**
 * Call `onRenamed` whenever a device is renamed that the topology `getTopology`
 * returns reads a label from.
 *
 * A circuit is labelled by its device, and the user renames a device in Home
 * Assistant without the panel's entry reloading, so this event is the only
 * word of it. Discovery wrote the label into the topology, and it is discovery
 * that knows where each label comes from, so the caller answers by fetching
 * the topology again. The topology is read when the event arrives; the
 * subscription is never re-created for a re-fetch. Any user may subscribe to
 * this event. Resolves to the unsubscribe function.
 */
export async function subscribeDeviceRenames(hass: HomeAssistant, getTopology: () => PanelTopology | null, onRenamed: () => void): Promise<() => void> {
  const connection = hass.connection;
  if (!connection) return () => {};
  return connection.subscribeEvents<unknown>(event => {
    const deviceId = renamedDeviceId(event);
    const topology = deviceId ? getTopology() : null;
    if (deviceId && topology && topologyNamesDevice(topology, deviceId)) onRenamed();
  }, DEVICE_REGISTRY_UPDATED);
}
