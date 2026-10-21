import type { HomeAssistant } from "../types.js";

/** The bus event the integration fires on every set, clear and reconcile that changes a monitoring rating. */
export const MONITORING_RATING_CHANGED = "span_panel_monitoring_rating_changed";

/** The config entry a rating event names, or null for an event that carries none. */
function eventEntryId(event: unknown): string | null {
  if (typeof event !== "object" || event === null || !("data" in event)) return null;
  const { data } = event;
  if (typeof data !== "object" || data === null || !("config_entry_id" in data)) return null;
  return typeof data.config_entry_id === "string" ? data.config_entry_id : null;
}

/**
 * Call `onChange` whenever a monitoring rating changes on the given config entry.
 *
 * Every card view reads ratings from a topology fetched on render, so without this
 * a monitoring rating made elsewhere (another browser, Developer Tools, a reconcile) would
 * leave it showing the old rating. An event for another entry is ignored: two panels
 * can publish the same circuit id, and each keeps its own corrections.
 *
 * Only administrators may subscribe to this event, which matches `panel_topology`
 * being admin-only; a caller whose topology came from the entity fallback should not
 * subscribe. Resolves to the unsubscribe function.
 */
export async function subscribeMonitoringRatingChanges(hass: HomeAssistant, configEntryId: string, onChange: () => void): Promise<() => void> {
  const connection = hass.connection;
  if (!connection) return () => {};
  return connection.subscribeEvents<unknown>(event => {
    if (eventEntryId(event) === configEntryId) onChange();
  }, MONITORING_RATING_CHANGED);
}
