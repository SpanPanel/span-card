/**
 * SPAN Panel Card — Custom Lovelace card for Home Assistant
 *
 * Renders a physical representation of a SPAN electrical panel matching
 * the native SPAN frontend design with live power charts.
 *
 * Config:
 *   type: custom:span-panel-card
 *   device_id: <HA device registry ID for the SPAN Panel>
 *   history_days: 0       (0-30, default 0)
 *   history_hours: 0      (0-23, default 0)
 *   history_minutes: 5    (0-59, default 5)
 */

const CARD_VERSION = "0.8.5";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HISTORY_DAYS = 0;
const DEFAULT_HISTORY_HOURS = 0;
const DEFAULT_HISTORY_MINUTES = 5;
const DEFAULT_CHART_METRIC = "power";
const LIVE_SAMPLE_INTERVAL_MS = 1000;

// Chart metric definitions: maps config value → { entityRole, unit, formatValue, label }
const CHART_METRICS = {
  power: {
    entityRole: "power",
    label: "Power",
    unit: v => (Math.abs(v) >= 1000 ? "kW" : "W"),
    format: v => (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) : String(Math.round(Math.abs(v)))),
  },
  current: {
    entityRole: "current",
    label: "Current",
    unit: () => "A",
    format: v => Math.abs(v).toFixed(1),
  },
};

// Fixed metric definitions for BESS charts (not user-configurable)
const BESS_CHART_METRICS = {
  soc: {
    label: "State of Charge",
    unit: () => "%",
    format: v => String(Math.round(v)),
    fixedMin: 0,
    fixedMax: 100,
  },
  soe: {
    label: "State of Energy",
    unit: () => "kWh",
    format: v => v.toFixed(1),
  },
  power: CHART_METRICS.power,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function tabToRow(tab) {
  return Math.ceil(tab / 2);
}

function tabToCol(tab) {
  return tab % 2 === 0 ? 1 : 0;
}

function formatPower(watts) {
  const abs = Math.abs(watts);
  if (abs >= 1000) return (abs / 1000).toFixed(1);
  return Math.round(abs).toString();
}

function formatPowerUnit(watts) {
  return Math.abs(watts) >= 1000 ? "kW" : "W";
}

function formatPowerSigned(watts) {
  const abs = Math.abs(watts);
  const sign = watts < 0 ? "-" : "";
  if (abs >= 1000) return sign + (abs / 1000).toFixed(1);
  return sign + Math.round(abs).toString();
}

function formatKw(watts) {
  return (Math.abs(watts) / 1000).toFixed(1);
}

function classifyDualTab(tabs) {
  if (tabs.length !== 2) return null;
  const [a, b] = [Math.min(...tabs), Math.max(...tabs)];
  if (tabToRow(a) === tabToRow(b)) return "row-span";
  if (tabToCol(a) === tabToCol(b)) return "col-span";
  return "row-span";
}

function getChartMetric(config) {
  return CHART_METRICS[config.chart_metric] || CHART_METRICS[DEFAULT_CHART_METRIC];
}

function getChartEntityRole(config) {
  return getChartMetric(config).entityRole;
}

function getCircuitChartEntity(circuit, config) {
  const role = getChartEntityRole(config);
  return circuit.entities?.[role] || circuit.entities?.power || null;
}

// Find the power sensor entity_id in a sub-device's flat entity map
function findSubDevicePowerEntity(subDevice) {
  if (!subDevice.entities) return null;
  for (const [entityId, info] of Object.entries(subDevice.entities)) {
    if (info.domain !== "sensor") continue;
    const name = (info.original_name || "").toLowerCase();
    if (name === "power" || name === "battery power") return entityId;
    if (info.unique_id && info.unique_id.endsWith("_power")) return entityId;
  }
  return null;
}

// Find the battery level (SoC %) entity in a BESS sub-device
function findBatteryLevelEntity(subDevice) {
  if (!subDevice.entities) return null;
  for (const [entityId, info] of Object.entries(subDevice.entities)) {
    if (info.domain !== "sensor") continue;
    const name = (info.original_name || "").toLowerCase();
    if (name === "battery level" || name === "battery percentage") return entityId;
    if (info.unique_id && info.unique_id.endsWith("_battery_level")) return entityId;
    if (info.unique_id && info.unique_id.endsWith("_battery_percentage")) return entityId;
  }
  return null;
}

// Find the SoE (kWh) entity in a BESS sub-device
function findBatterySoeEntity(subDevice) {
  if (!subDevice.entities) return null;
  for (const [entityId, info] of Object.entries(subDevice.entities)) {
    if (info.domain !== "sensor") continue;
    const name = (info.original_name || "").toLowerCase();
    if (name === "state of energy") return entityId;
    if (info.unique_id && info.unique_id.endsWith("_soe_kwh")) return entityId;
  }
  return null;
}

// Find the nameplate capacity entity in a BESS sub-device
function findBatteryCapacityEntity(subDevice) {
  if (!subDevice.entities) return null;
  for (const [entityId, info] of Object.entries(subDevice.entities)) {
    if (info.domain !== "sensor") continue;
    const name = (info.original_name || "").toLowerCase();
    if (name === "nameplate capacity") return entityId;
    if (info.unique_id && info.unique_id.endsWith("_nameplate_capacity")) return entityId;
  }
  return null;
}

function getHistoryDurationMs(config) {
  const d = parseInt(config.history_days) || DEFAULT_HISTORY_DAYS;
  const h = parseInt(config.history_hours) || DEFAULT_HISTORY_HOURS;
  const hasExplicit = config.history_days !== undefined || config.history_hours !== undefined;
  const m = parseInt(config.history_minutes) || (hasExplicit && config.history_minutes === undefined ? 0 : DEFAULT_HISTORY_MINUTES);
  const total = ((d * 24 + h) * 60 + m) * 60 * 1000;
  return Math.max(total, 60000); // minimum 1 minute
}

function getMaxHistoryPoints(durationMs) {
  // ~1 point per second for durations up to 10 minutes,
  // then taper to avoid memory bloat
  const seconds = durationMs / 1000;
  if (seconds <= 600) return Math.ceil(seconds);
  return Math.min(1200, Math.ceil(seconds / 5));
}

// ── Chart helpers (ha-chart-base) ─────────────────────────────────────────────

function buildChartOptions(history, durationMs, metric, isProducer) {
  if (!metric) metric = CHART_METRICS[DEFAULT_CHART_METRIC];
  const accentRgb = isProducer ? "140, 160, 220" : "77, 217, 175";
  const accentColor = `rgb(${accentRgb})`;
  const now = Date.now();
  const startTime = now - durationMs;

  const hasFixedRange = metric.fixedMin !== undefined && metric.fixedMax !== undefined;
  const unit = metric.unit(0);

  // Build data array: [[timestamp, value], ...]
  const data = (history || []).filter(p => p.time >= startTime).map(p => [p.time, Math.abs(p.value)]);

  const series = [
    {
      type: "line",
      data,
      showSymbol: false,
      smooth: false,
      lineStyle: { width: 1.5, color: accentColor },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: `rgba(${accentRgb}, 0.35)` },
            { offset: 1, color: `rgba(${accentRgb}, 0.02)` },
          ],
        },
      },
      itemStyle: { color: accentColor },
    },
  ];

  const yAxis = {
    type: "value",
    splitNumber: 4,
    axisLabel: {
      fontSize: 10,
      formatter: v => metric.format(v),
    },
    splitLine: { lineStyle: { opacity: 0.15 } },
  };
  if (hasFixedRange) {
    yAxis.min = metric.fixedMin;
    yAxis.max = metric.fixedMax;
  }

  const options = {
    xAxis: {
      type: "time",
      min: startTime,
      max: now,
      axisLabel: { fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis,
    grid: { top: 8, right: 4, bottom: 0, left: 0, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { type: "dashed" } },
      formatter: params => {
        if (!params || !params.length) return "";
        const p = params[0];
        const date = new Date(p.value[0]);
        const timeStr = date.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const val = parseFloat(p.value[1].toFixed(2));
        return `<div style="font-size:12px">${timeStr}<br/><strong>${val} ${unit}</strong></div>`;
      },
    },
    animation: false,
  };

  return { options, series };
}

