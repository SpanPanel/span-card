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

    const slideEl = container.querySelector(".slide-confirm");
    if (slideEl) {
      this._bindSlideConfirm(slideEl, container);
      container.classList.add("switches-disabled");
    }

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
      // Load into a temporary map so charts keep showing stale data
      // until fresh data is ready (avoids blank-chart flash).
      const freshHistory = new Map();
      try {
        await loadHistory(this._hass, this._topology, this._config, freshHistory, nonRealtimeMap);
        // Atomically replace only the non-realtime entries
        for (const uuid of nonRealtimeMap.keys()) {
          const data = freshHistory.get(uuid);
          if (data) {
            this._powerHistory.set(uuid, data);
          } else {
            this._powerHistory.delete(uuid);
          }
        }
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

  _bindSlideConfirm(slideEl, parent) {
    const knob = slideEl.querySelector(".slide-confirm-knob");
    const textEl = slideEl.querySelector(".slide-confirm-text");
    if (!knob) return;
    const THRESHOLD = 0.9;
    let dragging = false;
    let startX = 0;
    let maxX = 0;

    const begin = clientX => {
      if (slideEl.classList.contains("confirmed")) return;
      dragging = true;
      startX = clientX - knob.offsetLeft;
      maxX = slideEl.offsetWidth - knob.offsetWidth - 4;
      knob.classList.remove("snapping");
    };
    const move = clientX => {
      if (!dragging) return;
      const x = Math.max(2, Math.min(clientX - startX, maxX));
      knob.style.left = x + "px";
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      const pos = (knob.offsetLeft - 2) / maxX;
      if (pos >= THRESHOLD) {
        knob.style.left = maxX + "px";
        slideEl.classList.add("confirmed");
        knob.querySelector("ha-icon").setAttribute("icon", "mdi:lock-open");
        textEl.textContent = slideEl.dataset.textOn;
        if (parent) parent.classList.remove("switches-disabled");
      } else {
        knob.classList.add("snapping");
        knob.style.left = "2px";
      }
    };

    knob.addEventListener("mousedown", e => {
      e.preventDefault();
      begin(e.clientX);
    });
    slideEl.addEventListener("mousemove", e => move(e.clientX));
    slideEl.addEventListener("mouseup", end);
    slideEl.addEventListener("mouseleave", end);
    knob.addEventListener(
      "touchstart",
      e => {
        e.preventDefault();
        begin(e.touches[0].clientX);
      },
      { passive: false }
    );
    slideEl.addEventListener("touchmove", e => move(e.touches[0].clientX), { passive: true });
    slideEl.addEventListener("touchend", end);
    slideEl.addEventListener("touchcancel", end);

    slideEl.addEventListener("click", () => {
      if (!slideEl.classList.contains("confirmed")) return;
      slideEl.classList.remove("confirmed");
      knob.classList.add("snapping");
      knob.style.left = "2px";
      knob.querySelector("ha-icon").setAttribute("icon", "mdi:lock");
      textEl.textContent = slideEl.dataset.textOff;
      if (parent) parent.classList.add("switches-disabled");
    });
  }

  _bindToggleClicks(container, topology) {
    container.addEventListener("click", e => {
      const pill = e.target.closest(".toggle-pill");
      if (!pill) return;
      const cb = container.querySelector(".slide-confirm");
      if (!cb || !cb.classList.contains("confirmed")) return;
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
