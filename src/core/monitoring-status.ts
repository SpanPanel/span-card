import { INTEGRATION_DOMAIN } from "../constants.js";
import { t } from "../i18n.js";
import type { HomeAssistant, MonitoringPointInfo, MonitoringStatus } from "../types.js";
import type { ErrorStore } from "./error-store.js";

const MONITORING_POLL_INTERVAL_MS = 30_000;

interface CallServiceResponse {
  response?: MonitoringStatus;
}

/**
 * Caches monitoring status fetched via the get_monitoring_status service.
 * Re-fetches at most every 30 seconds.
 */
export class MonitoringStatusCache {
  private _status: MonitoringStatus | null = null;
  private _lastFetch: number = 0;
  private _fetching: boolean = false;
  errorStore: ErrorStore | null = null;

  /**
   * Fetch monitoring status, returning cached data if recent.
   */
  async fetch(hass: HomeAssistant, configEntryId?: string | null): Promise<MonitoringStatus | null> {
    const now = Date.now();
    if (this._fetching) return this._status;
    if (this._status && now - this._lastFetch < MONITORING_POLL_INTERVAL_MS) {
      return this._status;
    }

    this._fetching = true;
    try {
      const serviceData: Record<string, string> = {};
      if (configEntryId) serviceData.config_entry_id = configEntryId;
      const resp = await hass.callWS<CallServiceResponse>({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_monitoring_status",
        service_data: serviceData,
        return_response: true,
      });
      this._status = resp?.response ?? null;
      this._lastFetch = now;
    } catch (err) {
      console.warn("SPAN Panel: monitoring status fetch failed", err);
      this._status = null;
      this.errorStore?.add({
        key: "fetch:monitoring",
        level: "warning",
        message: t("error.monitoring_failed"),
        persistent: false,
      });
    } finally {
      this._fetching = false;
    }
    return this._status;
  }

  /** Force the next fetch() call to re-query the backend. */
  invalidate(): void {
    this._lastFetch = 0;
  }

  /** Last fetched status. */
  get status(): MonitoringStatus | null {
    return this._status;
  }

  /** Clear cached status (e.g., on config change). */
  clear(): void {
    this._status = null;
    this._lastFetch = 0;
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
 * Check if a monitored point has custom (non-global) overrides.
 */
export function hasCustomOverrides(monitoringInfo: MonitoringPointInfo | null): boolean {
  if (!monitoringInfo) return false;
  return monitoringInfo.continuous_threshold_pct !== undefined;
}

/**
 * Get CSS class for utilization level.
 */
export function getUtilizationClass(monitoringInfo: MonitoringPointInfo | null): string {
  if (!monitoringInfo?.utilization_pct) return "";
  const pct = monitoringInfo.utilization_pct;
  if (pct >= 100) return "utilization-alert";
  if (pct >= 80) return "utilization-warning";
  return "utilization-normal";
}

/**
 * Check if a circuit currently has an active alert.
 */
export function isAlertActive(monitoringInfo: MonitoringPointInfo | null): boolean {
  if (!monitoringInfo) return false;
  return monitoringInfo.over_threshold_since != null;
}

/**
 * Build HTML for the monitoring summary bar.
 */
export function buildMonitoringSummaryHTML(status: MonitoringStatus | null): string {
  if (!status) return "";

  const circuits: MonitoringPointInfo[] = Object.values(status.circuits ?? {});
  const mains: MonitoringPointInfo[] = Object.values(status.mains ?? {});
  const all: MonitoringPointInfo[] = [...circuits, ...mains];

  const warnings = all.filter(p => p.utilization_pct !== undefined && p.utilization_pct >= 80 && p.utilization_pct < 100).length;
  const alerts = all.filter(p => p.utilization_pct !== undefined && p.utilization_pct >= 100).length;
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
