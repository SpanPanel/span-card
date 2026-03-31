import { discoverTopology } from "../card/card-discovery.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { updateCircuitDOM, updateSubDeviceDOM } from "../core/dom-updater.js";
import { loadHistory } from "../core/history-loader.js";
import { MonitoringStatusCache, buildMonitoringSummaryHTML } from "../core/monitoring-status.js";
import { GraphSettingsCache } from "../core/graph-settings.js";
import { CARD_STYLES } from "../card/card-styles.js";
import { getHistoryDurationMs, recordSample, getMaxHistoryPoints, getMinGapMs, getHorizonDurationMs } from "../helpers/history.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { LIVE_SAMPLE_INTERVAL_MS, GRAPH_HORIZONS, DEFAULT_GRAPH_HORIZON } from "../constants.js";
import "../core/side-panel.js";

export class DashboardTab {
  constructor() {
    this._topology = null;
    this._panelSize = 0;
    this._powerHistory = new Map();
    this._monitoringCache = new MonitoringStatusCache();
    this._graphSettingsCache = new GraphSettingsCache();
    this._updateInterval = null;
    this._recorderRefreshInterval = null;
    this._horizonMap = new Map();
    this._hass = null;
    this._config = null;
  }

  async render(container, hass, deviceId, config) {
    this.stop();
    this._hass = hass;
    this._powerHistory.clear();
    this._config = config;

    try {
      const result = await discoverTopology(hass, deviceId);
      this._topology = result.topology;
      this._panelSize = result.panelSize;
    } catch (err) {
      container.innerHTML = `<p style="color:var(--error-color);">${err.message}</p>`;
      return;
    }

    await this._monitoringCache.fetch(hass);
    await this._graphSettingsCache.fetch(hass);

    const topo = this._topology;

    // Build per-circuit horizon map
    this._horizonMap = new Map();
    const graphSettings = this._graphSettingsCache.settings;
    if (topo?.circuits) {
      for (const uuid of Object.keys(topo.circuits)) {
        const override = graphSettings?.circuits?.[uuid];
        const horizon = override?.has_override ? override.horizon : graphSettings?.global_horizon || DEFAULT_GRAPH_HORIZON;
        this._horizonMap.set(uuid, horizon);
      }
    }
    const totalRows = Math.ceil(this._panelSize / 2);
    const durationMs = getHistoryDurationMs(config);
    const monitoringStatus = this._monitoringCache.status;

    const headerHTML = buildHeaderHTML(topo, config);
    const monitoringSummaryHTML = buildMonitoringSummaryHTML(monitoringStatus);
    const gridHTML = buildGridHTML(topo, totalRows, durationMs, hass, config, monitoringStatus);
    const subDevHTML = buildSubDevicesHTML(topo, hass, config, durationMs);

    container.innerHTML = `
      <style>${CARD_STYLES}</style>
      ${headerHTML}
      ${monitoringSummaryHTML}
      ${
        config.show_panel !== false
          ? `
        <div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">
          ${gridHTML}
        </div>
      `
          : ""
      }
      ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
      <span-side-panel></span-side-panel>
    `;

    this._bindGearClicks(container, topo);
    this._bindToggleClicks(container, topo);
    container.addEventListener("side-panel-closed", () => {
      this._monitoringCache.invalidate();
      this._graphSettingsCache.invalidate();
    });
    container.addEventListener("graph-settings-changed", async () => {
      this._graphSettingsCache.invalidate();
      await this._graphSettingsCache.fetch(this._hass);

      // Rebuild horizon map
      const newSettings = this._graphSettingsCache.settings;
      if (topo?.circuits) {
        for (const uuid of Object.keys(topo.circuits)) {
          const override = newSettings?.circuits?.[uuid];
          const horizon = override?.has_override ? override.horizon : newSettings?.global_horizon || DEFAULT_GRAPH_HORIZON;
          this._horizonMap.set(uuid, horizon);
        }
      }

      // Reload all history with new horizons
      this._powerHistory.clear();
      try {
        await loadHistory(this._hass, topo, this._config, this._powerHistory, this._horizonMap);
      } catch {
        // Will populate on next refresh
      }
      updateCircuitDOM(container, this._hass, topo, this._config, this._powerHistory, this._horizonMap);
      updateSubDeviceDOM(container, this._hass, topo, this._config, this._powerHistory);
    });

    try {
      await loadHistory(hass, topo, config, this._powerHistory, this._horizonMap);
    } catch {
      // Charts will populate live
    }

    // Initial DOM update with history data
    updateCircuitDOM(container, hass, topo, config, this._powerHistory, this._horizonMap);
    updateSubDeviceDOM(container, hass, topo, config, this._powerHistory);

    // Start live update loop
    this._updateInterval = setInterval(() => {
      this._recordSamples();
      updateCircuitDOM(container, this._hass, topo, this._config, this._powerHistory, this._horizonMap);
      updateSubDeviceDOM(container, this._hass, topo, this._config, this._powerHistory);
    }, LIVE_SAMPLE_INTERVAL_MS);

    // Periodic recorder refresh for non-realtime horizons
    this._recorderRefreshInterval = setInterval(async () => {
      if (!this._topology || !this._hass) return;
      const nonRealtimeMap = new Map();
      for (const [uuid, horizon] of this._horizonMap) {
        if (!GRAPH_HORIZONS[horizon]?.useRealtime) {
          nonRealtimeMap.set(uuid, horizon);
        }
      }
      if (nonRealtimeMap.size === 0) return;
      // Clear and reload history for non-realtime circuits
      for (const uuid of nonRealtimeMap.keys()) {
        this._powerHistory.delete(uuid);
      }
      try {
        await loadHistory(this._hass, this._topology, this._config, this._powerHistory, nonRealtimeMap);
        updateCircuitDOM(container, this._hass, topo, this._config, this._powerHistory, this._horizonMap);
      } catch {
        // Recorder data will refresh on next interval
      }
    }, 30000);
  }

