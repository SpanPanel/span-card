import type { HomeAssistant } from "../types.js";

/** The bus event the integration fires on every set, clear and reconcile that changes a circuit's package ratings. */
export const PACKAGE_RATINGS_CHANGED = "span_panel_package_ratings_changed";

/** A rating event's data, or null for an event that carries none. */
function eventData(event: unknown): object | null {
  if (typeof event !== "object" || event === null || !("data" in event)) return null;
  const { data } = event;
  return typeof data === "object" && data !== null ? data : null;
}

/** The config entry a rating event names, or null for an event that carries none. */
function eventEntryId(event: unknown): string | null {
  const data = eventData(event);
  if (!data || !("config_entry_id" in data)) return null;
  return typeof data.config_entry_id === "string" ? data.config_entry_id : null;
}

/** The circuits a rating event names, or null for one that names none in the shape the integration sends: any circuit, then. */
function eventCircuitIds(event: unknown): ReadonlySet<string> | null {
  const data = eventData(event);
  if (!data || !("circuit_ids" in data) || !Array.isArray(data.circuit_ids)) return null;
  const ids: unknown[] = data.circuit_ids;
  return ids.every((id): id is string => typeof id === "string") ? new Set(ids) : null;
}

/** Two events' circuits together; null, any circuit, when either names none. */
export function mergeCircuitIds(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): ReadonlySet<string> | null {
  return a === null || b === null ? null : new Set([...a, ...b]);
}

/**
 * Call `onChange` whenever the package ratings copied from the SPAN app change on the given config entry, with the
 * circuits the event names (null where it names none, so any circuit may have changed).
 *
 * Every card view reads ratings from a topology fetched on render, so without this
 * a copy made elsewhere (another browser, Developer Tools, a reconcile that removes
 * one) would leave it showing the old monitoring rating. An event for another entry
 * is ignored: two panels can publish the same circuit id, and each keeps its own copies.
 *
 * Only administrators may subscribe to this event, which matches `panel_topology`
 * being admin-only; a caller whose topology came from the entity fallback should not
 * subscribe. Resolves to the unsubscribe function.
 */
export async function subscribePackageRatingChanges(
  hass: HomeAssistant,
  configEntryId: string,
  onChange: (circuitIds: ReadonlySet<string> | null) => void
): Promise<() => void> {
  const connection = hass.connection;
  if (!connection) return () => {};
  return connection.subscribeEvents<unknown>(event => {
    if (eventEntryId(event) === configEntryId) onChange(eventCircuitIds(event));
  }, PACKAGE_RATINGS_CHANGED);
}
