import { INTEGRATION_DOMAIN } from "../constants.js";
import { t } from "../i18n.js";
import { RetryManager } from "./retry-manager.js";
import type { Circuit, HomeAssistant, MonitoringPointInfo, MonitoringStatus, MonitoringStatusResponse } from "../types.js";
import type { ErrorStore } from "./error-store.js";

const MONITORING_POLL_INTERVAL_MS = 30_000;

interface CallServiceResponse {
  response?: MonitoringStatusResponse;
}

/**
 * The status a `get_monitoring_status` answer gives, or null when it gives none.
 * With monitoring off the integration answers `enabled: false` and no points:
 * that is no monitoring, not monitoring of zero circuits and zero mains.
 */
export function monitoringStatusFrom(response: MonitoringStatusResponse | null | undefined): MonitoringStatus | null {
  if (!response || response.enabled === false) return null;
  const status: MonitoringStatus = { circuits: response.circuits, mains: response.mains };
  if (response.global_settings) status.global_settings = response.global_settings;
  return status;
}

/**
 * Caches monitoring status fetched via the get_monitoring_status service.
 * Re-fetches at most every 30 seconds.
 */
export class MonitoringStatusCache {
  private _status: MonitoringStatus | null = null;
  private _lastFetch: number = 0;
  private _inflight: { gen: number; promise: Promise<MonitoringStatus | null> } | null = null;
  private _generation: number = 0;
  private _errorStore: ErrorStore | null = null;
  private _retry: RetryManager | null = null;

  get errorStore(): ErrorStore | null {
    return this._errorStore;
  }

  set errorStore(store: ErrorStore | null) {
    this._errorStore = store;
    this._retry = store ? new RetryManager(store) : null;
  }

