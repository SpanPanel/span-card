// src/core/graph-settings.ts
import { INTEGRATION_DOMAIN, DEFAULT_GRAPH_HORIZON } from "../constants.js";
import { t } from "../i18n.js";
import { RetryManager } from "./retry-manager.js";
import type { HomeAssistant, GraphSettings } from "../types.js";
import type { ErrorStore } from "./error-store.js";

const GRAPH_SETTINGS_POLL_INTERVAL_MS = 30_000;

interface GraphSettingsServiceResponse {
  response?: GraphSettings;
}

/**
 * Caches graph horizon settings fetched via the get_graph_settings service.
 * Re-fetches at most every 30 seconds unless invalidated.
 */
export class GraphSettingsCache {
  private _settings: GraphSettings | null;
  private _lastFetch: number;
  private _fetching: boolean;
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
    this._settings = null;
    this._lastFetch = 0;
    this._fetching = false;
  }

  /**
   * Fetch graph settings, returning cached data if recent.
   */
  async fetch(hass: HomeAssistant, configEntryId?: string | null): Promise<GraphSettings | null> {
    const now = Date.now();
    if (this._fetching) return this._settings;
    if (this._settings && now - this._lastFetch < GRAPH_SETTINGS_POLL_INTERVAL_MS) {
      return this._settings;
    }

    this._fetching = true;
    try {
      const serviceData: Record<string, string> = {};
      if (configEntryId) serviceData.config_entry_id = configEntryId;
      const msg = {
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_graph_settings",
        service_data: serviceData,
        return_response: true,
      };
      const resp = this._retry
        ? await this._retry.callWS<GraphSettingsServiceResponse>(hass, msg, {
            errorId: "fetch:graph_settings",
            errorMessage: t("error.graph_settings_failed"),
          })
        : await hass.callWS<GraphSettingsServiceResponse>(msg);
      this._settings = resp?.response ?? null;
      this._lastFetch = Date.now();
    } catch (err) {
      console.warn("SPAN Panel: graph settings fetch failed", err);
      this._settings = null;
      // RetryManager dispatches on exhaustion; only dispatch directly when no retry path ran
      if (!this._retry) {
        this._errorStore?.add({
          key: "fetch:graph_settings",
          level: "warning",
          message: t("error.graph_settings_failed"),
          persistent: false,
        });
      }
    } finally {
      this._fetching = false;
    }
    return this._settings;
  }

  /** Force the next fetch() call to re-query the backend. */
  invalidate(): void {
    this._lastFetch = 0;
  }

  /** Last fetched settings. */
  get settings(): GraphSettings | null {
    return this._settings;
  }

  /** Clear cached settings (e.g., on config change). */
  clear(): void {
    this._settings = null;
    this._lastFetch = 0;
  }
}

/**
 * Get the effective horizon for a circuit.
 */
export function getEffectiveHorizon(settings: GraphSettings | null, circuitId: string): string {
  if (!settings) return DEFAULT_GRAPH_HORIZON;
  const override = settings.circuits?.[circuitId];
  if (override?.has_override) return override.horizon;
  return settings.global_horizon ?? DEFAULT_GRAPH_HORIZON;
}

/**
 * Get the effective horizon for a sub-device.
 */
export function getEffectiveSubDeviceHorizon(settings: GraphSettings | null, subDeviceId: string): string {
  if (!settings) return DEFAULT_GRAPH_HORIZON;
  const override = settings.sub_devices?.[subDeviceId];
  if (override?.has_override) return override.horizon;
  return settings.global_horizon ?? DEFAULT_GRAPH_HORIZON;
}
