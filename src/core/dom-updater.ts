import {
  BESS_CHART_METRICS,
  DEVICE_TYPE_PV,
  CIRCUIT_CHART_HEIGHT,
  CIRCUIT_COL_SPAN_CHART_HEIGHT,
  BESS_CHART_COL_HEIGHT,
  EVSE_CHART_HEIGHT,
} from "../constants.js";
import { formatPowerSigned, formatPowerUnit, formatPowerHTML, formatKw } from "../helpers/format.js";
import { getChartMetric } from "../helpers/chart.js";
import { resolveSubDevicePower, stateWatts } from "../helpers/sub-device-power.js";
import { getHistoryDurationMs, getHorizonDurationMs } from "../helpers/history.js";
import { updateChart } from "../chart/chart-update.js";
import { attrSelectorValue } from "../helpers/selector.js";
import { relayClosed, shedPriorityKey, switchPresence } from "./circuit-state.js";
import { applySheddingIcon, applyTogglePill } from "./circuit-controls.js";
import type { HomeAssistant, PanelTopology, CardConfig, HistoryMap, ChartMetricDef } from "../types.js";

// ── Header stats ───────────────────────────────────────────────────────────

/**
 * Update a single ``.panel-stats`` block in-place from a specific
 * topology. Shared between the standard panel header (one block rooted
 * at the document) and the Favorites view (multiple per-panel blocks).
 */
export function updatePanelStatsBlock(scope: Element, hass: HomeAssistant, topology: PanelTopology, config: CardConfig, siteConsumptionFallback: number): void {
  const isAmpsMode = (config.chart_metric || "power") === "current";

  // Site / consumption stat
  const consumptionEl = scope.querySelector(".stat-consumption .stat-value");
  const consumptionUnitEl = scope.querySelector(".stat-consumption .stat-unit");
  if (isAmpsMode) {
    const siteEid = topology.panel_entities?.site_power;
    const siteState = siteEid ? hass.states[siteEid] : null;
    const amps = siteState ? parseFloat(siteState.attributes?.amperage as string) : NaN;
    if (consumptionEl) consumptionEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : "--";
    if (consumptionUnitEl) consumptionUnitEl.textContent = "A";
  } else {
    let totalConsumption = siteConsumptionFallback;
    const siteEid = topology.panel_entities?.site_power;
    if (siteEid) {
      const state = hass.states[siteEid];
      if (state) totalConsumption = Math.abs(parseFloat(state.state) || 0);
    }
    if (consumptionEl) consumptionEl.textContent = formatKw(totalConsumption);
    if (consumptionUnitEl) consumptionUnitEl.textContent = "kW";
  }

  // Upstream stat
  const upstreamEl = scope.querySelector(".stat-upstream .stat-value");
  const upstreamUnitEl = scope.querySelector(".stat-upstream .stat-unit");
  if (upstreamEl) {
    const upEid = topology.panel_entities?.current_power;
    const upState = upEid ? hass.states[upEid] : null;
    if (isAmpsMode) {
      const amps = upState ? parseFloat(upState.attributes?.amperage as string) : NaN;
      upstreamEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : "--";
      if (upstreamUnitEl) upstreamUnitEl.textContent = "A";
    } else {
      const w = upState ? Math.abs(parseFloat(upState.state) || 0) : 0;
      upstreamEl.textContent = formatKw(w);
      if (upstreamUnitEl) upstreamUnitEl.textContent = "kW";
    }
  }

  // Downstream stat
  const downstreamEl = scope.querySelector(".stat-downstream .stat-value");
  const downstreamUnitEl = scope.querySelector(".stat-downstream .stat-unit");
  if (downstreamEl) {
    const downEid = topology.panel_entities?.feedthrough_power;
    const downState = downEid ? hass.states[downEid] : null;
    if (isAmpsMode) {
      const amps = downState ? parseFloat(downState.attributes?.amperage as string) : NaN;
      downstreamEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : "--";
      if (downstreamUnitEl) downstreamUnitEl.textContent = "A";
    } else {
      const w = downState ? Math.abs(parseFloat(downState.state) || 0) : 0;
      downstreamEl.textContent = formatKw(w);
      if (downstreamUnitEl) downstreamUnitEl.textContent = "kW";
    }
  }

  // Solar stat — always read from panel-level PV power entity
  const solarEl = scope.querySelector(".stat-solar .stat-value");
  const solarUnitEl = scope.querySelector(".stat-solar .stat-unit");
  if (solarEl) {
    const solarEid = topology.panel_entities?.pv_power;
    const solarState = solarEid ? hass.states[solarEid] : null;
    if (isAmpsMode) {
      const amps = solarState ? parseFloat(solarState.attributes?.amperage as string) : NaN;
      solarEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : "--";
      if (solarUnitEl) solarUnitEl.textContent = "A";
    } else {
      if (solarState) {
        const w = Math.abs(parseFloat(solarState.state) || 0);
        solarEl.textContent = formatKw(w);
      } else {
        solarEl.textContent = "--";
      }
      if (solarUnitEl) solarUnitEl.textContent = "kW";
    }
  }

  // Battery SoC (always %)
  const batteryEl = scope.querySelector(".stat-battery .stat-value");
  if (batteryEl) {
    const battEid = topology.panel_entities?.battery_level;
    const battState = battEid ? hass.states[battEid] : null;
    if (battState) batteryEl.textContent = `${Math.round(parseFloat(battState.state) || 0)}`;
  }

  // Grid / DSM state
  const gridStateEl = scope.querySelector(".stat-grid-state .stat-value");
  if (gridStateEl) {
    const gridEid = topology.panel_entities?.dsm_state;
    const gridState = gridEid ? hass.states[gridEid] : null;
    gridStateEl.textContent = gridState ? hass.formatEntityState?.(gridState) || gridState.state : "--";
  }
}

