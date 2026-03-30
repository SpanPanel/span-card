// src/core/monitoring-status.js
import { INTEGRATION_DOMAIN } from "../constants.js";
import { t } from "../i18n.js";

const MONITORING_POLL_INTERVAL_MS = 30_000;

/**
 * Caches monitoring status fetched via the get_monitoring_status service.
 * Re-fetches at most every 30 seconds.
 */
export class MonitoringStatusCache {
  constructor() {
    this._status = null;
    this._lastFetch = 0;
    this._fetching = false;
  }

  /**
   * Fetch monitoring status, returning cached data if recent.
   * @param {object} hass - Home Assistant instance
   * @returns {Promise<object|null>} Monitoring status or null
   */
  async fetch(hass) {
    const now = Date.now();
    if (this._fetching) return this._status;
    if (this._status && now - this._lastFetch < MONITORING_POLL_INTERVAL_MS) {
      return this._status;
    }

    this._fetching = true;
    try {
      const resp = await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_monitoring_status",
        service_data: {},
        return_response: true,
      });
      this._status = resp?.response || null;
      this._lastFetch = now;
    } catch {
      this._status = null;
    } finally {
      this._fetching = false;
    }
    return this._status;
  }

  /** Force the next fetch() call to re-query the backend. */
  invalidate() {
    this._lastFetch = 0;
  }

  /** @returns {object|null} Last fetched status */
  get status() {
    return this._status;
  }

  /** Clear cached status (e.g., on config change). */
  clear() {
    this._status = null;
    this._lastFetch = 0;
  }
}

/**
 * Get monitoring info for a specific circuit entity.
 * @param {object|null} status - Full monitoring status
 * @param {string} entityId - Circuit entity ID
 * @returns {object|null} Circuit monitoring info or null
 */
export function getCircuitMonitoringInfo(status, entityId) {
  if (!status?.circuits) return null;
  return status.circuits[entityId] || null;
}

/**
 * Get monitoring info for a mains leg entity.
 * @param {object|null} status - Full monitoring status
 * @param {string} entityId - Mains entity ID
 * @returns {object|null} Mains monitoring info or null
 */
export function getMainsMonitoringInfo(status, entityId) {
  if (!status?.mains) return null;
  return status.mains[entityId] || null;
}

/**
 * Check if a monitored point has custom (non-global) overrides.
 * @param {object|null} monitoringInfo - Per-circuit monitoring info
 * @returns {boolean}
 */
export function hasCustomOverrides(monitoringInfo) {
  if (!monitoringInfo) return false;
  return monitoringInfo.continuous_threshold_pct !== undefined;
}

/**
 * Get CSS class for utilization level.
 * @param {object|null} monitoringInfo - Per-circuit monitoring info
 * @returns {string} CSS class name or empty string
 */
export function getUtilizationClass(monitoringInfo) {
  if (!monitoringInfo?.utilization_pct) return "";
  const pct = monitoringInfo.utilization_pct;
  if (pct >= 100) return "utilization-alert";
  if (pct >= 80) return "utilization-warning";
  return "utilization-normal";
}

/**
 * Check if a circuit currently has an active alert.
 * @param {object|null} monitoringInfo - Per-circuit monitoring info
 * @returns {boolean}
 */
export function isAlertActive(monitoringInfo) {
  if (!monitoringInfo) return false;
  return monitoringInfo.over_threshold_since != null;
}

/**
 * Build HTML for the monitoring summary bar.
 * @param {object|null} status - Full monitoring status from get_monitoring_status
 * @returns {string} HTML string (empty if monitoring disabled)
 */
export function buildMonitoringSummaryHTML(status) {
  if (!status) return "";

  const circuits = Object.values(status.circuits || {});
  const mains = Object.values(status.mains || {});
  const all = [...circuits, ...mains];

  const warnings = all.filter(p => p.utilization_pct >= 80 && p.utilization_pct < 100).length;
  const alerts = all.filter(p => p.utilization_pct >= 100).length;
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