  _recordSamples() {
    if (!this._topology || !this._hass) return;
    const now = Date.now();

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const horizon = this._horizonMap?.get(uuid) || DEFAULT_GRAPH_HORIZON;
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) continue;

      const eid = getCircuitChartEntity(circuit, this._config);
      if (!eid) continue;
      const state = this._hass.states[eid];
      if (!state) continue;
      const val = parseFloat(state.state);
      if (isNaN(val)) continue;

      const durationMs = getHorizonDurationMs(horizon);
      const maxPoints = getMaxHistoryPoints(durationMs);
      const minGap = getMinGapMs(durationMs);
      const cutoff = now - durationMs;

      const hist = this._powerHistory.get(uuid) || [];
      if (hist.length > 0 && now - hist[hist.length - 1].time < minGap) continue;

      recordSample(this._powerHistory, uuid, val, now, cutoff, maxPoints);
    }
  }

  _bindToggleClicks(container, topology) {
    container.addEventListener("click", e => {
      const pill = e.target.closest(".toggle-pill");
      if (!pill) return;
      e.stopPropagation();
      e.preventDefault();
      const slot = pill.closest("[data-uuid]");
      if (!slot || !topology || !this._hass) return;
      const uuid = slot.dataset.uuid;
      const circuit = topology.circuits[uuid];
      if (!circuit) return;
      const switchEntity = circuit.entities?.switch;
      if (!switchEntity) return;
      const switchState = this._hass.states[switchEntity];
      if (!switchState) return;
      const service = switchState.state === "on" ? "turn_off" : "turn_on";
      this._hass.callService("switch", service, {}, { entity_id: switchEntity });
    });
  }

  _bindGearClicks(container, topology) {
    container.addEventListener("click", async e => {
      const gearBtn = e.target.closest(".gear-icon");
      if (!gearBtn) return;

      const sidePanel = container.querySelector("span-side-panel");
      if (!sidePanel || !this._hass) return;
      sidePanel.hass = this._hass;

      if (gearBtn.classList.contains("panel-gear")) {
        container.dispatchEvent(new CustomEvent("navigate-tab", { detail: "monitoring", bubbles: true, composed: true }));
        return;
      }

      const uuid = gearBtn.dataset.uuid;
      if (!uuid || !topology) return;

      const circuit = topology.circuits[uuid];
      if (!circuit) return;

      // Always fetch fresh monitoring and graph settings data before opening side panel
      await this._monitoringCache.fetch(this._hass);
      const monitoringInfo = this._monitoringCache?.status?.circuits?.[circuit.entities?.power] || null;

      await this._graphSettingsCache.fetch(this._hass);
      const graphSettings = this._graphSettingsCache.settings;
      const globalHorizon = graphSettings?.global_horizon || DEFAULT_GRAPH_HORIZON;
      const graphHorizonInfo = graphSettings?.circuits?.[uuid]
        ? { ...graphSettings.circuits[uuid], globalHorizon }
        : { horizon: globalHorizon, has_override: false, globalHorizon };

      sidePanel.open({
        ...circuit,
        uuid,
        monitoringInfo,
        graphHorizonInfo,
      });
    });
  }

  stop() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
    if (this._recorderRefreshInterval) {
      clearInterval(this._recorderRefreshInterval);
      this._recorderRefreshInterval = null;
    }
  }
}