function _updateHeaderStats(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology, config: CardConfig, totalConsumption: number): void {
  const scope = (root as ParentNode).querySelector(".panel-stats") as Element | null;
  if (!scope) return;
  updatePanelStatsBlock(scope, hass, topology, config, totalConsumption);
}

// ── Exported updaters ──────────────────────────────────────────────────────

export function updateCircuitDOM(
  root: Element | ShadowRoot,
  hass: HomeAssistant,
  topology: PanelTopology,
  config: CardConfig,
  powerHistory: HistoryMap,
  horizonMap: Map<string, string> | undefined
): void {
  if (!root || !topology || !hass) return;

  const defaultDurationMs = getHistoryDurationMs(config);
  let totalConsumption = 0;

  for (const [, circuit] of Object.entries(topology.circuits)) {
    const entityId = circuit.entities?.power;
    if (!entityId) continue;
    const state = hass.states[entityId];
    const power = state ? parseFloat(state.state) || 0 : 0;
    if (circuit.device_type !== DEVICE_TYPE_PV) {
      totalConsumption += Math.abs(power);
    }
  }

  _updateHeaderStats(root, hass, topology, config, totalConsumption);

  const chartMetric: ChartMetricDef = getChartMetric(config);
  const showCurrent = chartMetric.entityRole === "current";

  for (const [uuid, circuit] of Object.entries(topology.circuits)) {
    const slot = root.querySelector(`.circuit-slot[data-uuid="${attrSelectorValue(uuid)}"]`);
    if (!slot) continue;

    const entityId = circuit.entities?.power;
    const state = entityId ? hass.states[entityId] : null;
    const powerW = state ? parseFloat(state.state) || 0 : 0;
    const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

    const isOn = relayClosed(circuit, hass);

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

    applyTogglePill(slot, isOn, switchPresence(circuit, hass));

    slot.classList.toggle("circuit-off", !isOn);
    slot.classList.toggle("circuit-producer", isProducer);

    applySheddingIcon(slot, shedPriorityKey(circuit, hass));

    const chartContainer = slot.querySelector(".chart-container") as HTMLElement | null;
    if (chartContainer) {
      const history = powerHistory.get(uuid) || [];
      const h = slot.classList.contains("circuit-col-span") ? CIRCUIT_COL_SPAN_CHART_HEIGHT : CIRCUIT_CHART_HEIGHT;
      const circuitDuration = horizonMap?.has(uuid) ? getHorizonDurationMs(horizonMap.get(uuid)!) : defaultDurationMs;
      const useLinear = circuit.device_type === DEVICE_TYPE_PV;
      updateChart(chartContainer, hass, history, circuitDuration, chartMetric, isProducer, h, circuit.breaker_rating_a ?? undefined, useLinear);
    }
  }
}

