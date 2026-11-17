// ── Home Assistant registry entries ──────────────────────────────────────────
//
// The fields the card reads, of the entries `config/device_registry/list` and
// `config/entity_registry/list` answer with. The card asks for those lists
// itself, so it holds each entry as Home Assistant sent it, not as the
// frontend keeps it in `hass.devices` and `hass.entities`.

/**
 * A device in the device registry list.
 *
 * A child device, as each circuit's is of its panel, names its parent in
 * `parent_device_id` and carries no `via_device_id`, `model` or `sw_version`
 * key at all; any other device sends `parent_device_id: null`. The frontend
 * fills a child's missing keys in for `hass.devices`, and the list does not.
 */
export interface DeviceRegistryEntry {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  /** The one config entry that owns the device (Home Assistant 2026.8+). */
  config_entry_id?: string;
  identifiers?: [string, string][];
  via_device_id?: string | null;
  parent_device_id?: string | null;
  area_id?: string | null;
  model?: string;
  sw_version?: string;
}

/**
 * An entity in the entity registry list, which holds disabled entities too.
 * `name` is the user's own; `original_name` is the integration's, without its
 * device's name in front where Home Assistant keeps that form.
 */
export interface EntityRegistryEntry {
  entity_id: string;
  device_id?: string | null;
  unique_id: string;
  platform?: string;
  area_id?: string | null;
  name?: string | null;
  original_name?: string | null;
}

/**
 * An entity as the frontend keeps it in `hass.entities`: the registry's display
 * list, which leaves out disabled entities and every entity's unique id. `name`
 * is the entity's own name, the user's before the integration's, and is absent
 * where it has none. `platform` is the integration that provides the entity.
 */
export interface EntityDisplayEntry {
  entity_id: string;
  device_id?: string;
  area_id?: string;
  name?: string;
  platform?: string;
}

/**
 * Whether a device is a SPAN panel: a device one of the integration's config
 * entries owns, `spanEntryIds` being those entries, that is neither reached
 * through another, as a battery or a charger is through its panel, nor a child
 * of another, as a circuit is of its panel.
 *
 * The owner decides, not the identifiers. Home Assistant 2026.8 split each
 * device that several config entries shared into one device per entry, each
 * keeping the shared device's identifiers, so a helper that had linked itself
 * to a panel owns a device with the panel's SPAN identifier and no parent.
 */
export function isPanelDevice(d: DeviceRegistryEntry, spanEntryIds: ReadonlySet<string>): boolean {
  return d.config_entry_id !== undefined && spanEntryIds.has(d.config_entry_id) && !d.via_device_id && !d.parent_device_id;
}

/**
 * The panel a device belongs to: the panel it is a child of, as a circuit's
 * device is; else the panel it is reached through, as a battery's or a
 * charger's is; else the device itself. Null where that device is not in
 * `devices` or is not a SPAN panel by `isPanelDevice`.
 */
export function owningPanelDevice(
  device: DeviceRegistryEntry,
  devices: Readonly<Record<string, DeviceRegistryEntry>>,
  spanEntryIds: ReadonlySet<string>
): DeviceRegistryEntry | null {
  const panelId = device.parent_device_id || device.via_device_id;
  const panel = panelId ? devices[panelId] : device;
  return panel && isPanelDevice(panel, spanEntryIds) ? panel : null;
}

/** A device's name as Home Assistant shows it: the user's where they gave one, else the integration's; "" for neither. */
export function deviceName(d: DeviceRegistryEntry): string {
  return (d.name_by_user || d.name || "").trim();
}

/**
 * An entity's own name, as Home Assistant reads it: the user's where the
 * registry holds one, else the integration's; "" for an entity with neither.
 * The user's counts even when it is "", which is how the registry records that
 * an entity goes by its device's name alone.
 */
export function entityOwnName(e: EntityRegistryEntry): string {
  return (e.name ?? e.original_name ?? "").trim();
}
