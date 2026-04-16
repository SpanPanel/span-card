import { t } from "../i18n.js";
import type { HomeAssistant } from "../types.js";

const DEFAULT_ERROR_TTL = 5_000;

/** A single error or info entry managed by the store. */
export interface ErrorEntry {
  key: string;
  level: "info" | "warning" | "error";
  message: string;
  persistent: boolean;
  ttl?: number;
  retryFn?: () => void;
  timestamp: number;
}

/** Input shape for `add()` — everything except the auto-set timestamp. */
export type AddInput = Omit<ErrorEntry, "timestamp">;

/** Optional filter for `clear()`. When omitted, everything is cleared. */
interface ClearFilter {
  persistent: boolean;
}

/**
 * Two-lane error store.
 *
 * - Persistent lane: `Map<key, ErrorEntry>` — never auto-dismissed.
 * - Transient lane: a single `ErrorEntry | null` — auto-dismissed after TTL.
 *
 * `active` always returns persistent entries first, transient (if any) last.
 */
export class ErrorStore {
  private readonly _persistent = new Map<string, ErrorEntry>();
  private _transient: ErrorEntry | null = null;
  private _transientTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _subscribers = new Set<() => void>();
  private _panelStatusEntityId: string | null = null;
  /** True once the panel has been observed offline at least once. */
  private _wasOffline = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add an error entry. Persistent entries go to the map. Transient entries
   * replace the existing transient slot and reset the auto-dismiss timer.
   */
  add(input: AddInput): void {
    const entry: ErrorEntry = { ...input, timestamp: Date.now() };
    if (entry.persistent) {
      this._persistent.set(entry.key, entry);
    } else {
      this._clearTransient();
      this._transient = entry;
      const ttl = entry.ttl ?? DEFAULT_ERROR_TTL;
      this._transientTimer = setTimeout(() => {
        this._transient = null;
        this._transientTimer = null;
        this._notify();
      }, ttl);
    }
    this._notify();
  }

  /**
   * Remove an entry by key. If the key matches the transient entry, the
   * transient slot is cleared. No-op (no notification) for unknown keys.
   */
  remove(key: string): void {
    if (this._persistent.has(key)) {
      this._persistent.delete(key);
      this._notify();
      return;
    }
    if (this._transient?.key === key) {
      this._clearTransient();
      this._notify();
    }
  }

  /**
   * Clear errors.
   *
   * - No argument: clear everything.
   * - `{ persistent: true }`: clear only persistent errors.
   * - `{ persistent: false }`: clear only the transient error.
   */
  clear(filter?: ClearFilter): void {
    if (filter === undefined) {
      this._persistent.clear();
      this._clearTransient();
    } else if (filter.persistent) {
      this._persistent.clear();
    } else {
      this._clearTransient();
    }
    this._notify();
  }

  /** All active errors — persistent first, transient last (if present). */
  get active(): ErrorEntry[] {
    const entries: ErrorEntry[] = [...this._persistent.values()];
    if (this._transient !== null) {
      entries.push(this._transient);
    }
    return entries;
  }

  /** True when the given key is in the persistent error map. */
  hasPersistent(key: string): boolean {
    return this._persistent.has(key);
  }

  /**
   * Subscribe to state changes. The callback is called after every `add`,
   * `remove`, `clear`, or transient auto-dismiss. Returns an unsubscribe fn.
   */
  subscribe(cb: () => void): () => void {
    this._subscribers.add(cb);
    return () => {
      this._subscribers.delete(cb);
    };
  }

  /**
   * Register the entity ID whose `state` represents panel connectivity.
   * Call `updateHass()` on each hass update to drive error/recovery logic.
   */
  watchPanelStatus(entityId: string): void {
    this._panelStatusEntityId = entityId;
  }

  /**
   * Examine the panel status entity in the current hass snapshot and
   * add/remove the `panel-offline` persistent error accordingly.
   *
   * Reconnection info is posted as a transient once — only after the panel
   * was previously observed to be offline.
   */
  updateHass(hass: HomeAssistant): void {
    if (this._panelStatusEntityId === null) return;

    const entityState = hass.states[this._panelStatusEntityId]?.state;
    const isOnline = entityState === "on";

    if (!isOnline) {
      this._wasOffline = true;
      if (!this.hasPersistent("panel-offline")) {
        this.add({
          key: "panel-offline",
          level: "error",
          message: t("error.panel_offline"),
          persistent: true,
        });
      }
    } else {
      const wasOffline = this._wasOffline;
      this._wasOffline = false;
      this.remove("panel-offline");
      if (wasOffline) {
        this.add({
          key: "panel-reconnected",
          level: "info",
          message: t("error.panel_reconnected"),
          persistent: false,
        });
      }
    }
  }

  /**
   * Release all resources: cancel any pending timer and drop all state.
   * Call in `disconnectedCallback` or test `afterEach`.
   */
  dispose(): void {
    this._clearTransient();
    this._persistent.clear();
    this._subscribers.clear();
    this._panelStatusEntityId = null;
    this._wasOffline = false;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _clearTransient(): void {
    if (this._transientTimer !== null) {
      clearTimeout(this._transientTimer);
      this._transientTimer = null;
    }
    this._transient = null;
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      cb();
    }
  }
}