export function updateSubDeviceDOM(
  root: Element | ShadowRoot,
  hass: HomeAssistant,
  topology: PanelTopology,
  config: CardConfig,
  powerHistory: HistoryMap,
  subDeviceHorizonMap: Map<string, string> | undefined
): void {
  if (!topology.sub_devices) return;
  const defaultDurationMs = getHistoryDurationMs(config);

  for (const [devId, sub] of Object.entries(topology.sub_devices)) {
    const section = root.querySelector(`[data-subdev="${attrSelectorValue(devId)}"]`);
    if (!section) continue;

    const power = resolveSubDevicePower(sub);
    if (power.headlineEid) {
      const powerEl = section.querySelector(".sub-power-value");
      if (powerEl) powerEl.innerHTML = formatPowerHTML(stateWatts(hass, power.headlineEid));
    }
    if (power.siteTotalEid) {
      const totalEl = section.querySelector(".sub-site-total-value");
      if (totalEl) totalEl.innerHTML = formatPowerHTML(stateWatts(hass, power.siteTotalEid));
    }

    const chartContainers = section.querySelectorAll("[data-chart-key]");
    for (const cc of chartContainers) {
      const chartKey = (cc as HTMLElement).dataset.chartKey;
      if (!chartKey) continue;
      const history = powerHistory.get(chartKey) || [];
      let metric: ChartMetricDef = BESS_CHART_METRICS["power"]!;
      if (chartKey.endsWith("_soc")) metric = BESS_CHART_METRICS["soc"]!;
      else if (chartKey.endsWith("_soe")) metric = BESS_CHART_METRICS["soe"]!;
      const isBessCol = !!cc.closest(".bess-chart-col");
      const devDuration = subDeviceHorizonMap?.has(devId) ? getHorizonDurationMs(subDeviceHorizonMap.get(devId)!) : defaultDurationMs;
      const useLinear = chartKey.endsWith("_soc") || chartKey.endsWith("_soe");
      updateChart(cc as HTMLElement, hass, history, devDuration, metric, false, isBessCol ? BESS_CHART_COL_HEIGHT : EVSE_CHART_HEIGHT, undefined, useLinear);
    }

    for (const entityId of Object.keys(sub.entities || {})) {
      const valEl = section.querySelector(`[data-eid="${attrSelectorValue(entityId)}"]`);
      if (!valEl) continue;
      const state = hass.states[entityId];
      if (state) {
        let displayValue: string;
        if (hass.formatEntityState) {
          displayValue = hass.formatEntityState(state);
        } else {
          displayValue = state.state;
          const unit = (state.attributes.unit_of_measurement as string) || "";
          if (unit) displayValue += " " + unit;
        }
        const rawUnit = (state.attributes.unit_of_measurement as string) || "";
        if (rawUnit === "Wh") {
          const wh = parseFloat(state.state);
          if (!isNaN(wh)) displayValue = (wh / 1000).toFixed(1) + " kWh";
        }
        valEl.textContent = displayValue;
      }
    }
  }
}
