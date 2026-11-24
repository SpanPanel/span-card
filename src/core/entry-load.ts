import { t } from "../i18n.js";
import type { ConfigEntrySummary } from "./entry-reload.js";

// ── Refusals a panel's entry loading ends ────────────────────────────────────

/** home-assistant-js-websocket's code for a lost connection, its `ERR_CONNECTION_LOST`. */
const ERR_CONNECTION_LOST = 3;

/**
 * Whether home-assistant-js-websocket rejected a call because the connection
 * was lost: with an error result carrying the code, `{ type: "result",
 * success: false, error: { code: 3, message } }`. From 9.8.0, which the
 * frontend of every Home Assistant the integration supports pins, that is how
 * it rejects every call the lost connection cut off, one sent while the socket
 * is down, and one queued during a reconnect: `sendMessagePromise`, which
 * `hass.callWS` sends through, turns the bare code `sendMessage` throws into
 * that result.
 */
export function isConnectionLost(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("error" in err)) return false;
  const { error } = err;
  return typeof error === "object" && error !== null && "code" in error && error.code === ERR_CONNECTION_LOST;
}

/**
 * The codes Home Assistant refuses a command for one panel with until the
 * panel's config entry has loaded: the integration's `not_loaded` while the
 * entry is not loaded, and Home Assistant's own `unknown_command` before the
 * integration has registered its commands, which it does as the first of its
 * entries sets up. The integration's `no_data`, for a loaded entry with no data,
 * is not among them: setup waits for the first data before the entry can load
 * (`async_config_entry_first_refresh`), and an update keeps the data it held.
 */
const ENTRY_NOT_LOADED_CODES: ReadonlySet<unknown> = new Set(["not_loaded", "unknown_command"]);

/**
 * Whether Home Assistant refused a command for one panel, `panel_topology` or
 * `adopted/list`, until the panel's config entry loads: the entry has not
 * loaded (`ENTRY_NOT_LOADED_CODES`), or the connection to Home Assistant was
 * lost (`isConnectionLost`), as across a restart. The integration resolves the
 * panel and refuses an entry that has not loaded by the same checks for each
 * such command, and Home Assistant's refusals are plain `{ code, message }`
 * objects. Every other failure, such as for a device that is not a SPAN panel,
 * is one that the entry loading does not end. Whether the entry will load by
 * itself is what the entry says of itself (`entryLoadOf`).
 */
export function isRefusedUntilEntryLoads(err: unknown): boolean {
  if (isConnectionLost(err)) return true;
  return typeof err === "object" && err !== null && "code" in err && ENTRY_NOT_LOADED_CODES.has(err.code);
}

/**
 * What a view's read of its panel answers, in place of what it read, where it
 * drew nothing because the panel's entry has not loaded (`isRefusedUntilEntryLoads`):
 * the sidebar dashboard says what the wait says, in the view's place.
 */
export const AWAITING_LOAD = "awaiting_load";

// ── What a panel's entry says of itself ──────────────────────────────────────

/**
 * Where a panel's config entry stands, as its state and who disabled it say:
 * loaded; on its way to loading by itself; failed to set up; or disabled.
 */
export type EntryLoad = "loaded" | "loading" | "setup_failed" | "disabled";

/**
 * The entry states from which no setup follows by itself. `setup_error`, as
 * where the integration raised `ConfigEntryAuthFailed` into a reauth, is set
 * right in Settings → Devices & services, whose reauth or reconfigure loads the
 * entry again. `migration_error` and `failed_unload` are states Core does not
 * unload or reload an entry from, so they need a Home Assistant restart once
 * the cause is set right; the entry loads as Home Assistant starts. A view that
 * waits on any of them draws the panel once the entry loads.
 */
const SETUP_FAILED_STATES: ReadonlySet<string> = new Set(["setup_error", "migration_error", "failed_unload"]);

/**
 * Where entry `entry` stands (`EntryLoad`), as `config_entries/subscribe`
 * reports it. A disabled entry is disabled whatever its state. Every state but
 * `loaded` and those of `SETUP_FAILED_STATES` is on its way to loading:
 * `not_loaded` before setup starts, `setup_in_progress`, `setup_retry` between
 * the retries of a panel setup cannot reach, and `unload_in_progress`, which a
 * reload's setup follows.
 */
export function entryLoadOf({ state, disabled_by }: Pick<ConfigEntrySummary, "state" | "disabled_by">): EntryLoad {
  if (disabled_by) return "disabled";
  if (state === "loaded") return "loaded";
  return SETUP_FAILED_STATES.has(state) ? "setup_failed" : "loading";
}

// ── What a view that waits for a panel's entry says ──────────────────────────

/**
 * What a view that waits for its panel's entry to load says: that it waits,
 * where the entry will load by itself or has said nothing yet; else why it will
 * not, that setup failed or that the panel is disabled.
 */
export type EntryWait = "waiting" | "setup_failed" | "disabled";

/** What a view waiting for an entry that stands at `load` says; undefined where the entry has said nothing yet. */
export function entryWaitOf(load: EntryLoad | undefined): EntryWait {
  return load === "setup_failed" || load === "disabled" ? load : "waiting";
}

/**
 * What a view waiting on several panels' entries at once says, from what it
 * would say of each: that it waits while any of them can still load, else that
 * setup failed where one of them failed, else that they are disabled.
 */
export function combinedEntryWait(waits: readonly [EntryWait, ...EntryWait[]]): EntryWait {
  if (waits.includes("waiting")) return "waiting";
  return waits.includes("setup_failed") ? "setup_failed" : "disabled";
}

/** The line a view shows in place of its panel while it waits: what it says, its role, and its colour. */
export interface EntryWaitLine {
  readonly text: string;
  readonly role: "status" | "alert";
  readonly color: string;
}

/**
 * The line for each wait, read as it is drawn, in the language then set.
 * Waiting is a status in the secondary text colour, as the card's "Connecting"
 * line is; a wait that will not end by itself is an alert in the error colour
 * that says where the user sets it right.
 */
const WAIT_LINES: Readonly<Record<EntryWait, () => EntryWaitLine>> = {
  waiting: () => ({ text: t("card.waiting_for_load"), role: "status", color: "var(--secondary-text-color)" }),
  setup_failed: () => ({ text: t("card.setup_failed"), role: "alert", color: "var(--error-color)" }),
  disabled: () => ({ text: t("card.panel_disabled"), role: "alert", color: "var(--error-color)" }),
};

/** The line for `wait` (`WAIT_LINES`). */
export function entryWaitLine(wait: EntryWait): EntryWaitLine {
  return WAIT_LINES[wait]();
}

/** Show the line for `wait` (`entryWaitLine`) in place of what `container` holds, as the sidebar dashboard's views do. */
export function showEntryWait(container: HTMLElement, wait: EntryWait): void {
  const { text, role, color } = entryWaitLine(wait);
  const line = document.createElement("div");
  line.setAttribute("role", role);
  line.style.padding = "24px";
  line.style.color = color;
  line.textContent = text;
  container.replaceChildren(line);
}
