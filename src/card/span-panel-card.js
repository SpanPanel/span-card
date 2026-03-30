import {
  CHART_METRICS,
  BESS_CHART_METRICS,
  DEFAULT_CHART_METRIC,
  LIVE_SAMPLE_INTERVAL_MS,
  DEVICE_TYPE_PV,
  RELAY_STATE_CLOSED,
  SUB_DEVICE_TYPE_BESS,
  SUB_DEVICE_KEY_PREFIX,
} from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit, formatKw } from "../helpers/format.js";
import { getHistoryDurationMs, getMaxHistoryPoints, getMinGapMs, recordSample, deduplicateAndTrim } from "../helpers/history.js";
import { getChartMetric, getCircuitChartEntity } from "../helpers/chart.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity } from "../helpers/entity-finder.js";
import { updateChart } from "../chart/chart-update.js";
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

    const durationMs = this._durationMs;
    const entityIds = [];
    const uuidByEntity = new Map();

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const eid = getCircuitChartEntity(circuit, this._config);
      if (eid) {
        entityIds.push(eid);
        uuidByEntity.set(eid, uuid);
      }
    }

    this._collectSubDeviceEntityIds(entityIds, uuidByEntity);

    if (entityIds.length === 0) return;

    const useStatistics = durationMs > 2 * 60 * 60 * 1000;

    try {
      if (useStatistics) {
        await this._loadStatisticsHistory(entityIds, uuidByEntity, durationMs);
      } else {
        await this._loadRawHistory(entityIds, uuidByEntity, durationMs);
      }
      this._updateDOM();
    } catch (err) {
      console.warn("SPAN Panel: history fetch failed, charts will populate live", err);
    }
  }

  async _loadStatisticsHistory(entityIds, uuidByEntity, durationMs) {
    const startTime = new Date(Date.now() - durationMs).toISOString();
    const durationHours = durationMs / (60 * 60 * 1000);
    const period = durationHours > 72 ? "hour" : "5minute";

    const result = await this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: startTime,
      statistic_ids: entityIds,
      period,
      types: ["mean"],
    });

    for (const [entityId, stats] of Object.entries(result)) {
      const uuid = uuidByEntity.get(entityId);
      if (!uuid || !stats) continue;

      const hist = [];
      for (const entry of stats) {
        const val = entry.mean;
        if (val == null || !Number.isFinite(val)) continue;
        const time = entry.start;
        if (time > 0) hist.push({ time, value: val });
      }

      if (hist.length > 0) {
        const existing = this._powerHistory.get(uuid) || [];
        const merged = [...hist, ...existing];
        merged.sort((a, b) => a.time - b.time);
        this._powerHistory.set(uuid, merged);
      }
    }
  }

  async _loadRawHistory(entityIds, uuidByEntity, durationMs) {
    const startTime = new Date(Date.now() - durationMs).toISOString();
    const result = await this._hass.callWS({
      type: "history/history_during_period",
      start_time: startTime,
      entity_ids: entityIds,
      minimal_response: true,
      significant_changes_only: true,
      no_attributes: true,
    });

    const maxPoints = getMaxHistoryPoints(durationMs);
    const minGapMs = getMinGapMs(durationMs);
    for (const [entityId, states] of Object.entries(result)) {
      const uuid = uuidByEntity.get(entityId);
      if (!uuid || !states) continue;

      const hist = [];
      for (const entry of states) {
        const val = parseFloat(entry.s);
        if (!Number.isFinite(val)) continue;
        const tsSec = entry.lu || entry.lc || 0;
        const time = tsSec * 1000;
        if (time > 0) hist.push({ time, value: val });
      }

      if (hist.length > 0) {
        const existing = this._powerHistory.get(uuid) || [];
        const merged = [...hist, ...existing];
        this._powerHistory.set(uuid, deduplicateAndTrim(merged, maxPoints, minGapMs));
      }
    }
  }

  // Collect entity IDs for sub-devices into the provided arrays.
  _collectSubDeviceEntityIds(entityIds, uuidByEntity) {
    if (!this._topology.sub_devices) return;
    for (const [devId, sub] of Object.entries(this._topology.sub_devices)) {
      const eidMap = { power: findSubDevicePowerEntity(sub) };
      if (sub.type === SUB_DEVICE_TYPE_BESS) {
        eidMap.soc = findBatteryLevelEntity(sub);
        eidMap.soe = findBatterySoeEntity(sub);
      }
      for (const [role, eid] of Object.entries(eidMap)) {
        if (eid) {
          entityIds.push(eid);
          uuidByEntity.set(eid, `${SUB_DEVICE_KEY_PREFIX}${devId}_${role}`);
        }
      }
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

    if (this._topology.sub_devices) {
      for (const [devId, sub] of Object.entries(this._topology.sub_devices)) {
        const eidMap = { power: findSubDevicePowerEntity(sub) };
        if (sub.type === SUB_DEVICE_TYPE_BESS) {
          eidMap.soc = findBatteryLevelEntity(sub);
          eidMap.soe = findBatterySoeEntity(sub);
        }
        for (const [role, entityId] of Object.entries(eidMap)) {
          if (!entityId) continue;
          const key = `${SUB_DEVICE_KEY_PREFIX}${devId}_${role}`;
          const state = this._hass.states[entityId];
          const rawValue = state ? parseFloat(state.state) || 0 : 0;
          recordSample(this._powerHistory, key, rawValue, now, cutoff, maxPoints);
        }
      }
    }
  }

  // ── Data update ────────────────────────────────────────────────────────────

  _updateData() {
    this._recordPowerHistory();
    this._updateDOM();
  }

  // ── DOM updates (incremental) ──────────────────────────────────────────────

  _updateDOM() {
    const root = this.shadowRoot;
    if (!root || !this._topology || !this._hass) return;

    const hass = this._hass;
    const topo = this._topology;
    const durationMs = this._durationMs;

    let totalConsumption = 0;
    let solarProduction = 0;

    for (const [, circuit] of Object.entries(topo.circuits)) {
      const entityId = circuit.entities?.power;
      if (!entityId) continue;
      const state = hass.states[entityId];
      const power = state ? parseFloat(state.state) || 0 : 0;
      if (circuit.device_type === DEVICE_TYPE_PV) {
        solarProduction += Math.abs(power);
      } else {
        totalConsumption += Math.abs(power);
      }
    }

    const panelPowerEntity = this._findPanelEntity("current_power");
    if (panelPowerEntity) {
      const state = hass.states[panelPowerEntity];
      if (state) totalConsumption = Math.abs(parseFloat(state.state) || 0);
    }

    const consumptionEl = root.querySelector(".stat-consumption .stat-value");
    if (consumptionEl) consumptionEl.textContent = formatKw(totalConsumption);

    const currentEl = root.querySelector(".stat-current .stat-value");
    if (currentEl) {
      const panelPowerEid = this._findPanelEntity("current_power");
      const panelPowerState = panelPowerEid ? hass.states[panelPowerEid] : null;
      const amperage = panelPowerState ? parseFloat(panelPowerState.attributes?.amperage) : NaN;
      currentEl.textContent = Number.isFinite(amperage) ? amperage.toFixed(1) : "--";
    }
    const solarEl = root.querySelector(".stat-solar .stat-value");
    if (solarEl) solarEl.textContent = solarProduction > 0 ? formatKw(solarProduction) : "--";

    const chartMetric = getChartMetric(this._config);
    const showCurrent = chartMetric.entityRole === "current";

    for (const [uuid, circuit] of Object.entries(topo.circuits)) {
      const slot = root.querySelector(`[data-uuid="${uuid}"]`);
      if (!slot) continue;

      const entityId = circuit.entities?.power;
      const state = entityId ? hass.states[entityId] : null;
      const powerW = state ? parseFloat(state.state) || 0 : 0;
      const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

      const switchEntityId = circuit.entities?.switch;
      const switchState = switchEntityId ? hass.states[switchEntityId] : null;
      const isOn = switchState ? switchState.state === "on" : (state?.attributes?.relay_state || circuit.relay_state) === RELAY_STATE_CLOSED;

      const powerVal = slot.querySelector(".power-value");
      if (powerVal) {
        if (showCurrent) {
          const currentEid = circuit.entities?.current;
          const currentState = currentEid ? hass.states[currentEid] : null;
          const amps = currentState ? parseFloat(currentState.state) || 0 : 0;
          powerVal.innerHTML = `<strong>${chartMetric.format(amps)}</strong><span class="power-unit">A</span>`;
        } else {
          powerVal.innerHTML = `<strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>`;
        }
      }

      const toggle = slot.querySelector(".toggle-pill");
      if (toggle) {
        toggle.className = `toggle-pill ${isOn ? "toggle-on" : "toggle-off"}`;
        const label = toggle.querySelector(".toggle-label");
        if (label) label.textContent = isOn ? "On" : "Off";
      }

      slot.classList.toggle("circuit-off", !isOn);
      slot.classList.toggle("circuit-producer", isProducer);

      const chartContainer = slot.querySelector(".chart-container");
      if (chartContainer) {
        const history = this._powerHistory.get(uuid) || [];
        const h = slot.classList.contains("circuit-col-span") ? 200 : 100;
        updateChart(chartContainer, hass, history, durationMs, chartMetric, isProducer, h, circuit.breaker_rating_a);
      }
    }

    this._updateSubDeviceDOM(root, hass, topo, durationMs);
  }

  _updateSubDeviceDOM(root, hass, topo, durationMs) {
    if (!topo.sub_devices) return;
    for (const [devId, sub] of Object.entries(topo.sub_devices)) {
      const section = root.querySelector(`[data-subdev="${devId}"]`);
      if (!section) continue;

      const powerEid = findSubDevicePowerEntity(sub);
      if (powerEid) {
        const state = hass.states[powerEid];
        const powerW = state ? parseFloat(state.state) || 0 : 0;
        const powerEl = section.querySelector(".sub-power-value");
        if (powerEl) {
          powerEl.innerHTML = `<strong>${formatPowerSigned(powerW)}</strong> <span class="power-unit">${formatPowerUnit(powerW)}</span>`;
        }
      }

      const chartContainers = section.querySelectorAll("[data-chart-key]");
      for (const cc of chartContainers) {
        const chartKey = cc.dataset.chartKey;
        const history = this._powerHistory.get(chartKey) || [];
        let metric = CHART_METRICS.power;
        if (chartKey.endsWith("_soc")) metric = BESS_CHART_METRICS.soc;
        else if (chartKey.endsWith("_soe")) metric = BESS_CHART_METRICS.soe;
        const isBessCol = !!cc.closest(".bess-chart-col");
        updateChart(cc, hass, history, durationMs, metric, false, isBessCol ? 120 : 150);
      }

      for (const entityId of Object.keys(sub.entities || {})) {
        const valEl = section.querySelector(`[data-eid="${entityId}"]`);
        if (!valEl) continue;
        const state = hass.states[entityId];
        if (state) {
          valEl.textContent = `${state.state}${state.attributes.unit_of_measurement ? " " + state.attributes.unit_of_measurement : ""}`;
        }
      }
    }
  }

  _findPanelEntity(suffix) {
    if (!this._hass) return null;
    for (const entityId of Object.keys(this._hass.states)) {
      if (entityId.startsWith("sensor.span_panel_") && entityId.endsWith(`_${suffix}`)) {
        return entityId;
      }
    }
    return null;
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
