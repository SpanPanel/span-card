import { DEFAULT_CHART_METRIC, LIVE_SAMPLE_INTERVAL_MS } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { getHistoryDurationMs, getMaxHistoryPoints, recordSample } from "../helpers/history.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { loadHistory, collectSubDeviceEntityIds } from "../core/history-loader.js";
import { updateCircuitDOM, updateSubDeviceDOM } from "../core/dom-updater.js";
import { discoverTopology, discoverEntitiesFallback } from "./card-discovery.js";
import { CARD_STYLES } from "./card-styles.js";

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
    this._rendered = false;

    this._handleToggleClick = this._onToggleClick.bind(this);
  }

  connectedCallback() {
    this._updateInterval = setInterval(() => {
      if (this._discovered && this._hass) {
        this._updateData();
      }
    }, LIVE_SAMPLE_INTERVAL_MS);
  }

  disconnectedCallback() {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
  }

  setConfig(config) {
    this._config = config;
    this._discovered = false;
    this._rendered = false;
    this._historyLoaded = false;
    this._powerHistory.clear();
  }

  get _durationMs() {
    return getHistoryDurationMs(this._config);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config.device_id) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 24px; color: var(--secondary-text-color);">
            Open the card editor and select your SPAN Panel device.
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
    try {
      await loadHistory(this._hass, this._topology, this._config, this._powerHistory);
      this._updateDOM();
    } catch (err) {
      console.warn("SPAN Panel: history fetch failed, charts will populate live", err);
    }
  }

  // ── Record live power samples ──────────────────────────────────────────────

  _recordPowerHistory() {
    if (!this._topology || !this._hass) return;
    const now = Date.now();
    const cutoff = now - this._durationMs;
    const maxPoints = getMaxHistoryPoints(this._durationMs);

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const entityId = getCircuitChartEntity(circuit, this._config);
      if (!entityId) continue;
      const state = this._hass.states[entityId];
      const rawValue = state ? parseFloat(state.state) || 0 : 0;
      recordSample(this._powerHistory, uuid, rawValue, now, cutoff, maxPoints);
    }

    for (const { entityId, key } of collectSubDeviceEntityIds(this._topology, this._hass)) {
      const state = this._hass.states[entityId];
      const rawValue = state ? parseFloat(state.state) || 0 : 0;
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
    const config = { ...this._config, _durationMs: this._durationMs };
    updateCircuitDOM(this.shadowRoot, this._hass, this._topology, config, this._powerHistory);
    updateSubDeviceDOM(this.shadowRoot, this._hass, this._topology, config, this._powerHistory);
  }

  // ── Toggle click handler ───────────────────────────────────────────────────

  _onToggleClick(ev) {
    const pill = ev.target.closest(".toggle-pill");
    if (!pill) return;
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

  // ── Full render ────────────────────────────────────────────────────────────

  _render() {
    const hass = this._hass;
    if (!hass || !this._topology || !this._panelSize) {
      const msg = this._discoveryError || (!this._topology ? "Panel device not found. Check device_id in card config." : "Loading...");
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
    const panelName = escapeHtml(topo.device_name || "SPAN Panel");
    const durationMs = this._durationMs;

    const gridHTML = buildGridHTML(topo, totalRows, durationMs, hass, this._config);
    const subDevHTML = buildSubDevicesHTML(topo, hass, this._config, durationMs);

    // Remove previous listener before replacing DOM
    this.shadowRoot.removeEventListener("click", this._handleToggleClick);

    this.shadowRoot.innerHTML = `
      <style>${CARD_STYLES}</style>
      <ha-card>
        <div class="panel-header">
          <div class="header-left">
            <div class="panel-identity">
              <h1 class="panel-title">${panelName}</h1>
              <span class="panel-serial">${escapeHtml(topo.serial || "")}</span>
            </div>
            <div class="panel-stats">
              <div class="stat stat-consumption">
                <span class="stat-label">Panel consumption</span>
                <div class="stat-row"><span class="stat-value">0</span><span class="stat-unit">kW</span></div>
              </div>
              <div class="stat stat-current">
                <span class="stat-label">Total current</span>
                <div class="stat-row"><span class="stat-value">--</span><span class="stat-unit">A</span></div>
              </div>
              <div class="stat stat-solar">
                <span class="stat-label">Solar production</span>
                <div class="stat-row"><span class="stat-value">--</span><span class="stat-unit">kW</span></div>
              </div>
              <div class="stat stat-battery">
                <span class="stat-label">Battery charge/discharge</span>
                <div class="stat-row"><span class="stat-value">&mdash;</span></div>
              </div>
            </div>
          </div>
          <div class="header-right">
            <span class="meta-item">Firmware: ${escapeHtml(topo.firmware || "")}</span>
          </div>
        </div>
        ${
          this._config.show_panel !== false
            ? `
        <div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">
          ${gridHTML}
        </div>
        `
            : ""
        }
        ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
      </ha-card>
    `;

    // Attach single delegated click listener
    this.shadowRoot.addEventListener("click", this._handleToggleClick);

    this._rendered = true;
    this._recordPowerHistory();
    this._updateDOM();
  }
}
