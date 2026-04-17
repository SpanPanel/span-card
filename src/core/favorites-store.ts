// src/core/favorites-store.ts
import { INTEGRATION_DOMAIN } from "../constants.js";
import { t } from "../i18n.js";
import { RetryManager } from "./retry-manager.js";
import type { FavoritesMap, HomeAssistant } from "../types.js";
import type { ErrorStore } from "./error-store.js";

const FAVORITES_POLL_INTERVAL_MS = 30_000;

/**
 * Event dispatched on ``document`` when favorites have been mutated by
 * any side-panel toggle. Consumers (e.g. the dashboard panel) listen to
 * refresh their synthetic Favorites entry.
 */
export const FAVORITES_CHANGED_EVENT = "favorites-changed";

interface GetFavoritesResponse {
  favorites?: FavoritesMap;
}

interface CallServiceResponse<T> {
  response?: T;
}

async function _callFavoritesService<T>(hass: HomeAssistant, service: string, serviceData: Record<string, unknown> = {}): Promise<T | null> {
  const resp = await hass.callWS<CallServiceResponse<T>>({
    type: "call_service",
    domain: INTEGRATION_DOMAIN,
    service,
    service_data: serviceData,
    return_response: true,
  });
  return resp?.response ?? null;
}

/**
 * Fetch the current favorites map from the HA backend. Always hits the
 * backend; callers should prefer ``FavoritesCache.fetch`` when they want
 * request coalescing.
 */
export async function fetchFavorites(hass: HomeAssistant): Promise<FavoritesMap> {
  const resp = await _callFavoritesService<GetFavoritesResponse>(hass, "get_favorites");
  return resp?.favorites ?? {};
}

/**
 * Mark the entity (a circuit current/power sensor or any sub-device
 * sensor) as a favorite. The backend resolves the entity_id to its
 * panel + (circuit_uuid | sub_device_id) tuple, so callers never need
 * to know storage shapes or internal identifiers.
 */
export async function addFavorite(hass: HomeAssistant, entityId: string): Promise<FavoritesMap> {
  const resp = await _callFavoritesService<GetFavoritesResponse>(hass, "add_favorite", {
    entity_id: entityId,
  });
  document.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT));
  return resp?.favorites ?? {};
}

/**
 * Remove the entity from the favorites map. See ``addFavorite`` for the
 * reasoning behind the entity_id API.
 */
export async function removeFavorite(hass: HomeAssistant, entityId: string): Promise<FavoritesMap> {
  const resp = await _callFavoritesService<GetFavoritesResponse>(hass, "remove_favorite", {
    entity_id: entityId,
  });
  document.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT));
  return resp?.favorites ?? {};
}

/**
 * Cached favorites map with a 30-second TTL and in-flight deduplication.
 * Mirrors ``GraphSettingsCache``'s lifecycle so the dashboard panel can
 * refresh on events (``invalidate()``) without thrashing the backend.
 *
 * A monotonically-increasing ``_generation`` counter lets ``invalidate()``
 * supersede an in-flight fetch: when an invalidate happens while a
 * request is pending, that request's result is not committed to the
 * cache, so the next ``fetch()`` caller re-queries the backend instead
 * of reading stale pre-invalidate data as "fresh".
 */
export class FavoritesCache {
  private _map: FavoritesMap | null;
  private _lastFetch: number;
  private _inflight: { gen: number; promise: Promise<FavoritesMap> } | null;
  private _generation: number;
  private _errorStore: ErrorStore | null = null;
  private _retry: RetryManager | null = null;

  get errorStore(): ErrorStore | null {
    return this._errorStore;
  }

  set errorStore(store: ErrorStore | null) {
    this._errorStore = store;
    this._retry = store ? new RetryManager(store) : null;
  }

  constructor() {
    this._map = null;
    this._lastFetch = 0;
    this._inflight = null;
    this._generation = 0;
  }

  async fetch(hass: HomeAssistant): Promise<FavoritesMap> {
    const now = Date.now();
    // Only dedupe onto an in-flight request from the current generation.
    // Requests predating the last invalidate() must not be reused, or
    // the caller would await a stale promise whose result is dropped.
    if (this._inflight && this._inflight.gen === this._generation) return this._inflight.promise;
    if (this._map && now - this._lastFetch < FAVORITES_POLL_INTERVAL_MS) {
      return this._map;
    }

    const requestGen = this._generation;
    const promise = (async (): Promise<FavoritesMap> => {
      try {
        const msg = {
          type: "call_service",
          domain: INTEGRATION_DOMAIN,
          service: "get_favorites",
          service_data: {},
          return_response: true,
        };
        const resp = this._retry
          ? await this._retry.callWS<CallServiceResponse<GetFavoritesResponse>>(hass, msg, {
              errorId: "fetch:favorites",
              errorMessage: t("error.favorites_fetch_failed"),
            })
          : await hass.callWS<CallServiceResponse<GetFavoritesResponse>>(msg);
        const next = resp?.response?.favorites ?? {};
        if (requestGen === this._generation) {
          this._map = next;
          this._lastFetch = Date.now();
        }
        return next;
      } catch (err) {
        console.warn("SPAN Panel: favorites fetch failed", err);
        if (!this._retry) {
          this._errorStore?.add({
            key: "fetch:favorites",
            level: "warning",
            message: t("error.favorites_fetch_failed"),
            persistent: false,
          });
        }
        return this._map ?? {};
      } finally {
        // Only clear the slot if it still points at this request; a
        // later fetch() that ran after invalidate() may have replaced
        // it with a newer in-flight promise we must not clobber.
        if (this._inflight?.gen === requestGen) {
          this._inflight = null;
        }
      }
    })();
    this._inflight = { gen: requestGen, promise };
    return promise;
  }

  invalidate(): void {
    this._lastFetch = 0;
    this._generation++;
  }

  clear(): void {
    this._map = null;
    this._lastFetch = 0;
    this._generation++;
  }

  get map(): FavoritesMap {
    return this._map ?? {};
  }
}

/**
 * Count the total number of favorited targets (circuits + sub-devices)
 * across all panels.
 */
export function countFavorites(map: FavoritesMap): number {
  let n = 0;
  for (const entry of Object.values(map)) {
    n += (entry.circuits?.length ?? 0) + (entry.sub_devices?.length ?? 0);
  }
  return n;
}

/**
 * True when the user has at least one favorite configured (any kind).
 */
export function hasAnyFavorites(map: FavoritesMap): boolean {
  for (const entry of Object.values(map)) {
    if ((entry.circuits?.length ?? 0) > 0) return true;
    if ((entry.sub_devices?.length ?? 0) > 0) return true;
  }
  return false;
}
