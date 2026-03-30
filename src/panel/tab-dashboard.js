import { discoverTopology } from "../card/card-discovery.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { updateCircuitDOM, updateSubDeviceDOM } from "../core/dom-updater.js";
import { loadHistory } from "../core/history-loader.js";
import { MonitoringStatusCache, buildMonitoringSummaryHTML } from "../core/monitoring-status.js";
import { CARD_STYLES } from "../card/card-styles.js";
import { getHistoryDurationMs, recordSample, getMaxHistoryPoints, getMinGapMs } from "../helpers/history.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { LIVE_SAMPLE_INTERVAL_MS } from "../constants.js";

export class DashboardTab {
  constructor() {
    this._topology = null;
    this._panelSize = 0;
    this._powerHistory = new Map();
    this._monitoringCache = new MonitoringStatusCache();
    this._updateInterval = null;
    this._hass = null;
    this._config = null;
  }

  async render(container, hass, deviceId, config) {
    this.stop();
    this._hass = hass;
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

    const topo = this._topology;
    const totalRows = Math.ceil(this._panelSize / 2);
    const durationMs = getHistoryDurationMs(config);
    const monitoringStatus = this._monitoringCache.status;

    const headerHTML = buildHeaderHTML(topo, config, hass);
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
    `;

    try {
      await loadHistory(hass, topo, config, this._powerHistory);
    } catch {
      // Charts will populate live
    }

    // Initial DOM update with history data
    updateCircuitDOM(container, hass, topo, config, this._powerHistory);
    updateSubDeviceDOM(container, hass, topo, config, this._powerHistory);

    // Start live update loop
    this._updateInterval = setInterval(() => {
      this._recordSamples();
      updateCircuitDOM(container, this._hass, topo, this._config, this._powerHistory);
      updateSubDeviceDOM(container, this._hass, topo, this._config, this._powerHistory);
    }, LIVE_SAMPLE_INTERVAL_MS);
  }

  _recordSamples() {
    if (!this._topology || !this._hass) return;
    const durationMs = getHistoryDurationMs(this._config);
    const maxPoints = getMaxHistoryPoints(durationMs);
    const minGap = getMinGapMs(durationMs);
    const now = Date.now();
    const cutoff = now - durationMs;

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const eid = getCircuitChartEntity(circuit, this._config);
      if (!eid) continue;
      const state = this._hass.states[eid];
      if (!state) continue;
      const val = parseFloat(state.state);
      if (isNaN(val)) continue;

      const hist = this._powerHistory.get(uuid) || [];
      if (hist.length > 0 && now - hist[hist.length - 1].time < minGap) continue;

      recordSample(this._powerHistory, uuid, val, now, cutoff, maxPoints);
    }
  }

  stop() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
  }
}