// Create or update a ha-chart-base element inside a container
function updateChart(container, hass, history, durationMs, metric, isProducer, heightPx) {
  const { options, series } = buildChartOptions(history, durationMs, metric, isProducer);
  let chart = container.querySelector("ha-chart-base");
  if (!chart) {
    chart = document.createElement("ha-chart-base");
    chart.style.display = "block";
    chart.style.width = "100%";
    chart.height = (heightPx || 120) + "px";
    container.innerHTML = "";
    container.appendChild(chart);
  }
  chart.hass = hass;
  chart.options = options;
  chart.data = series;
}

// ── Card Element ─────────────────────────────────────────────────────────────

class SpanPanelCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._discovered = false;
    this._discovering = false;

    this._topology = null;
    this._panelDevice = null;
    this._panelSize = 32;

    // Power history per circuit (keyed by circuit UUID)
    this._powerHistory = new Map();
    this._historyLoaded = false;

    this._updateInterval = null;
    this._rendered = false;
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
        // Load history from HA recorder
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

  // ── History from HA recorder ─────────────────────────────────────────────

  async _loadHistory() {
    if (this._historyLoaded || !this._topology || !this._hass) return;
    this._historyLoaded = true;

    const durationMs = this._durationMs;
    const startTime = new Date(Date.now() - durationMs).toISOString();
    const entityIds = [];
    const uuidByEntity = new Map();

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const eid = getCircuitChartEntity(circuit, this._config);
      if (eid) {
        entityIds.push(eid);
        uuidByEntity.set(eid, uuid);
      }
    }

    // Sub-device entities (power for all, plus SoC/SoE for BESS)
    if (this._topology.sub_devices) {
      for (const [devId, sub] of Object.entries(this._topology.sub_devices)) {
        const eidMap = { power: findSubDevicePowerEntity(sub) };
        if (sub.type === "bess") {
          eidMap.soc = findBatteryLevelEntity(sub);
          eidMap.soe = findBatterySoeEntity(sub);
        }
        for (const [role, eid] of Object.entries(eidMap)) {
          if (eid) {
            entityIds.push(eid);
            uuidByEntity.set(eid, `sub_${devId}_${role}`);
          }
        }
      }
    }

    if (entityIds.length === 0) return;

    try {
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: startTime,
        entity_ids: entityIds,
        minimal_response: true,
        significant_changes_only: false,
        no_attributes: true,
      });

      for (const [entityId, states] of Object.entries(result)) {
        const uuid = uuidByEntity.get(entityId);
        if (!uuid || !states) continue;

        const hist = [];
        for (const entry of states) {
          const val = parseFloat(entry.s);
          if (!Number.isFinite(val)) continue;
          // Compressed state format: lu=last_updated, lc=last_changed (seconds since epoch)
          // lu is only present when last_updated != last_changed; fall back to lc
          const tsSec = entry.lu || entry.lc || 0;
          const time = tsSec * 1000;
          if (time > 0) {
            hist.push({ time, value: val });
          }
        }

        if (hist.length > 0) {
          // Merge with any live samples already collected
          const existing = this._powerHistory.get(uuid) || [];
          const merged = [...hist, ...existing];
          merged.sort((a, b) => a.time - b.time);

          // Deduplicate by keeping points at least 500ms apart
          const deduped = [merged[0]];
          for (let i = 1; i < merged.length; i++) {
            if (merged[i].time - deduped[deduped.length - 1].time >= 500) {
              deduped.push(merged[i]);
            }
          }

          const maxPoints = getMaxHistoryPoints(durationMs);
          if (deduped.length > maxPoints) {
            deduped.splice(0, deduped.length - maxPoints);
          }
          this._powerHistory.set(uuid, deduped);
        }
      }

      this._updateDOM();
    } catch (err) {
      console.warn("SPAN Panel: history fetch failed, charts will populate live", err);
    }
  }

  // ── Discovery via WebSocket API ──────────────────────────────────────────

  async _discoverTopology() {
    const hass = this._hass;
    if (!hass) return;

    try {
      this._topology = await hass.callWS({
        type: "span_panel/panel_topology",
        device_id: this._config.device_id,
      });
    } catch (err) {
      console.error("SPAN Panel: topology fetch failed, falling back to entity discovery", err);
      await this._discoverEntitiesFallback();
      return;
    }

    if (this._topology) {
      this._panelSize = this._topology.panel_size || 32;
      const devices = await hass.callWS({ type: "config/device_registry/list" });
      this._panelDevice = devices.find(d => d.id === this._config.device_id) || null;
    }
  }

  async _discoverEntitiesFallback() {
    const hass = this._hass;
    const [devices, entities] = await Promise.all([hass.callWS({ type: "config/device_registry/list" }), hass.callWS({ type: "config/entity_registry/list" })]);

    this._panelDevice = devices.find(d => d.id === this._config.device_id) || null;
    if (!this._panelDevice) return;

    const allEntities = entities.filter(e => e.device_id === this._config.device_id);
    const subDevices = devices.filter(d => d.via_device_id === this._config.device_id);
    const subDeviceIds = new Set(subDevices.map(d => d.id));
    const subEntities = entities.filter(e => subDeviceIds.has(e.device_id));

    const circuits = {};

    for (const ent of [...allEntities, ...subEntities]) {
      const state = hass.states[ent.entity_id];
      if (!state || !state.attributes || !state.attributes.tabs) continue;

      const tabsAttr = state.attributes.tabs;
      if (!tabsAttr || !tabsAttr.startsWith("tabs [")) continue;
      const content = tabsAttr.slice(6, -1);
      let tabs;
      if (content.includes(":")) {
        tabs = content.split(":").map(Number);
      } else {
        tabs = [Number(content)];
      }
      if (!tabs.every(Number.isFinite)) continue;

      const uidParts = ent.unique_id.split("_");
      let circuitUuid = null;
      for (let i = 2; i < uidParts.length - 1; i++) {
        if (uidParts[i].length >= 16 && /^[a-f0-9]+$/i.test(uidParts[i])) {
          circuitUuid = uidParts[i];
          break;
        }
      }
      if (!circuitUuid) continue;

      let displayName = state.attributes.friendly_name || ent.entity_id;
      for (const suffix of [" Power", " Consumed Energy", " Produced Energy"]) {
        if (displayName.endsWith(suffix)) {
          displayName = displayName.slice(0, -suffix.length);
          break;
        }
      }
      if (this._panelDevice) {
        const devName = this._panelDevice.name_by_user || this._panelDevice.name || "";
        if (displayName.startsWith(devName + " ")) {
          displayName = displayName.slice(devName.length + 1);
        }
      }

      const base = ent.entity_id.replace(/^sensor\./, "").replace(/_power$/, "");

      circuits[circuitUuid] = {
        tabs,
        name: displayName,
        voltage: state.attributes.voltage || (tabs.length === 2 ? 240 : 120),
        device_type: state.attributes.device_type || "circuit",
        relay_state: state.attributes.relay_state || "UNKNOWN",
        is_user_controllable: true,
        breaker_rating_a: null,
        entities: {
          power: ent.entity_id,
          switch: `switch.${base}_breaker`,
          breaker_rating: `sensor.${base}_breaker_rating`,
        },
      };
    }

    let serial = "";
    if (this._panelDevice.identifiers) {
      for (const pair of this._panelDevice.identifiers) {
        if (pair[0] === "span_panel") serial = pair[1];
      }
    }

    for (const ent of allEntities) {
      const state = hass.states[ent.entity_id];
      if (state && state.attributes && state.attributes.panel_size) {
        this._panelSize = state.attributes.panel_size;
        break;
      }
    }

    const subDeviceMap = {};
    for (const sub of subDevices) {
      const subEnts = entities.filter(e => e.device_id === sub.id);
      const isBess = (sub.model || "").toLowerCase().includes("battery") || (sub.identifiers || []).some(p => (p[1] || "").toLowerCase().includes("bess"));
      const isEvse = (sub.model || "").toLowerCase().includes("drive") || (sub.identifiers || []).some(p => (p[1] || "").toLowerCase().includes("evse"));

      const entMap = {};
      for (const e of subEnts) {
        entMap[e.entity_id] = {
          domain: e.entity_id.split(".")[0],
          original_name: hass.states[e.entity_id]?.attributes?.friendly_name || e.entity_id,
        };
      }

      subDeviceMap[sub.id] = {
        name: sub.name_by_user || sub.name || "",
        type: isBess ? "bess" : isEvse ? "evse" : "unknown",
        entities: entMap,
      };
    }

    this._topology = {
      serial,
      firmware: this._panelDevice.sw_version || "",
      panel_size: this._panelSize,
      device_id: this._config.device_id,
      device_name: this._panelDevice.name_by_user || this._panelDevice.name || "SPAN Panel",
      circuits,
      sub_devices: subDeviceMap,
    };
  }

  // ── Record live power samples ────────────────────────────────────────────

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

      if (!this._powerHistory.has(uuid)) {
        this._powerHistory.set(uuid, []);
      }
      const hist = this._powerHistory.get(uuid);
      hist.push({ time: now, value: rawValue });

      while (hist.length > 0 && hist[0].time < cutoff) {
        hist.shift();
      }
      if (hist.length > maxPoints) {
        hist.splice(0, hist.length - maxPoints);
      }
    }

    // Sub-device sampling (power for all, plus SoC/SoE for BESS)
    if (this._topology.sub_devices) {
      for (const [devId, sub] of Object.entries(this._topology.sub_devices)) {
        const eidMap = { power: findSubDevicePowerEntity(sub) };
        if (sub.type === "bess") {
          eidMap.soc = findBatteryLevelEntity(sub);
          eidMap.soe = findBatterySoeEntity(sub);
        }
        for (const [role, entityId] of Object.entries(eidMap)) {
          if (!entityId) continue;
          const key = `sub_${devId}_${role}`;
          const state = this._hass.states[entityId];
          const rawValue = state ? parseFloat(state.state) || 0 : 0;
          if (!this._powerHistory.has(key)) {
            this._powerHistory.set(key, []);
          }
          const hist = this._powerHistory.get(key);
          hist.push({ time: now, value: rawValue });
          while (hist.length > 0 && hist[0].time < cutoff) {
            hist.shift();
          }
          if (hist.length > maxPoints) {
            hist.splice(0, hist.length - maxPoints);
          }
        }
      }
    }
  }

  // ── Data update (lightweight) ────────────────────────────────────────────

  _updateData() {
    this._recordPowerHistory();
    this._updateDOM();
  }

  // ── DOM updates (incremental) ────────────────────────────────────────────

  _updateDOM() {
    const root = this.shadowRoot;
    if (!root || !this._topology || !this._hass) return;

    const hass = this._hass;
    const topo = this._topology;
    const durationMs = this._durationMs;

    // Update summary stats
    let totalConsumption = 0;
    let solarProduction = 0;

    for (const [, circuit] of Object.entries(topo.circuits)) {
      const entityId = circuit.entities?.power;
      if (!entityId) continue;
      const state = hass.states[entityId];
      const power = state ? parseFloat(state.state) || 0 : 0;
      if (circuit.device_type === "pv") {
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

    // Update each circuit
    for (const [uuid, circuit] of Object.entries(topo.circuits)) {
      const slot = root.querySelector(`[data-uuid="${uuid}"]`);
      if (!slot) continue;

      const entityId = circuit.entities?.power;
      const state = entityId ? hass.states[entityId] : null;
      const powerW = state ? parseFloat(state.state) || 0 : 0;
      const isProducer = circuit.device_type === "pv" || powerW < 0;

      // Determine on/off from the switch entity (authoritative), fallback to relay_state attribute
      const switchEntityId = circuit.entities?.switch;
      const switchState = switchEntityId ? hass.states[switchEntityId] : null;
      const isOn = switchState ? switchState.state === "on" : (state?.attributes?.relay_state || circuit.relay_state) === "CLOSED";

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

    // Update sub-device sections
    if (topo.sub_devices) {
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

        // Update all charts by data-chart-key
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

        // Update all entity values
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

  // ── Full render ──────────────────────────────────────────────────────────

  _render() {
    const hass = this._hass;
    if (!hass || !this._topology) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 24px; color: var(--secondary-text-color);">
            ${!this._topology ? "Panel device not found. Check device_id in card config." : "Loading..."}
          </div>
        </ha-card>
      `;
      return;
    }

    const topo = this._topology;
    const totalRows = Math.ceil(this._panelSize / 2);
    const panelName = topo.device_name || "SPAN Panel";
    const durationMs = this._durationMs;

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

    let gridHTML = "";
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

      if (rowsToSkipLeft.has(row)) {
        // occupied by col-span above
      } else if (leftEntry && leftEntry.layout === "col-span") {
        gridHTML += this._renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2", "col-span", durationMs);
      } else if (leftEntry && leftEntry.layout === "single") {
        gridHTML += this._renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2", "single", durationMs);
      } else if (!occupiedTabs.has(leftTab)) {
        gridHTML += this._renderEmptySlot(row, "2");
      }

      if (rowsToSkipRight.has(row)) {
        // occupied by col-span above
      } else if (rightEntry && rightEntry.layout === "col-span") {
        gridHTML += this._renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, row, "3", "col-span", durationMs);
      } else if (rightEntry && rightEntry.layout === "single") {
        gridHTML += this._renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, row, "3", "single", durationMs);
      } else if (!occupiedTabs.has(rightTab)) {
        gridHTML += this._renderEmptySlot(row, "3");
      }

      gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 4;">${rightTab}</div>`;
    }

    // Sub-devices (filtered by config)
    const showBattery = this._config.show_battery !== false;
    const showEvse = this._config.show_evse !== false;
    let subDevHTML = "";
    if (topo.sub_devices) {
      for (const [devId, sub] of Object.entries(topo.sub_devices)) {
        if (sub.type === "bess" && !showBattery) continue;
        if (sub.type === "evse" && !showEvse) continue;

        const label = sub.type === "evse" ? "EV Charger" : sub.type === "bess" ? "Battery" : "Sub-device";
        const powerEid = findSubDevicePowerEntity(sub);
        const powerState = powerEid ? hass.states[powerEid] : null;
        const powerW = powerState ? parseFloat(powerState.state) || 0 : 0;

        // BESS-specific: SoC and SoE shown prominently
        const isBess = sub.type === "bess";
        const battLevelEid = isBess ? findBatteryLevelEntity(sub) : null;
        const battSoeEid = isBess ? findBatterySoeEntity(sub) : null;
        const battCapEid = isBess ? findBatteryCapacityEntity(sub) : null;
        const battLevel = battLevelEid && hass.states[battLevelEid] ? parseFloat(hass.states[battLevelEid].state) : null;
        const battSoe = battSoeEid && hass.states[battSoeEid] ? parseFloat(hass.states[battSoeEid].state) : null;
        const battCap = battCapEid && hass.states[battCapEid] ? parseFloat(hass.states[battCapEid].state) : null;

        // Entities to hide from the flat list (shown in header/stats)
        const hideEids = new Set([powerEid, battLevelEid, battSoeEid, battCapEid].filter(Boolean));

        const visibleEnts = this._config.visible_sub_entities || {};
        let entHTML = "";
        if (sub.entities) {
          for (const [entityId, info] of Object.entries(sub.entities)) {
            if (hideEids.has(entityId)) continue;
            // Per-entity visibility: default hidden (must be explicitly enabled)
            if (visibleEnts[entityId] !== true) continue;
            const state = hass.states[entityId];
            if (!state) continue;
            let name = info.original_name || state.attributes.friendly_name || entityId;
            const devName = sub.name || "";
            if (name.startsWith(devName + " ")) name = name.slice(devName.length + 1);
            // Use HA's translated/formatted state when available, else raw
            let displayValue;
            if (hass.formatEntityState) {
              displayValue = hass.formatEntityState(state);
            } else {
              displayValue = state.state;
              const unit = state.attributes.unit_of_measurement || "";
              if (unit) displayValue += " " + unit;
            }
            // Convert Wh energy to kWh with 1 decimal for readability
            const rawUnit = state.attributes.unit_of_measurement || "";
            if (rawUnit === "Wh") {
              const wh = parseFloat(state.state);
              if (!isNaN(wh)) displayValue = (wh / 1000).toFixed(1) + " kWh";
            }
            entHTML += `
              <div class="sub-entity">
                <span class="sub-entity-name">${name}:</span>
                <span class="sub-entity-value" data-eid="${entityId}">${displayValue}</span>
              </div>
            `;
          }
        }

        let chartsHTML = "";
        if (isBess) {
          // Three charts side by side: SoC, SoE, Power
          const bessCharts = [
            { key: `sub_${devId}_soc`, metric: BESS_CHART_METRICS.soc, title: "SoC", available: !!battLevelEid },
            { key: `sub_${devId}_soe`, metric: BESS_CHART_METRICS.soe, title: "SoE", available: !!battSoeEid },
            { key: `sub_${devId}_power`, metric: BESS_CHART_METRICS.power, title: "Power", available: !!powerEid },
          ].filter(c => c.available);

          chartsHTML = `
            <div class="bess-charts">
              ${bessCharts
                .map(
                  c => `
                <div class="bess-chart-col">
                  <div class="bess-chart-title">${c.title}</div>
                  <div class="chart-container" data-chart-key="${c.key}"></div>
                </div>
              `
                )
                .join("")}
            </div>
          `;
        } else if (powerEid) {
          chartsHTML = `<div class="chart-container" data-chart-key="sub_${devId}_power"></div>`;
        }

        subDevHTML += `
          <div class="sub-device ${isBess ? "sub-device-bess" : ""}" data-subdev="${devId}">
            <div class="sub-device-header">
              <span class="sub-device-type">${label}</span>
              <span class="sub-device-name">${sub.name || ""}</span>
              ${powerEid ? `<span class="sub-power-value"><strong>${formatPowerSigned(powerW)}</strong> <span class="power-unit">${formatPowerUnit(powerW)}</span></span>` : ""}
            </div>
            ${chartsHTML}
            ${entHTML}
          </div>
        `;
      }
    }

    this.shadowRoot.innerHTML = `
      <style>${SpanPanelCard._styles()}</style>
      <ha-card>
        <div class="panel-header">
          <div class="header-left">
            <div class="panel-identity">
              <h1 class="panel-title">${panelName}</h1>
              <span class="panel-serial">${topo.serial || ""}</span>
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
            <span class="meta-item">Firmware: ${topo.firmware || ""}</span>
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

    // Delegate toggle clicks at shadowRoot level (survives DOM updates)
    this.shadowRoot.addEventListener("click", ev => {
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
    });

    this._rendered = true;
    this._recordPowerHistory();
    this._updateDOM();
  }

  _renderCircuitSlot(uuid, circuit, row, col, layout, durationMs) {
    const hass = this._hass;
    const entityId = circuit.entities?.power;
    const state = entityId ? hass.states[entityId] : null;
    const powerW = state ? parseFloat(state.state) || 0 : 0;
    const isProducer = circuit.device_type === "pv" || powerW < 0;

    const switchEntityId = circuit.entities?.switch;
    const switchState = switchEntityId ? hass.states[switchEntityId] : null;
    const isOn = switchState ? switchState.state === "on" : (state?.attributes?.relay_state || circuit.relay_state) === "CLOSED";

    const breakerAmps = circuit.breaker_rating_a;
    const breakerLabel = breakerAmps ? `${Math.round(breakerAmps)}A` : "";
    const name = circuit.name || "Unknown";

    const rowSpan = layout === "col-span" ? `${row} / span 2` : `${row}`;
    const layoutClass = layout === "row-span" ? "circuit-row-span" : layout === "col-span" ? "circuit-col-span" : "";

    return `
      <div class="circuit-slot ${isOn ? "" : "circuit-off"} ${isProducer ? "circuit-producer" : ""} ${layoutClass}"
           style="grid-row: ${rowSpan}; grid-column: ${col};"
           data-uuid="${uuid}">
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

  // ── Styles ───────────────────────────────────────────────────────────────

  static _styles() {
    return `
      :host {
        --span-accent: var(--primary-color, #4dd9af);
      }

      ha-card {
        padding: 24px;
        background: var(--card-background-color, #1c1c1c);
        color: var(--primary-text-color, #e0e0e0);
        border-radius: var(--ha-card-border-radius, 12px);
        border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #333));
        box-shadow: var(--ha-card-box-shadow, none);
      }

      .panel-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 20px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--divider-color, #333);
      }

      .panel-identity {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 12px;
      }

      .panel-title {
        font-size: 1.8em;
        font-weight: 700;
        margin: 0;
        color: var(--primary-text-color, #fff);
      }

      .panel-serial {
        font-size: 0.85em;
        color: var(--secondary-text-color, #999);
        font-family: monospace;
      }

      .panel-stats {
        display: flex;
        gap: 32px;
      }

      .stat { display: flex; flex-direction: column; }
      .stat-label { font-size: 0.8em; color: var(--secondary-text-color, #999); margin-bottom: 2px; }
      .stat-row { display: flex; align-items: baseline; gap: 2px; }
      .stat-value { font-size: 1.5em; font-weight: 700; color: var(--primary-text-color, #fff); }
      .stat-unit { font-size: 0.7em; font-weight: 400; color: var(--secondary-text-color, #999); }

      .header-right { display: flex; gap: 20px; align-items: center; padding-top: 8px; }
      .meta-item { font-size: 0.8em; color: var(--secondary-text-color, #999); }

      .panel-grid {
        display: grid;
        grid-template-columns: 28px 1fr 1fr 28px;
        gap: 8px;
        align-items: stretch;
      }

      .tab-label {
        display: flex;
        align-items: center;
        font-size: 0.85em;
        font-weight: 600;
        color: var(--secondary-text-color, #999);
        user-select: none;
      }
      .tab-left { justify-content: flex-start; }
      .tab-right { justify-content: flex-end; }

      .circuit-slot {
        background: var(--secondary-background-color, var(--card-background-color, #2a2a2a));
        border: 1px solid var(--divider-color, #333);
        border-radius: 12px;
        padding: 14px 16px 20px;
        min-height: 140px;
        transition: opacity 0.3s;
        position: relative;
        overflow: hidden;
      }

      .circuit-col-span { min-height: 280px; }
      .circuit-row-span { border-left: 3px solid var(--span-accent); }
      .circuit-off .circuit-name,
      .circuit-off .breaker-badge,
      .circuit-off .power-value,
      .circuit-off .chart-container { opacity: 0.45; }

      .circuit-empty {
        opacity: 0.2;
        min-height: 60px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-style: dashed;
      }
      .empty-label { color: var(--secondary-text-color, #999); font-size: 0.85em; }

      .circuit-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 6px;
        gap: 8px;
      }

      .circuit-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }

      .breaker-badge {
        background: color-mix(in srgb, var(--span-accent) 15%, transparent);
        color: var(--span-accent);
        font-size: 0.7em;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 4px;
        white-space: nowrap;
        border: 1px solid color-mix(in srgb, var(--span-accent) 25%, transparent);
        flex-shrink: 0;
      }

      .circuit-name {
        font-size: 0.9em;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--primary-text-color, #e0e0e0);
      }

      .circuit-controls { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

      .power-value { font-size: 0.9em; color: var(--primary-text-color, #fff); white-space: nowrap; }
      .power-value strong { font-weight: 700; font-size: 1.1em; }
      .power-unit { font-size: 0.8em; font-weight: 400; color: var(--secondary-text-color, #999); margin-left: 1px; }
      .circuit-producer .power-value strong { color: var(--info-color, #4fc3f7); }

      .toggle-pill {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 2px 4px;
        border-radius: 10px;
        cursor: pointer;
        font-size: 0.65em;
        font-weight: 600;
        transition: background 0.2s;
        user-select: none;
        min-width: 40px;
      }
      .toggle-on {
        padding-left: 6px;
        background: color-mix(in srgb, var(--state-active-color, var(--span-accent)) 25%, transparent);
        color: var(--state-active-color, var(--span-accent));
      }
      .toggle-off {
        padding-right: 6px;
        background: color-mix(in srgb, var(--secondary-text-color) 15%, transparent);
        color: var(--secondary-text-color, #999);
      }
      .toggle-knob {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        transition: background 0.2s, margin 0.2s;
      }
      .toggle-on .toggle-knob {
        background: var(--state-active-color, var(--span-accent));
        margin-left: auto;
      }
      .toggle-off .toggle-knob {
        background: var(--secondary-text-color, #999);
        margin-right: auto;
        order: -1;
      }

      .chart-container {
        width: 100%;
        margin-top: 4px;
      }

      .sub-devices {
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid var(--divider-color, #333);
      }

      .sub-device {
        margin-bottom: 12px;
        background: var(--secondary-background-color, var(--card-background-color, #2a2a2a));
        border: 1px solid var(--divider-color, #333);
        border-radius: 12px;
        padding: 14px 16px;
      }

      .sub-device-header { display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
      .sub-device-type { font-size: 0.7em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--span-accent); }
      .sub-device-name { font-size: 0.85em; color: var(--secondary-text-color, #999); flex: 1; }
      .sub-power-value { font-size: 0.9em; color: var(--primary-text-color, #fff); white-space: nowrap; }
      .sub-power-value strong { font-weight: 700; font-size: 1.1em; }
      .sub-device .chart-container { margin-bottom: 8px; }

      .bess-charts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 10px;
      }
      .bess-chart-col { min-width: 0; }
      .bess-chart-title {
        font-size: 0.75em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--secondary-text-color, #999);
        margin-bottom: 4px;
      }
      .bess-chart-col .chart-container { }
      .sub-entity { display: flex; gap: 6px; padding: 3px 0; font-size: 0.85em; }
      .sub-entity-name { color: var(--secondary-text-color, #999); }
      .sub-entity-value { font-weight: 500; color: var(--primary-text-color, #e0e0e0); }

      @media (max-width: 600px) {
        ha-card { padding: 12px; }
        .panel-header { flex-direction: column; }
        .panel-identity { flex-direction: column; gap: 4px; }
        .panel-title { font-size: 1.4em; }
        .panel-stats { gap: 16px; flex-wrap: wrap; }
        .header-right { margin-top: 8px; }
        .circuit-slot { min-height: 100px; padding: 10px 12px 16px; }
        .circuit-col-span { min-height: 200px; }
        .chart-container { height: 60px; }
        .circuit-col-span .chart-container { height: 140px; }
      }
    `;
  }
}

// ── Config Editor ────────────────────────────────────────────────────────────

class SpanPanelCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._panels = null;
    this._availableRoles = null; // set of entity roles present in topology
    this._built = false;
  }

  setConfig(config) {
    this._config = { ...config };
    this._updateControls();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._panels) {
      this._discoverPanels();
    } else if (!this._built) {
      this._buildEditor();
    }
  }

  async _discoverPanels() {
    if (!this._hass) return;
    const devices = await this._hass.callWS({ type: "config/device_registry/list" });
    this._panels = devices
      .filter(d => (d.identifiers || []).some(pair => pair[0] === "span_panel") && !d.via_device_id)
      .map(d => {
        const serial = (d.identifiers || []).find(p => p[0] === "span_panel")?.[1] || "";
        const name = d.name_by_user || d.name || "SPAN Panel";
        return { device_id: d.id, label: `${name} (${serial})` };
      });
    this._buildEditor();
  }

  _buildEditor() {
    this.innerHTML = "";
    this._built = true;

    const wrapper = document.createElement("div");
    wrapper.style.padding = "16px";

    const fieldStyle = `
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--divider-color, #333);
      background: var(--card-background-color, var(--secondary-background-color, #1c1c1c));
      color: var(--primary-text-color, #e0e0e0);
      font-size: 1em;
      cursor: pointer;
      appearance: auto;
      box-sizing: border-box;
    `;

    const labelStyle = "display: block; font-weight: 500; margin-bottom: 8px; color: var(--primary-text-color);";
    const groupStyle = "margin-bottom: 16px;";

    // Panel selector
    const panelGroup = document.createElement("div");
    panelGroup.style.cssText = groupStyle;
    const panelLabel = document.createElement("label");
    panelLabel.textContent = "SPAN Panel";
    panelLabel.style.cssText = labelStyle;
    const panelSelect = document.createElement("select");
    panelSelect.style.cssText = fieldStyle;

    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "Select a panel...";
    panelSelect.appendChild(emptyOpt);

    if (this._panels) {
      for (const panel of this._panels) {
        const opt = document.createElement("option");
        opt.value = panel.device_id;
        opt.textContent = panel.label;
        if (panel.device_id === this._config.device_id) opt.selected = true;
        panelSelect.appendChild(opt);
      }
    }

    panelSelect.addEventListener("change", () => {
      this._config = { ...this._config, device_id: panelSelect.value };
      this._fireConfigChanged();
      this._discoverAvailableRoles(panelSelect.value);
    });

    panelGroup.appendChild(panelLabel);
    panelGroup.appendChild(panelSelect);
    wrapper.appendChild(panelGroup);

    // Chart time window
    const timeGroup = document.createElement("div");
    timeGroup.style.cssText = groupStyle;
    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Chart time window";
    timeLabel.style.cssText = labelStyle;

    const timeRow = document.createElement("div");
    timeRow.style.cssText = "display: flex; gap: 12px; align-items: center; flex-wrap: wrap;";

    // Days
    const daysWrap = document.createElement("div");
    daysWrap.style.cssText = "display: flex; align-items: center; gap: 6px;";
    const daysInput = document.createElement("input");
    daysInput.type = "number";
    daysInput.min = "0";
    daysInput.max = "30";
    daysInput.value = String(parseInt(this._config.history_days) || DEFAULT_HISTORY_DAYS);
    daysInput.style.cssText = fieldStyle + "width: 70px; cursor: text;";
    const daysLabel = document.createElement("span");
    daysLabel.textContent = "days";
    daysLabel.style.cssText = "font-size: 0.9em; color: var(--secondary-text-color);";
    daysWrap.appendChild(daysInput);
    daysWrap.appendChild(daysLabel);

    // Hours
    const hoursWrap = document.createElement("div");
    hoursWrap.style.cssText = "display: flex; align-items: center; gap: 6px;";
    const hoursInput = document.createElement("input");
    hoursInput.type = "number";
    hoursInput.min = "0";
    hoursInput.max = "23";
    hoursInput.value = String(parseInt(this._config.history_hours) || DEFAULT_HISTORY_HOURS);
    hoursInput.style.cssText = fieldStyle + "width: 70px; cursor: text;";
    const hoursLabel = document.createElement("span");
    hoursLabel.textContent = "hours";
    hoursLabel.style.cssText = "font-size: 0.9em; color: var(--secondary-text-color);";
    hoursWrap.appendChild(hoursInput);
    hoursWrap.appendChild(hoursLabel);

    // Minutes
    const minsWrap = document.createElement("div");
    minsWrap.style.cssText = "display: flex; align-items: center; gap: 6px;";
    const minsInput = document.createElement("input");
    minsInput.type = "number";
    minsInput.min = "0";
    minsInput.max = "59";
    minsInput.value = String(
      parseInt(this._config.history_minutes) ||
        (this._config.history_hours !== undefined && this._config.history_minutes === undefined ? 0 : DEFAULT_HISTORY_MINUTES)
    );
    minsInput.style.cssText = fieldStyle + "width: 70px; cursor: text;";
    const minsLabel = document.createElement("span");
    minsLabel.textContent = "minutes";
    minsLabel.style.cssText = "font-size: 0.9em; color: var(--secondary-text-color);";
    minsWrap.appendChild(minsInput);
    minsWrap.appendChild(minsLabel);

    daysInput.addEventListener("change", () => {
      this._config = { ...this._config, history_days: parseInt(daysInput.value) || 0 };
      this._fireConfigChanged();
    });
    hoursInput.addEventListener("change", () => {
      this._config = { ...this._config, history_hours: parseInt(hoursInput.value) || 0 };
      this._fireConfigChanged();
    });
    minsInput.addEventListener("change", () => {
      this._config = { ...this._config, history_minutes: parseInt(minsInput.value) || 0 };
      this._fireConfigChanged();
    });

    timeRow.appendChild(daysWrap);
    timeRow.appendChild(hoursWrap);
    timeRow.appendChild(minsWrap);
    timeGroup.appendChild(timeLabel);
    timeGroup.appendChild(timeRow);
    wrapper.appendChild(timeGroup);

    // Chart metric selector
    const metricGroup = document.createElement("div");
    metricGroup.style.cssText = groupStyle;
    const metricLabel = document.createElement("label");
    metricLabel.textContent = "Chart metric";
    metricLabel.style.cssText = labelStyle;
    const metricSelect = document.createElement("select");
    metricSelect.style.cssText = fieldStyle;
    this._metricFieldStyle = fieldStyle;

    metricSelect.addEventListener("change", () => {
      this._config = { ...this._config, chart_metric: metricSelect.value };
      this._fireConfigChanged();
    });

    metricGroup.appendChild(metricLabel);
    metricGroup.appendChild(metricSelect);
    wrapper.appendChild(metricGroup);

    // Sections checkboxes
    const sectionsGroup = document.createElement("div");
    sectionsGroup.style.cssText = groupStyle;
    const sectionsLabel = document.createElement("label");
    sectionsLabel.textContent = "Visible sections";
    sectionsLabel.style.cssText = labelStyle;
    sectionsGroup.appendChild(sectionsLabel);

    const checkboxStyle = "display: flex; align-items: center; gap: 8px; margin-bottom: 6px; cursor: pointer;";
    const cbLabelStyle = "font-size: 0.9em; color: var(--primary-text-color); cursor: pointer;";

    const sections = [
      { key: "show_panel", label: "Panel circuits", subDeviceType: null },
      { key: "show_battery", label: "Battery (BESS)", subDeviceType: "bess" },
      { key: "show_evse", label: "EV Charger (EVSE)", subDeviceType: "evse" },
    ];

    this._checkboxes = {};
    this._entityContainers = {};
    for (const sec of sections) {
      const row = document.createElement("div");
      row.style.cssText = checkboxStyle;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this._config[sec.key] !== false;
      cb.style.cssText = "width: 18px; height: 18px; cursor: pointer; accent-color: var(--primary-color);";
      const lbl = document.createElement("span");
      lbl.textContent = sec.label;
      lbl.style.cssText = cbLabelStyle;
      row.appendChild(cb);
      row.appendChild(lbl);
      sectionsGroup.appendChild(row);
      this._checkboxes[sec.key] = cb;

      // Container for per-entity checkboxes (populated after topology discovery)
      let entityContainer = null;
      if (sec.subDeviceType) {
        entityContainer = document.createElement("div");
        entityContainer.style.cssText = "padding-left: 26px;";
        entityContainer.style.display = cb.checked ? "block" : "none";
        sectionsGroup.appendChild(entityContainer);
        this._entityContainers[sec.subDeviceType] = entityContainer;
      }

      cb.addEventListener("change", () => {
        this._config = { ...this._config, [sec.key]: cb.checked };
        if (entityContainer) entityContainer.style.display = cb.checked ? "block" : "none";
        this._fireConfigChanged();
      });
    }

    wrapper.appendChild(sectionsGroup);

    this.appendChild(wrapper);

    this._panelSelect = panelSelect;
    this._daysInput = daysInput;
    this._hoursInput = hoursInput;
    this._minsInput = minsInput;
    this._metricSelect = metricSelect;

    // Populate metric dropdown — discover roles if a panel is already selected
    this._populateMetricSelect();
    if (this._config.device_id) {
      this._discoverAvailableRoles(this._config.device_id);
    }
  }

  _isChartEntity(entityId, info, subDeviceType) {
    const name = (info.original_name || "").toLowerCase();
    const uid = info.unique_id || "";
    // Power is always a chart entity
    if (name === "power" || name === "battery power" || uid.endsWith("_power")) return true;
    if (subDeviceType === "bess") {
      if (name === "battery level" || name === "battery percentage" || uid.endsWith("_battery_level") || uid.endsWith("_battery_percentage")) return true;
      if (name === "state of energy" || uid.endsWith("_soe_kwh")) return true;
      if (name === "nameplate capacity" || uid.endsWith("_nameplate_capacity")) return true;
    }
    return false;
  }

  _populateEntityCheckboxes(subDevices) {
    const visibleEnts = this._config.visible_sub_entities || {};
    const checkboxStyle = "display: flex; align-items: center; gap: 8px; margin-bottom: 5px; cursor: pointer;";
    const cbLabelStyle = "font-size: 0.85em; color: var(--primary-text-color); cursor: pointer;";

    for (const [devId, sub] of Object.entries(subDevices)) {
      const container = this._entityContainers[sub.type];
      if (!container) continue;
      container.innerHTML = "";
      if (!sub.entities) continue;

      for (const [entityId, info] of Object.entries(sub.entities)) {
        if (info.domain === "sensor" && this._isChartEntity(entityId, info, sub.type)) continue;
        const row = document.createElement("div");
        row.style.cssText = checkboxStyle;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = visibleEnts[entityId] === true;
        cb.style.cssText = "width: 16px; height: 16px; cursor: pointer; accent-color: var(--primary-color);";
        const lbl = document.createElement("span");
        let name = info.original_name || entityId;
        const devName = sub.name || "";
        if (name.startsWith(devName + " ")) name = name.slice(devName.length + 1);
        lbl.textContent = name;
        lbl.style.cssText = cbLabelStyle;
        row.appendChild(cb);
        row.appendChild(lbl);
        container.appendChild(row);

        cb.addEventListener("change", () => {
          const updated = { ...(this._config.visible_sub_entities || {}) };
          if (cb.checked) {
            updated[entityId] = true;
          } else {
            delete updated[entityId];
          }
          this._config = { ...this._config, visible_sub_entities: updated };
          this._fireConfigChanged();
        });
      }
    }
  }

  async _discoverAvailableRoles(deviceId) {
    if (!this._hass || !deviceId) return;
    try {
      const topo = await this._hass.callWS({
        type: "span_panel/panel_topology",
        device_id: deviceId,
      });
      const roles = new Set();
      for (const circuit of Object.values(topo.circuits || {})) {
        for (const role of Object.keys(circuit.entities || {})) {
          roles.add(role);
        }
      }
      this._availableRoles = roles;
      this._populateMetricSelect();
      if (topo.sub_devices) {
        this._populateEntityCheckboxes(topo.sub_devices);
      }
    } catch (err) {
      // Topology unavailable — show all metrics as fallback
      this._availableRoles = null;
      this._populateMetricSelect();
    }
  }

  _populateMetricSelect() {
    const select = this._metricSelect;
    if (!select) return;
    const current = this._config.chart_metric || DEFAULT_CHART_METRIC;
    select.innerHTML = "";
    for (const [key, def] of Object.entries(CHART_METRICS)) {
      if (this._availableRoles && !this._availableRoles.has(def.entityRole)) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = def.label;
      if (key === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  _updateControls() {
    if (this._panelSelect) this._panelSelect.value = this._config.device_id || "";
    if (this._daysInput) this._daysInput.value = String(parseInt(this._config.history_days) || 0);
    if (this._hoursInput) this._hoursInput.value = String(parseInt(this._config.history_hours) || 0);
    if (this._minsInput) this._minsInput.value = String(parseInt(this._config.history_minutes) || DEFAULT_HISTORY_MINUTES);
    if (this._metricSelect) this._metricSelect.value = this._config.chart_metric || DEFAULT_CHART_METRIC;
    if (this._checkboxes) {
      for (const [key, cb] of Object.entries(this._checkboxes)) {
        cb.checked = this._config[key] !== false;
      }
    }
  }

  _fireConfigChanged() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

customElements.define("span-panel-card", SpanPanelCard);
customElements.define("span-panel-card-editor", SpanPanelCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "span-panel-card",
  name: "SPAN Panel",
  description: "Physical panel layout with live power charts matching the SPAN frontend",
  preview: true,
});

console.info(
  `%c SPAN-PANEL-CARD %c v${CARD_VERSION} `,
  "background: var(--primary-color, #4dd9af); color: var(--text-primary-color, #000); font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;",
  "background: var(--secondary-background-color, #333); color: var(--primary-text-color, #fff); padding: 2px 6px; border-radius: 0 4px 4px 0;"
);
