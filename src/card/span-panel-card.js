import {
  CHART_METRICS,
  BESS_CHART_METRICS,
  DEFAULT_CHART_METRIC,
  LIVE_SAMPLE_INTERVAL_MS,
  DEVICE_TYPE_PV,
  RELAY_STATE_CLOSED,
  SUB_DEVICE_TYPE_BESS,
  SUB_DEVICE_TYPE_EVSE,
  SUB_DEVICE_KEY_PREFIX,
} from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit, formatKw } from "../helpers/format.js";
import { getHistoryDurationMs, getMaxHistoryPoints, getMinGapMs, recordSample, deduplicateAndTrim } from "../helpers/history.js";
import { tabToRow, tabToCol, classifyDualTab } from "../helpers/layout.js";
import { getChartMetric, getCircuitChartEntity } from "../helpers/chart.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity, findBatteryCapacityEntity } from "../helpers/entity-finder.js";
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
    const solarEl = root.querySelector(".stat-solar .stat-value");
    if (solarEl) solarEl.textContent = solarProduction > 0 ? formatKw(solarProduction) : "--";

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
        powerVal.innerHTML = `<strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>`;
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
        updateChart(chartContainer, hass, history, durationMs, getChartMetric(this._config), isProducer, h);
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

    const gridHTML = this._buildGridHTML(topo, totalRows, durationMs);
    const subDevHTML = this._buildSubDevicesHTML(topo, hass, durationMs);

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

  _buildGridHTML(topo, totalRows, durationMs) {
    const tabMap = new Map();
    const occupiedTabs = new Set();

    for (const [uuid, circuit] of Object.entries(topo.circuits)) {
      const tabs = circuit.tabs;
      if (!tabs || tabs.length === 0) continue;
      const primaryTab = Math.min(...tabs);
      const layout = tabs.length === 1 ? "single" : classifyDualTab(tabs);
      tabMap.set(primaryTab, { uuid, circuit, layout });
      for (const t of tabs) occupiedTabs.add(t);
    }

    const rowsToSkipLeft = new Set();
    const rowsToSkipRight = new Set();

    for (const [primaryTab, entry] of tabMap) {
      if (entry.layout === "col-span") {
        const tabs = entry.circuit.tabs;
        const secondaryTab = Math.max(...tabs);
        const secondaryRow = tabToRow(secondaryTab);
        const col = tabToCol(primaryTab);
        if (col === 0) rowsToSkipLeft.add(secondaryRow);
        else rowsToSkipRight.add(secondaryRow);
      }
    }

    let gridHTML = "";
    for (let row = 1; row <= totalRows; row++) {
      const leftTab = row * 2 - 1;
      const rightTab = row * 2;
      const leftEntry = tabMap.get(leftTab);
      const rightEntry = tabMap.get(rightTab);

      gridHTML += `<div class="tab-label tab-left" style="grid-row: ${row}; grid-column: 1;">${leftTab}</div>`;

      if (leftEntry && leftEntry.layout === "row-span") {
        gridHTML += this._renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2 / 4", "row-span", durationMs);
        gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 4;">${rightTab}</div>`;
        continue;
      }

      if (!rowsToSkipLeft.has(row)) {
        if (leftEntry && (leftEntry.layout === "col-span" || leftEntry.layout === "single")) {
          gridHTML += this._renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2", leftEntry.layout, durationMs);
        } else if (!occupiedTabs.has(leftTab)) {
          gridHTML += this._renderEmptySlot(row, "2");
        }
      }

      if (!rowsToSkipRight.has(row)) {
        if (rightEntry && (rightEntry.layout === "col-span" || rightEntry.layout === "single")) {
          gridHTML += this._renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, row, "3", rightEntry.layout, durationMs);
        } else if (!occupiedTabs.has(rightTab)) {
          gridHTML += this._renderEmptySlot(row, "3");
        }
      }

      gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 4;">${rightTab}</div>`;
    }
    return gridHTML;
  }

  _buildSubDevicesHTML(topo, hass, _durationMs) {
    const showBattery = this._config.show_battery !== false;
    const showEvse = this._config.show_evse !== false;
    let subDevHTML = "";

    if (!topo.sub_devices) return subDevHTML;

    for (const [devId, sub] of Object.entries(topo.sub_devices)) {
      if (sub.type === SUB_DEVICE_TYPE_BESS && !showBattery) continue;
      if (sub.type === SUB_DEVICE_TYPE_EVSE && !showEvse) continue;

      const label = sub.type === SUB_DEVICE_TYPE_EVSE ? "EV Charger" : sub.type === SUB_DEVICE_TYPE_BESS ? "Battery" : "Sub-device";
      const powerEid = findSubDevicePowerEntity(sub);
      const powerState = powerEid ? hass.states[powerEid] : null;
      const powerW = powerState ? parseFloat(powerState.state) || 0 : 0;

      const isBess = sub.type === SUB_DEVICE_TYPE_BESS;
      const battLevelEid = isBess ? findBatteryLevelEntity(sub) : null;
      const battSoeEid = isBess ? findBatterySoeEntity(sub) : null;
      const battCapEid = isBess ? findBatteryCapacityEntity(sub) : null;

      const hideEids = new Set([powerEid, battLevelEid, battSoeEid, battCapEid].filter(Boolean));
      const entHTML = this._buildSubEntityHTML(sub, hass, hideEids);
      const chartsHTML = this._buildSubDeviceChartsHTML(devId, sub, isBess, powerEid, battLevelEid, battSoeEid);

      subDevHTML += `
        <div class="sub-device ${isBess ? "sub-device-bess" : ""}" data-subdev="${escapeHtml(devId)}">
          <div class="sub-device-header">
            <span class="sub-device-type">${escapeHtml(label)}</span>
            <span class="sub-device-name">${escapeHtml(sub.name || "")}</span>
            ${powerEid ? `<span class="sub-power-value"><strong>${formatPowerSigned(powerW)}</strong> <span class="power-unit">${formatPowerUnit(powerW)}</span></span>` : ""}
          </div>
          ${chartsHTML}
          ${entHTML}
        </div>
      `;
    }
    return subDevHTML;
  }

  _buildSubEntityHTML(sub, hass, hideEids) {
    const visibleEnts = this._config.visible_sub_entities || {};
    let entHTML = "";
    if (!sub.entities) return entHTML;

    for (const [entityId, info] of Object.entries(sub.entities)) {
      if (hideEids.has(entityId)) continue;
      if (visibleEnts[entityId] !== true) continue;
      const state = hass.states[entityId];
      if (!state) continue;
      let name = info.original_name || state.attributes.friendly_name || entityId;
      const devName = sub.name || "";
      if (name.startsWith(devName + " ")) name = name.slice(devName.length + 1);
      let displayValue;
      if (hass.formatEntityState) {
        displayValue = hass.formatEntityState(state);
      } else {
        displayValue = state.state;
        const unit = state.attributes.unit_of_measurement || "";
        if (unit) displayValue += " " + unit;
      }
      const rawUnit = state.attributes.unit_of_measurement || "";
      if (rawUnit === "Wh") {
        const wh = parseFloat(state.state);
        if (!isNaN(wh)) displayValue = (wh / 1000).toFixed(1) + " kWh";
      }
      entHTML += `
        <div class="sub-entity">
          <span class="sub-entity-name">${escapeHtml(name)}:</span>
          <span class="sub-entity-value" data-eid="${escapeHtml(entityId)}">${escapeHtml(displayValue)}</span>
        </div>
      `;
    }
    return entHTML;
  }

  _buildSubDeviceChartsHTML(devId, sub, isBess, powerEid, battLevelEid, battSoeEid) {
    if (isBess) {
      const bessCharts = [
        { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_soc`, title: "SoC", available: !!battLevelEid },
        { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_soe`, title: "SoE", available: !!battSoeEid },
        { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_power`, title: "Power", available: !!powerEid },
      ].filter(c => c.available);

      return `
        <div class="bess-charts">
          ${bessCharts
            .map(
              c => `
            <div class="bess-chart-col">
              <div class="bess-chart-title">${escapeHtml(c.title)}</div>
              <div class="chart-container" data-chart-key="${escapeHtml(c.key)}"></div>
            </div>
          `
            )
            .join("")}
        </div>
      `;
    }
    if (powerEid) {
      return `<div class="chart-container" data-chart-key="${SUB_DEVICE_KEY_PREFIX}${escapeHtml(devId)}_power"></div>`;
    }
    return "";
  }

  _renderCircuitSlot(uuid, circuit, row, col, layout, _durationMs) {
    const hass = this._hass;
    const entityId = circuit.entities?.power;
    const state = entityId ? hass.states[entityId] : null;
    const powerW = state ? parseFloat(state.state) || 0 : 0;
    const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

    const switchEntityId = circuit.entities?.switch;
    const switchState = switchEntityId ? hass.states[switchEntityId] : null;
    const isOn = switchState ? switchState.state === "on" : (state?.attributes?.relay_state || circuit.relay_state) === RELAY_STATE_CLOSED;

    const breakerAmps = circuit.breaker_rating_a;
    const breakerLabel = breakerAmps ? `${Math.round(breakerAmps)}A` : "";
    const name = escapeHtml(circuit.name || "Unknown");

    const rowSpan = layout === "col-span" ? `${row} / span 2` : `${row}`;
    const layoutClass = layout === "row-span" ? "circuit-row-span" : layout === "col-span" ? "circuit-col-span" : "";

    return `
      <div class="circuit-slot ${isOn ? "" : "circuit-off"} ${isProducer ? "circuit-producer" : ""} ${layoutClass}"
           style="grid-row: ${rowSpan}; grid-column: ${col};"
           data-uuid="${escapeHtml(uuid)}">
        <div class="circuit-header">
          <div class="circuit-info">
            ${breakerLabel ? `<span class="breaker-badge">${breakerLabel}</span>` : ""}
            <span class="circuit-name">${name}</span>
          </div>
          <div class="circuit-controls">
            <span class="power-value">
              <strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>
            </span>
            ${
              circuit.is_user_controllable !== false && circuit.entities?.switch
                ? `
              <div class="toggle-pill ${isOn ? "toggle-on" : "toggle-off"}">
                <span class="toggle-label">${isOn ? "On" : "Off"}</span>
                <span class="toggle-knob"></span>
              </div>
            `
                : ""
            }
          </div>
        </div>
        <div class="chart-container"></div>
      </div>
    `;
  }

  _renderEmptySlot(row, col) {
    return `
      <div class="circuit-slot circuit-empty" style="grid-row: ${row}; grid-column: ${col};">
        <span class="empty-label">&mdash;</span>
      </div>
    `;
  }
}
