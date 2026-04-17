import { t, tf } from "../i18n.js";
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
 * Per-entity state for a watched panel_status entity.
 *
 * `panelName === null` marks the legacy single-panel case (per-panel view).
 * In that case the persistent key and message omit the panel name so the
 * banner reads "SPAN Panel unreachable" exactly as before.
 *
 * `panelName !== null` marks the multi-panel case (Favorites view). The
 * persistent key is suffixed with the entity id and the message names the
 * panel, so the banner reads e.g. "Span Panel 2 unreachable".
 */
interface WatchedPanelEntry {
  panelName: string | null;
  /** True once this entity has been observed off at least once. */
  wasOffline: boolean;
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
  private _watchedPanels = new Map<string, WatchedPanelEntry>();

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
      this._watchedPanels.clear();
    } else if (filter.persistent === true) {
      this._persistent.clear();
    } else if (filter.persistent === false) {
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
   * True when any watched panel is currently marked offline. Covers both
   * the legacy single-unnamed key (``panel-offline``) used by per-panel
   * views and the per-entity keys (``panel-offline:<entityId>``) used by
   * the Favorites multi-panel watch. ``RetryManager`` uses this to
   * short-circuit retries without needing to know the naming mode.
   */
  hasAnyPanelOffline(): boolean {
    for (const key of this._persistent.keys()) {
      if (key === "panel-offline" || key.startsWith("panel-offline:")) return true;
    }
    return false;
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
   * Register a single panel_status entity to watch. Per-panel views call
   * this; the resulting banner is unnamed ("SPAN Panel unreachable") to
   * match the title bar which already names the panel.
   *
   * Thin wrapper around `watchPanelStatuses`.
   */
  watchPanelStatus(entityId: string): void {
    this.watchPanelStatuses([{ entityId, panelName: null }]);
  }

  /**
   * Register 0+ panel_status entities to watch with optional panel names.
   * Replaces the current watch set wholesale.
   *
   * Entities carried over from the previous watch set preserve their
   * `wasOffline` flag so no spurious reconnect toast fires on re-registration.
   *
   * Any persistent `panel-offline*` keys for entities dropped from the
   * watch set are removed.
   */
  watchPanelStatuses(entries: ReadonlyArray<{ entityId: string; panelName?: string | null }>): void {
    const prev = this._watchedPanels;
    const next = new Map<string, WatchedPanelEntry>();
    for (const entry of entries) {
      const carry = prev.get(entry.entityId);
      next.set(entry.entityId, {
        panelName: entry.panelName ?? null,
        wasOffline: carry?.wasOffline ?? false,
      });
    }

    // Drop stale persistent banners from the previous watch set. For each
    // entity that was watched, remove its prev-mode key unless it is still
    // watched in the same naming mode (single-unnamed vs multi-named).
    // This one sweep covers both removals and naming-mode changes.
    const prevIsSingleUnnamed = this._isSingleUnnamed(prev);
    const nextIsSingleUnnamed = this._isSingleUnnamed(next);
    for (const entityId of prev.keys()) {
      const stillWatchedSameMode = next.has(entityId) && prevIsSingleUnnamed === nextIsSingleUnnamed;
      if (stillWatchedSameMode) continue;
      this._persistent.delete(this._offlineKey(entityId, prevIsSingleUnnamed));
    }

    this._watchedPanels = next;
    this._notify();
  }

  /**
   * Clear the panel status watch entirely (e.g. when switching panels and
   * we want no banner until the new watch is set up).
   */
  clearPanelStatusWatch(): void {
    if (this._watchedPanels.size === 0) return;
    const isSingleUnnamed = this._isSingleUnnamed(this._watchedPanels);
    for (const entityId of this._watchedPanels.keys()) {
      this._persistent.delete(this._offlineKey(entityId, isSingleUnnamed));
    }
    this._watchedPanels.clear();
    this._notify();
  }

  /**
   * Examine each watched panel_status entity in the current hass snapshot
   * and add/remove `panel-offline*` persistent errors accordingly.
   *
   * Reconnection info is posted as a transient (per-entity key) — only
   * after that entity was previously observed to be offline.
   */
  updateHass(hass: HomeAssistant): void {
    if (this._watchedPanels.size === 0) return;

    const isSingleUnnamed = this._isSingleUnnamed(this._watchedPanels);

    for (const [entityId, entry] of this._watchedPanels) {
      const entityState = hass.states[entityId]?.state;
      const isOnline = entityState === "on";

      const offlineKey = this._offlineKey(entityId, isSingleUnnamed);
      const reconnectKey = this._reconnectKey(entityId, isSingleUnnamed);

      if (!isOnline) {
        entry.wasOffline = true;
        if (!this.hasPersistent(offlineKey)) {
          this.add({
            key: offlineKey,
            level: "error",
            message: entry.panelName === null ? t("error.panel_offline") : tf("error.panel_offline_named", { name: entry.panelName }),
            persistent: true,
          });
        }
      } else {
        const wasOffline = entry.wasOffline;
        entry.wasOffline = false;
        this.remove(offlineKey);
        if (wasOffline) {
          this.add({
            key: reconnectKey,
            level: "info",
            message: entry.panelName === null ? t("error.panel_reconnected") : tf("error.panel_reconnected_named", { name: entry.panelName }),
            persistent: false,
          });
        }
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
    this._watchedPanels.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * True when the map represents the legacy single-unnamed case: exactly
   * one entry, with `panelName === null`. Used by `updateHass`,
   * `watchPanelStatuses`, and `clearPanelStatusWatch` to pick the correct
   * persistent-key and message form.
   */
  private _isSingleUnnamed(map: ReadonlyMap<string, WatchedPanelEntry>): boolean {
    if (map.size !== 1) return false;
    for (const entry of map.values()) {
      return entry.panelName === null;
    }
    return false;
  }

  /**
   * Persistent-key name for the offline banner scoped to a single entity.
   * Single-unnamed mode (per-panel view) uses the legacy unsuffixed key.
   */
  private _offlineKey(entityId: string, isSingleUnnamed: boolean): string {
    return isSingleUnnamed ? "panel-offline" : `panel-offline:${entityId}`;
  }

  /**
   * Transient-key name for the reconnect toast scoped to a single entity.
   * Mirror of `_offlineKey` for the recovery path.
   */
  private _reconnectKey(entityId: string, isSingleUnnamed: boolean): string {
    return isSingleUnnamed ? "panel-reconnected" : `panel-reconnected:${entityId}`;
  }

  private _clearTransient(): void {
    if (this._transientTimer !== null) {
      clearTimeout(this._transientTimer);
      this._transientTimer = null;
    }
    this._transient = null;
  }

  private _notify(): void {
    // Subscribers may be arbitrary renderers; an exception from one must
    // not starve the others or leave the transient timer callback in a
    // half-notified state.
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        console.warn("SPAN Panel: error-store subscriber threw", err);
      }
    }
  }
}
