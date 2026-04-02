import { DEFAULT_CHART_METRIC, DEFAULT_GRAPH_HORIZON, GRAPH_HORIZONS, LIVE_SAMPLE_INTERVAL_MS } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { getHistoryDurationMs, getHorizonDurationMs, getMaxHistoryPoints, recordSample } from "../helpers/history.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { GraphSettingsCache } from "../core/graph-settings.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { loadHistory, collectSubDeviceEntityIds } from "../core/history-loader.js";
import { updateCircuitDOM, updateSubDeviceDOM } from "../core/dom-updater.js";
import { discoverTopology, discoverEntitiesFallback } from "./card-discovery.js";
import { CARD_STYLES } from "./card-styles.js";
import "../core/side-panel.js";
import { MonitoringStatusCache, buildMonitoringSummaryHTML } from "../core/monitoring-status.js";

export class SpanPanelCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._discovered = false;
    this._discovering = false;

    this._topology = null;
    this._panelDevice = null;
    this._panelSize = 0;

    this._powerHistory = new Map();
    this._historyLoaded = false;

    this._updateInterval = null;
    this._recorderRefreshInterval = null;
    this._rendered = false;

    this._handleToggleClick = this._onToggleClick.bind(this);
    this._handleUnitToggle = this._onUnitToggle.bind(this);
    this._handleGearClick = this._onGearClick.bind(this);
    this._handleGraphSettingsChanged = this._onGraphSettingsChanged.bind(this);
    this._monitoringCache = new MonitoringStatusCache();
    this._graphSettingsCache = new GraphSettingsCache();
    this._horizonMap = new Map();
    this._subDeviceHorizonMap = new Map();
    this._resizeObserver = null;
    this._lastCardWidth = 0;
    this._resizeDebounce = null;
  }

  connectedCallback() {
    this._updateInterval = setInterval(() => {
      if (this._discovered && this._hass) {
        this._updateData();
      }
    }, LIVE_SAMPLE_INTERVAL_MS);

    this._recorderRefreshInterval = setInterval(async () => {
      if (!this._discovered || !this._hass || !this._topology) return;
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
        this._updateDOM();
      } catch {
        // Will refresh on next interval
      }
    }, 30000);

    // Re-render when card is reconnected after navigation
    if (this._discovered && this._hass && this._rendered) {
      this._updateDOM();
    }

    this._onVisibilityChange = () => {
      if (document.visibilityState === "visible" && this._discovered && this._hass) {
        this._updateDOM();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  disconnectedCallback() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
    if (this._recorderRefreshInterval) {
      clearInterval(this._recorderRefreshInterval);
      this._recorderRefreshInterval = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._resizeDebounce) {
      clearTimeout(this._resizeDebounce);
      this._resizeDebounce = null;
    }
  }

  setConfig(config) {
    this._config = config;
    this._discovered = false;
    this._rendered = false;
    this._historyLoaded = false;
    this._powerHistory.clear();
    this._horizonMap.clear();
    this._subDeviceHorizonMap.clear();
    this._monitoringCache.clear();
    this._graphSettingsCache.clear();
  }

  get _durationMs() {
    return getHistoryDurationMs(this._config);
  }

  get _configEntryId() {
    return this._panelDevice?.config_entries?.[0] || null;
  }

  set hass(hass) {
    this._hass = hass;
    setLanguage(hass?.language);
    if (!this._config.device_id) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 24px; color: var(--secondary-text-color);">
            ${t("card.no_device")}
          </div>
        </ha-card>
      `;
      return;
    }
    if (!this._discovered && !this._discovering) {
      this._discovering = true;
      this._discoverTopology().then(() => {
        this._discovered = true;
        this._discovering = false;
        this._render();
        this._loadHistory();
        this._monitoringCache.fetch(hass, this._configEntryId).then(() => {
          if (this._rendered) this._updateDOM();
        });
      });
      return;
    }
    if (this._discovered) {
      this._updateData();
    }
  }

  getCardSize() {
    return Math.ceil(this._panelSize / 2) + 3;
  }

  static getConfigElement() {
    return document.createElement("span-panel-card-editor");
  }

  static getStubConfig() {
    return {
      device_id: "",
      history_days: 0,
      history_hours: 0,
      history_minutes: 5,
      chart_metric: DEFAULT_CHART_METRIC,
      show_panel: true,
      show_battery: true,
      show_evse: true,
    };
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  async _discoverTopology() {
    if (!this._hass) return;
    try {
      const result = await discoverTopology(this._hass, this._config.device_id);
      this._topology = result.topology;
      this._panelDevice = result.panelDevice;
      this._panelSize = result.panelSize;
    } catch (err) {
      console.error("SPAN Panel: topology fetch failed, falling back to entity discovery", err);
      try {
        const result = await discoverEntitiesFallback(this._hass, this._config.device_id);
        this._topology = result.topology;
        this._panelDevice = result.panelDevice;
        this._panelSize = result.panelSize;
      } catch (fallbackErr) {
        console.error("SPAN Panel: fallback discovery also failed", fallbackErr);
        this._discoveryError = fallbackErr.message;
      }
    }
  }

  // ── History from HA recorder ───────────────────────────────────────────────

  async _loadHistory() {
    if (this._historyLoaded || !this._topology || !this._hass) return;
    this._historyLoaded = true;

    // Fetch graph settings and build horizon map
    try {
      await this._graphSettingsCache.fetch(this._hass, this._configEntryId);
      const settings = this._graphSettingsCache.settings;
      if (settings && this._topology?.circuits) {
        for (const uuid of Object.keys(this._topology.circuits)) {
          const override = settings.circuits?.[uuid];
          const horizon = override?.has_override ? override.horizon : settings.global_horizon || DEFAULT_GRAPH_HORIZON;
          this._horizonMap.set(uuid, horizon);
        }
      }
      // Build sub-device horizon map
      if (settings && this._topology?.sub_devices) {
        for (const devId of Object.keys(this._topology.sub_devices)) {
          const override = settings.sub_devices?.[devId];
          const horizon = override?.has_override ? override.horizon : settings.global_horizon || DEFAULT_GRAPH_HORIZON;
          this._subDeviceHorizonMap.set(devId, horizon);
        }
      }
    } catch {
      // Graph settings unavailable — use defaults
    }

    try {
      await loadHistory(this._hass, this._topology, this._config, this._powerHistory, this._horizonMap, this._subDeviceHorizonMap);
      this._updateDOM();
    } catch (err) {
      console.warn("SPAN Panel: history fetch failed, charts will populate live", err);
    }
  }

  // ── Record live power samples ──────────────────────────────────────────────

  _recordPowerHistory() {
    if (!this._topology || !this._hass) return;
    const now = Date.now();

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const horizon = this._horizonMap?.get(uuid) || DEFAULT_GRAPH_HORIZON;
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) continue;

      const entityId = getCircuitChartEntity(circuit, this._config);
      if (!entityId) continue;
      const state = this._hass.states[entityId];
      const rawValue = state ? parseFloat(state.state) || 0 : 0;

      const durationMs = getHorizonDurationMs(horizon);
      const maxPoints = getMaxHistoryPoints(durationMs);
      const cutoff = now - durationMs;
      recordSample(this._powerHistory, uuid, rawValue, now, cutoff, maxPoints);
    }

    // Sub-devices use per-device horizon when available
    for (const { entityId, key, devId } of collectSubDeviceEntityIds(this._topology)) {
      const horizon = this._subDeviceHorizonMap?.get(devId) || DEFAULT_GRAPH_HORIZON;
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) continue;

      const state = this._hass.states[entityId];
      const rawValue = state ? parseFloat(state.state) || 0 : 0;
      const durationMs = getHorizonDurationMs(horizon);
      const maxPoints = getMaxHistoryPoints(durationMs);
      const cutoff = now - durationMs;
      recordSample(this._powerHistory, key, rawValue, now, cutoff, maxPoints);
    }
  }

  // ── Data update ────────────────────────────────────────────────────────────

  _updateData() {
    this._recordPowerHistory();
    this._updateDOM();
  }

  // ── DOM updates (incremental) ──────────────────────────────────────────────

  _updateDOM() {
    updateCircuitDOM(this.shadowRoot, this._hass, this._topology, this._config, this._powerHistory, this._horizonMap);
    updateSubDeviceDOM(this.shadowRoot, this._hass, this._topology, this._config, this._powerHistory, this._subDeviceHorizonMap);
  }

  // ── Unit toggle (A/W) click handler ───────────────────────────────────────

  async _onUnitToggle(event) {
    const btn = event.target.closest(".unit-btn");
    if (!btn) return;
    const unit = btn.dataset.unit;
    if (!unit || unit === (this._config.chart_metric || "power")) return;
    this._config = { ...this._config, chart_metric: unit };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
    this._powerHistory.clear();
    this._historyLoaded = false;
    this._rendered = false;
    this._render();
    await this._loadHistory();
    this._updateDOM();
  }

  // ── Slide-to-confirm safety switch ─────────────────────────────────────────

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

    // Click the confirmed slider to re-lock
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

  // ── Toggle click handler ───────────────────────────────────────────────────

  _onToggleClick(ev) {
    const pill = ev.target.closest(".toggle-pill");
    if (!pill) return;
    const cb = this.shadowRoot.querySelector(".slide-confirm");
    if (!cb || !cb.classList.contains("confirmed")) return;
    ev.stopPropagation();
    ev.preventDefault();
    const slot = pill.closest("[data-uuid]");
    if (!slot || !this._topology || !this._hass) return;
    const uuid = slot.dataset.uuid;
    const circuit = this._topology.circuits[uuid];
    if (!circuit) return;
    const switchEntity = circuit.entities?.switch;
    if (!switchEntity) return;
    const switchState = this._hass.states[switchEntity];
    if (!switchState) {
      console.warn("SPAN Panel: switch entity not found:", switchEntity);
      return;
    }
    const service = switchState.state === "on" ? "turn_off" : "turn_on";
    this._hass.callService("switch", service, {}, { entity_id: switchEntity }).catch(err => {
      console.error("SPAN Panel: switch service call failed:", err);
    });
  }

  // ── Gear click handler ────────────────────────────────────────────────────

  async _onGearClick(event) {
    const gearBtn = event.target.closest(".gear-icon");
    if (!gearBtn) return;

    const sidePanel = this.shadowRoot.querySelector("span-side-panel");
    if (!sidePanel) return;
    sidePanel.hass = this._hass;

    if (gearBtn.classList.contains("panel-gear")) {
      await this._graphSettingsCache.fetch(this._hass, this._configEntryId);
      sidePanel.open({
        panelMode: true,
        topology: this._topology,
        graphSettings: this._graphSettingsCache.settings,
      });
      return;
    }

    const uuid = gearBtn.dataset.uuid;
    if (uuid && this._topology) {
      const circuit = this._topology.circuits[uuid];
      if (circuit) {
        const monitoringInfo = this._monitoringCache?.status?.circuits?.[circuit.entities?.power] || null;

        await this._graphSettingsCache.fetch(this._hass, this._configEntryId);
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
        return;
      }
    }

    const subDevId = gearBtn.dataset.subdevId;
    if (subDevId && this._topology?.sub_devices?.[subDevId]) {
      const sub = this._topology.sub_devices[subDevId];

      await this._graphSettingsCache.fetch(this._hass, this._configEntryId);
      const graphSettings = this._graphSettingsCache.settings;
      const globalHorizon = graphSettings?.global_horizon || DEFAULT_GRAPH_HORIZON;
      const graphHorizonInfo = graphSettings?.sub_devices?.[subDevId]
        ? { ...graphSettings.sub_devices[subDevId], globalHorizon }
        : { horizon: globalHorizon, has_override: false, globalHorizon };

      sidePanel.open({
        subDeviceMode: true,
        subDeviceId: subDevId,
        name: sub.name || subDevId,
        deviceType: sub.type || "",
        graphHorizonInfo,
      });
    }
  }

  // ── Graph settings changed handler ────────────────────────────────────────

  async _onGraphSettingsChanged() {
    this._graphSettingsCache.invalidate();
    await this._graphSettingsCache.fetch(this._hass, this._configEntryId);

    // Rebuild horizon map
    const settings = this._graphSettingsCache.settings;
    if (settings && this._topology?.circuits) {
      for (const uuid of Object.keys(this._topology.circuits)) {
        const override = settings.circuits?.[uuid];
        const horizon = override?.has_override ? override.horizon : settings.global_horizon || DEFAULT_GRAPH_HORIZON;
        this._horizonMap.set(uuid, horizon);
      }
    }

    // Rebuild sub-device horizon map
    if (settings && this._topology?.sub_devices) {
      for (const devId of Object.keys(this._topology.sub_devices)) {
        const override = settings.sub_devices?.[devId];
        const horizon = override?.has_override ? override.horizon : settings.global_horizon || DEFAULT_GRAPH_HORIZON;
        this._subDeviceHorizonMap.set(devId, horizon);
      }
    }

    // Reload all history with new horizons
    this._powerHistory.clear();
    this._historyLoaded = false;
    await this._loadHistory();
  }

  // ── Resize handling ────────────────────────────────────────────────────────

  _invalidateCharts() {
    for (const container of this.shadowRoot.querySelectorAll(".chart-container")) {
      const chart = container.querySelector("ha-chart-base");
      if (chart) chart.remove();
    }
  }

  _setupResizeObserver() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    const card = this.shadowRoot.querySelector("ha-card");
    if (!card) return;
    this._lastCardWidth = card.clientWidth;
    this._resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const newWidth = entry.contentRect.width;
      if (Math.abs(newWidth - this._lastCardWidth) < 5) return;
      this._lastCardWidth = newWidth;
      if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        this._invalidateCharts();
        this._updateDOM();
      }, 150);
    });
    this._resizeObserver.observe(card);
  }

  // ── Full render ────────────────────────────────────────────────────────────

  _render() {
    const hass = this._hass;
    if (!hass || !this._topology || !this._panelSize) {
      const msg = this._discoveryError || (!this._topology ? t("card.device_not_found") : t("card.loading"));
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 24px; color: var(--secondary-text-color);">
            ${escapeHtml(msg)}
          </div>
        </ha-card>
      `;
      return;
    }

    const topo = this._topology;
    const totalRows = Math.ceil(this._panelSize / 2);
    const durationMs = this._durationMs;

    const headerHTML = buildHeaderHTML(topo, this._config);
    const monitoringStatus = this._monitoringCache.status;
    const monitoringSummaryHTML = buildMonitoringSummaryHTML(monitoringStatus);
    const gridHTML = buildGridHTML(topo, totalRows, durationMs, hass, this._config, monitoringStatus);
    const subDevHTML = buildSubDevicesHTML(topo, hass, this._config, durationMs);

    // Remove previous listeners before replacing DOM
    this.shadowRoot.removeEventListener("click", this._handleToggleClick);
    this.shadowRoot.removeEventListener("click", this._handleUnitToggle);
    this.shadowRoot.removeEventListener("click", this._handleGearClick);
    this.shadowRoot.removeEventListener("graph-settings-changed", this._handleGraphSettingsChanged);

    this.shadowRoot.innerHTML = `
      <style>${CARD_STYLES}</style>
      <ha-card>
        ${headerHTML}
        ${monitoringSummaryHTML}
        ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
        ${
          this._config.show_panel !== false
            ? `
        <div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">
          ${gridHTML}
        </div>
        `
            : ""
        }
      </ha-card>
      <span-side-panel></span-side-panel>
    `;

    // Attach delegated click listeners
    this.shadowRoot.addEventListener("click", this._handleToggleClick);
    this.shadowRoot.addEventListener("click", this._handleUnitToggle);
    this.shadowRoot.addEventListener("click", this._handleGearClick);
    this.shadowRoot.addEventListener("graph-settings-changed", this._handleGraphSettingsChanged);

    const slideEl = this.shadowRoot.querySelector(".slide-confirm");
    if (slideEl) {
      this._bindSlideConfirm(slideEl, this.shadowRoot.querySelector("ha-card"));
      const card = this.shadowRoot.querySelector("ha-card");
      if (card) card.classList.add("switches-disabled");
    }

    const sidePanel = this.shadowRoot.querySelector("span-side-panel");
    if (sidePanel) sidePanel.hass = hass;

    this._rendered = true;
    this._recordPowerHistory();
    this._updateDOM();
    this._setupResizeObserver();
  }
}
