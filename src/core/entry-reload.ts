import { entryLoadOf } from "./entry-load.js";
import type { EntryLoad } from "./entry-load.js";
import type { HomeAssistant } from "../types.js";

/** A config entry as `config_entries/subscribe` reports it; only the fields read here. */
export interface ConfigEntrySummary {
  entry_id: string;
  domain: string;
  state: string;
  /** Who disabled the entry, `user` being the one disabler Core 2026.11 has; null where it is enabled. */
  disabled_by: string | null;
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
 *
 * `onStatus`, where given, hears where each accepted entry stands
 * (`entryLoadOf`): for each entry of the first batch, and again as that
 * changes, and null once the entry is removed, or missing from a re-seed, as
 * for one removed while the connection was down. `onSeed`, where given, hears
 * each batch of the current entries once it has been taken in: the first one,
 * which comes over a live connection, and each re-seed after a reconnect.
 */
export async function subscribeEntryReloads(
  hass: HomeAssistant,
  accept: (entry: ConfigEntrySummary) => boolean,
  onLoaded: (entryId: string) => void,
  { initialIsReseed, onStatus, onSeed }: { initialIsReseed: boolean; onStatus?: (entryId: string, load: EntryLoad | null) => void; onSeed?: () => void }
): Promise<() => Promise<void>> {
  // The frontend's Home Assistant always carries its connection; the type leaves it optional for the views that need none.
  const connection = hass.connection;
  if (!connection) throw new Error("subscribeEntryReloads: Home Assistant has no connection");

  const states = new Map<string, string>();
  /** Where each accepted entry stands, as last reported to `onStatus`. */
  const loads = new Map<string, EntryLoad>();
  let seeded = false;

  const report = (entry: ConfigEntrySummary): void => {
    const load = entryLoadOf(entry);
    if (loads.get(entry.entry_id) === load) return;
    loads.set(entry.entry_id, load);
    onStatus?.(entry.entry_id, load);
  };
  // Called only for an entry reported before: Core sends each subscription its batch of the current entries before any change.
  const forget = (entryId: string): void => {
    loads.delete(entryId);
    onStatus?.(entryId, null);
  };

  return connection.subscribeMessage<ConfigEntryChange[]>(
    changes => {
      if (changes.every(change => change.type === null)) {
        const reportLoaded = seeded || initialIsReseed;
        seeded = true;
        states.clear();
        for (const { entry } of changes) {
          if (!accept(entry)) continue;
          states.set(entry.entry_id, entry.state);
          report(entry);
          if (reportLoaded && entry.state === LOADED) onLoaded(entry.entry_id);
        }
        for (const entryId of [...loads.keys()]) {
          if (!states.has(entryId)) forget(entryId);
        }
        onSeed?.();
        return;
      }
      for (const { type, entry } of changes) {
        if (!accept(entry)) continue;
        if (type === "removed") {
          states.delete(entry.entry_id);
          forget(entry.entry_id);
          continue;
        }
        const previous = states.get(entry.entry_id);
        states.set(entry.entry_id, entry.state);
        report(entry);
        if (type === "updated" && entry.state === LOADED && previous !== LOADED) onLoaded(entry.entry_id);
      }
    },
    { type: "config_entries/subscribe", type_filter: ["device"] }
  );
}
