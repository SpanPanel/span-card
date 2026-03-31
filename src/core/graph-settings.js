// src/core/graph-settings.js
import { INTEGRATION_DOMAIN, DEFAULT_GRAPH_HORIZON } from "../constants.js";

const GRAPH_SETTINGS_POLL_INTERVAL_MS = 30_000;

/**
 * Caches graph horizon settings fetched via the get_graph_settings service.
 * Re-fetches at most every 30 seconds unless invalidated.
 */
export class GraphSettingsCache {
  constructor() {
    this._settings = null;
    this._lastFetch = 0;
    this._fetching = false;
  }

  /**
   * Fetch graph settings, returning cached data if recent.
   * @param {object} hass - Home Assistant instance
   * @param {string} [configEntryId] - Optional config entry ID
   * @returns {Promise<object|null>} Graph settings or null
   */
  async fetch(hass, configEntryId) {
    const now = Date.now();
    if (this._fetching) return this._settings;
    if (this._settings && now - this._lastFetch < GRAPH_SETTINGS_POLL_INTERVAL_MS) {
      return this._settings;
    }

    this._fetching = true;
    try {
      const serviceData = {};
      if (configEntryId) serviceData.config_entry_id = configEntryId;
      const resp = await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_graph_settings",
        service_data: serviceData,
        return_response: true,
      });
      this._settings = resp?.response || null;
      this._lastFetch = now;
    } catch {
      this._settings = null;
    } finally {
      this._fetching = false;
    }
    return this._settings;
  }

  /** Force the next fetch() call to re-query the backend. */
  invalidate() {
    this._lastFetch = 0;
  }

  /** @returns {object|null} Last fetched settings */
  get settings() {
    return this._settings;
  }

  /** Clear cached settings (e.g., on config change). */
  clear() {
    this._settings = null;
    this._lastFetch = 0;
  }
}

/**
 * Get the effective horizon for a circuit.
 * @param {object|null} settings - Full graph settings from get_graph_settings
 * @param {string} circuitId - Circuit identifier
 * @returns {string} Horizon key (e.g., "5m", "1h")
 */
export function getEffectiveHorizon(settings, circuitId) {
  if (!settings) return DEFAULT_GRAPH_HORIZON;
  const override = settings.circuits?.[circuitId];
  if (override?.has_override) return override.horizon;
  return settings.global_horizon || DEFAULT_GRAPH_HORIZON;
}