  /**
   * Fetch monitoring status, returning cached data if recent. Concurrent
   * callers coalesce onto the in-flight promise instead of reading a
   * possibly-stale ``_status`` (the old implementation returned the
   * pre-fetch value while another request was pending, which could
   * surface null on cold starts). A monotonically-increasing generation
   * counter lets ``invalidate()`` supersede in-flight results.
   */
  async fetch(hass: HomeAssistant, configEntryId?: string | null): Promise<MonitoringStatus | null> {
    const now = Date.now();
    // Only dedupe onto an in-flight request from the current generation.
    // Requests predating the last invalidate() must not be reused, or the
    // caller would await a stale promise whose result is silently dropped.
    if (this._inflight && this._inflight.gen === this._generation) return this._inflight.promise;
    if (this._status && now - this._lastFetch < MONITORING_POLL_INTERVAL_MS) {
      return this._status;
    }

    const requestGen = this._generation;
    const promise = (async (): Promise<MonitoringStatus | null> => {
      try {
        const serviceData: Record<string, string> = {};
        if (configEntryId) serviceData.config_entry_id = configEntryId;
        const msg = {
          type: "call_service",
          domain: INTEGRATION_DOMAIN,
          service: "get_monitoring_status",
          service_data: serviceData,
          return_response: true,
        };
        const resp = this._retry
          ? await this._retry.callWS<CallServiceResponse>(hass, msg, {
              errorId: "fetch:monitoring",
              errorMessage: t("error.monitoring_failed"),
            })
          : await hass.callWS<CallServiceResponse>(msg);
        const next = monitoringStatusFrom(resp?.response);
        if (requestGen === this._generation) {
          this._status = next;
          this._lastFetch = Date.now();
        }
        return next;
      } catch (err) {
        console.warn("SPAN Panel: monitoring status fetch failed", err);
        if (requestGen === this._generation) {
          this._status = null;
        }
        if (!this._retry) {
          this._errorStore?.add({
            key: "fetch:monitoring",
            level: "warning",
            message: t("error.monitoring_failed"),
            persistent: false,
          });
        }
        return null;
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

  /** Force the next fetch() call to re-query the backend. */
  invalidate(): void {
    this._lastFetch = 0;
    this._generation++;
  }

  /** Last fetched status. */
  get status(): MonitoringStatus | null {
    return this._status;
  }

  /** Clear cached status (e.g., on config change). */
  clear(): void {
    this._status = null;
    this._lastFetch = 0;
    this._generation++;
  }
}

/**
 * Caches monitoring status per config entry. Used by the Favorites
 * view which must fetch for multiple entries in parallel and would
 * otherwise issue fresh WS calls on every render tick.
 */
export class MonitoringStatusMultiCache {
  private _caches = new Map<string, MonitoringStatusCache>();
  private _errorStore: ErrorStore | null = null;

  get errorStore(): ErrorStore | null {
    return this._errorStore;
  }

  set errorStore(store: ErrorStore | null) {
    this._errorStore = store;
    for (const cache of this._caches.values()) {
      cache.errorStore = store;
    }
  }

  /** Fetch monitoring status for a single entry, honoring the TTL. */
  async fetchOne(hass: HomeAssistant, entryId: string): Promise<MonitoringStatus | null> {
    let cache = this._caches.get(entryId);
    if (!cache) {
      cache = new MonitoringStatusCache();
      cache.errorStore = this._errorStore;
      this._caches.set(entryId, cache);
    }
    return cache.fetch(hass, entryId);
  }

  /** Invalidate every cached entry. */
  invalidate(): void {
    for (const cache of this._caches.values()) cache.invalidate();
  }

  /** Clear entries — used on panel membership changes. */
  clear(): void {
    this._caches.clear();
  }
}

/**
 * Merge multiple MonitoringStatus results into one. Null entries are
 * skipped. Returns null only if every input is null. Later entries
 * overwrite earlier ones on key collision, which is fine because circuit
 * and mains keys are globally-unique entity IDs across config entries.
 */
export function mergeMonitoringStatuses(statuses: readonly (MonitoringStatus | null | undefined)[]): MonitoringStatus | null {
  let hasAny = false;
  const circuits: Record<string, MonitoringPointInfo> = {};
  const mains: Record<string, MonitoringPointInfo> = {};
  for (const status of statuses) {
    if (!status) continue;
    hasAny = true;
    if (status.circuits) Object.assign(circuits, status.circuits);
    if (status.mains) Object.assign(mains, status.mains);
  }
  if (!hasAny) return null;
  return { circuits, mains };
}

/**
 * Get monitoring info for a specific circuit entity.
 */
export function getCircuitMonitoringInfo(status: MonitoringStatus | null, entityId: string): MonitoringPointInfo | null {
  if (!status?.circuits) return null;
  return status.circuits[entityId] ?? null;
}

/**
 * A circuit's monitoring status entry, which is keyed by the circuit's current
 * sensor, else its power sensor. Null where the status has none for it.
 */
export function circuitMonitoringInfo(status: MonitoringStatus | null, circuit: Pick<Circuit, "entities">): MonitoringPointInfo | null {
  return getCircuitMonitoringInfo(status, circuit.entities?.current ?? circuit.entities?.power ?? "");
}

/**
 * Check if a monitored point has custom (non-global) overrides.
 */
export function hasCustomOverrides(monitoringInfo: MonitoringPointInfo | null): boolean {
  if (!monitoringInfo) return false;
  return monitoringInfo.continuous_threshold_pct !== undefined;
}

/** How a point's utilization reads: under its continuous threshold, at or above it, or at or above its spike threshold. */
export type UtilizationLevel = "normal" | "warning" | "alert";

/**
 * The thresholds a point is judged against where monitoring reports none: the integration's defaults, which the card
 * judged every point against before it read each point's own.
 */
const FALLBACK_CONTINUOUS_THRESHOLD_PCT = 80;
const FALLBACK_SPIKE_THRESHOLD_PCT = 100;

/** A point's monitoring thresholds, in percent of the rating it is judged against. */
export interface PointThresholds {
  /** At or above this, the point is a warning, and sustained, a continuous-overload alert. */
  readonly continuousPct: number;
  /** At or above this, the point is an alert. */
  readonly spikePct: number;
}

/**
 * The thresholds a point is judged at: its own, as `get_monitoring_status` reports them (the point's override, else
 * the global setting). 80 % and 100 % stand in only where there is no monitoring info, such as with monitoring off,
 * where the utilization comes from the breaker rating.
 */
export function pointThresholds(monitoringInfo: MonitoringPointInfo | null): PointThresholds {
  return {
    continuousPct: monitoringInfo?.continuous_threshold_pct ?? FALLBACK_CONTINUOUS_THRESHOLD_PCT,
    spikePct: monitoringInfo?.spike_threshold_pct ?? FALLBACK_SPIKE_THRESHOLD_PCT,
  };
}

/**
 * A point's utilization level against its own thresholds (`pointThresholds`): a warning at or above the continuous
 * threshold and an alert at or above the spike threshold, as the monitor judges them, so a point set above 100 % is
 * not an alert below its thresholds.
 */
export function utilizationLevel(pct: number, monitoringInfo: MonitoringPointInfo | null): UtilizationLevel {
  const { continuousPct, spikePct } = pointThresholds(monitoringInfo);
  if (pct >= spikePct) return "alert";
  if (pct >= continuousPct) return "warning";
  return "normal";
}

/** The CSS class that colours a point's utilization by its level (`utilizationLevel`). */
export function utilizationClass(pct: number, monitoringInfo: MonitoringPointInfo | null): string {
  return `utilization-${utilizationLevel(pct, monitoringInfo)}`;
}

/**
 * Get CSS class for the utilization the monitor reports, by its level; empty while it reports none.
 */
export function getUtilizationClass(monitoringInfo: MonitoringPointInfo | null): string {
  if (!monitoringInfo?.utilization_pct) return "";
  return utilizationClass(monitoringInfo.utilization_pct, monitoringInfo);
}

/**
 * Check if a circuit currently has an active alert.
 */
export function isAlertActive(monitoringInfo: MonitoringPointInfo | null): boolean {
  if (!monitoringInfo) return false;
  return monitoringInfo.over_threshold_since != null;
}

/**
 * Build HTML for the monitoring summary bar: how many circuits and mains are monitored, each circuit counted, and
 * how many warnings, alerts and overrides there are, each monitored point counted once.
 */
export function buildMonitoringSummaryHTML(status: MonitoringStatus | null): string {
  if (!status) return "";

  const circuits: MonitoringPointInfo[] = Object.values(status.circuits ?? {});
  const mains: MonitoringPointInfo[] = Object.values(status.mains ?? {});
  // One judgement per monitored point: every member of a shared meter reports its group's under the group's
  // `point_id`. An entry naming no point, from an older integration, is a point of its own.
  const circuitPoints = new Map(
    Object.entries(status.circuits ?? {}).map(([key, p]) => [p.point_id !== undefined ? `point:${p.point_id}` : `entry:${key}`, p])
  );
  const all: MonitoringPointInfo[] = [...circuitPoints.values(), ...mains];

  // Each point by its own thresholds, as the monitor judges it.
  const levels = all.flatMap(p => (p.utilization_pct != null ? [utilizationLevel(p.utilization_pct, p)] : []));
  const warnings = levels.filter(level => level === "warning").length;
  const alerts = levels.filter(level => level === "alert").length;
  const overrides = all.filter(p => p.has_override).length;

  return `
    <div class="monitoring-summary">
      <span class="monitoring-active">&#10003; ${t("status.monitoring")} &middot; ${circuits.length} ${t("status.circuits")} &middot; ${mains.length} ${t("status.mains")}</span>
      <span class="monitoring-counts">
        ${warnings > 0 ? `<span class="count-warning">${warnings} ${warnings > 1 ? t("status.warnings") : t("status.warning")}</span>` : ""}
        ${alerts > 0 ? `<span class="count-alert">${alerts} ${alerts > 1 ? t("status.alerts") : t("status.alert")}</span>` : ""}
        ${overrides > 0 ? `<span class="count-overrides">${overrides} ${overrides > 1 ? t("status.overrides") : t("status.override")}</span>` : ""}
      </span>
    </div>
  `;
}
