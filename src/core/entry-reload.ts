import type { HomeAssistant } from "../types.js";

/** A config entry as `config_entries/subscribe` reports it; only the fields read here. */
export interface ConfigEntrySummary {
  entry_id: string;
  domain: string;
  state: string;
}

interface ConfigEntryChange {
  type: null | "added" | "removed" | "updated";
  entry: ConfigEntrySummary;
}

const LOADED = "loaded";

/**
 * Call `onLoaded` whenever an accepted config entry finishes loading.
 *
 * Every change that adds or removes a circuit's control happens inside a reload,
 * and `loaded` is the first moment the entity registry is complete, so this is
 * when a topology re-fetch sees the new controls. `entity_registry_updated` was
 * rejected: it names no config entry, fires for every entity in Home Assistant,
 * and fires mid-setup.
 *
 * Core answers each subscribe with a `type: null` batch of the current entries.
 * The first batch seeds each accepted entry's state, and with `initialIsReseed`
 * also reports those already loaded. Every later batch is a re-seed:
 * home-assistant-js-websocket replays the subscription after a reconnect, and
 * across a Home Assistant restart an entry goes loaded → gone → loaded with no
 * transition reported, so each loaded entry in it is reported. An `updated`
 * change reports an accepted entry moving into `loaded` from any other state; one
 * that stays `loaded`, such as a title change, does not.
 */
export async function subscribeEntryReloads(
  hass: HomeAssistant,
  accept: (entry: ConfigEntrySummary) => boolean,
  onLoaded: (entryId: string) => void,
  { initialIsReseed }: { initialIsReseed: boolean }
): Promise<() => Promise<void>> {
  const connection = hass.connection;
  if (!connection) return async () => {};

  const states = new Map<string, string>();
  let seeded = false;

  return connection.subscribeMessage<ConfigEntryChange[]>(
    changes => {
      if (changes.every(change => change.type === null)) {
        const reportLoaded = seeded || initialIsReseed;
        seeded = true;
        states.clear();
        for (const { entry } of changes) {
          if (!accept(entry)) continue;
          states.set(entry.entry_id, entry.state);
          if (reportLoaded && entry.state === LOADED) onLoaded(entry.entry_id);
        }
        return;
      }
      for (const { type, entry } of changes) {
        if (!accept(entry)) continue;
        if (type === "removed") {
          states.delete(entry.entry_id);
          continue;
        }
        const previous = states.get(entry.entry_id);
        states.set(entry.entry_id, entry.state);
        if (type === "updated" && entry.state === LOADED && previous !== LOADED) onLoaded(entry.entry_id);
      }
    },
    { type: "config_entries/subscribe", type_filter: ["device"] }
  );
}
