import {
  BESS_CHART_METRICS,
  DEVICE_TYPE_PV,
  CIRCUIT_CHART_HEIGHT,
  CIRCUIT_COL_SPAN_CHART_HEIGHT,
  BESS_CHART_COL_HEIGHT,
  EVSE_CHART_HEIGHT,
} from "../constants.js";
import { formatCircuitCurrentHTML, formatCircuitPowerHTML, formatPowerHTML, formatKw, UNKNOWN_READING } from "../helpers/format.js";
import { readNumber, sumReadings, type ReadingSum } from "../helpers/read-number.js";
import { getChartMetric } from "../helpers/chart.js";
import { resolveSubDevicePower, stateWatts } from "../helpers/sub-device-power.js";
import { getHistoryDurationMs, getHorizonDurationMs } from "../helpers/history.js";
import { updateChart } from "../chart/chart-update.js";
import { attrSelectorValue } from "../helpers/selector.js";
import { measuresOutsidePanel } from "../helpers/layout.js";
import { meterSlots } from "../helpers/shared-meters.js";
import { circuitCurrentA, circuitPowerW, drawsAsOn, readsAsProducer, shedPriorityKey, switchPresence } from "./circuit-state.js";
import { applySheddingIcon, applyTogglePill } from "./circuit-controls.js";
import type { HomeAssistant, PanelTopology, CardConfig, HistoryMap, ChartMetricDef } from "../types.js";

// ── Header stats ───────────────────────────────────────────────────────────

/** A header reading in kW, or the unknown mark. */
function formatKwReading(watts: number | null): string {
  return watts === null ? UNKNOWN_READING : formatKw(watts);
}

/**
 * Update a single ``.panel-stats`` block in-place from a specific
 * topology. Shared between the standard panel header (one block rooted
 * at the document) and the Favorites view (multiple per-panel blocks).
 *
 * ``siteConsumptionFallback`` is what the Site stat shows while the site
 * entity has no state object: the circuits' sum, or null for none.
 */
export function updatePanelStatsBlock(
  scope: Element,
  hass: HomeAssistant,
  topology: PanelTopology,
  config: CardConfig,
  siteConsumptionFallback: ReadingSum | null
): void {
  const isAmpsMode = (config.chart_metric || "power") === "current";

  // Site / consumption stat
  const consumptionEl = scope.querySelector(".stat-consumption .stat-value");
  const consumptionUnitEl = scope.querySelector(".stat-consumption .stat-unit");
  if (isAmpsMode) {
    const siteEid = topology.panel_entities?.site_power;
    const siteState = siteEid ? hass.states[siteEid] : null;
    const amps = siteState ? parseFloat(siteState.attributes?.amperage as string) : NaN;
    if (consumptionEl) {
      consumptionEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : UNKNOWN_READING;
      consumptionEl.classList.remove("stat-partial");
    }
    if (consumptionUnitEl) consumptionUnitEl.textContent = "A";
  } else {
    let site: ReadingSum | null = siteConsumptionFallback;
    const siteEid = topology.panel_entities?.site_power;
    const siteState = siteEid ? hass.states[siteEid] : undefined;
    if (siteState) site = { total: readNumber(siteState), partial: false };
    if (consumptionEl) {
      consumptionEl.textContent = formatKwReading(site?.total ?? null);
      consumptionEl.classList.toggle("stat-partial", site?.partial ?? false);
    }
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
      upstreamEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : UNKNOWN_READING;
      if (upstreamUnitEl) upstreamUnitEl.textContent = "A";
    } else {
      upstreamEl.textContent = formatKwReading(readNumber(upState));
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
      downstreamEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : UNKNOWN_READING;
      if (downstreamUnitEl) downstreamUnitEl.textContent = "A";
    } else {
      downstreamEl.textContent = formatKwReading(readNumber(downState));
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
      solarEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : UNKNOWN_READING;
      if (solarUnitEl) solarUnitEl.textContent = "A";
    } else {
      solarEl.textContent = formatKwReading(readNumber(solarState));
      if (solarUnitEl) solarUnitEl.textContent = "kW";
    }
  }

  // Battery SoC (always %)
  const batteryEl = scope.querySelector(".stat-battery .stat-value");
  if (batteryEl) {
    const battEid = topology.panel_entities?.battery_level;
    const soc = readNumber(battEid ? hass.states[battEid] : undefined);
    batteryEl.textContent = soc === null ? UNKNOWN_READING : `${Math.round(soc)}`;
  }

  // Grid / DSM state
  const gridStateEl = scope.querySelector(".stat-grid-state .stat-value");
  if (gridStateEl) {
    const gridEid = topology.panel_entities?.dsm_state;
    const gridState = gridEid ? hass.states[gridEid] : null;
    gridStateEl.textContent = gridState ? hass.formatEntityState?.(gridState) || gridState.state : UNKNOWN_READING;
  }
}

function _updateHeaderStats(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology, config: CardConfig, circuitsSum: ReadingSum): void {
  const scope = (root as ParentNode).querySelector(".panel-stats") as Element | null;
  if (!scope) return;
  updatePanelStatsBlock(scope, hass, topology, config, circuitsSum);
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

  // The circuits' consumption: every non-solar circuit with a power sensor, an unknown reading skipped.
  // A meter outside the panel is no load on it, so it is no term at all; circuits that share a meter are one term.
  const slots = meterSlots(topology.circuits);
  const consumption: (number | null)[] = [];
  for (const { circuit } of slots) {
    if (!circuit.entities?.power || circuit.device_type === DEVICE_TYPE_PV || measuresOutsidePanel(circuit)) continue;
    const power = circuitPowerW(circuit, hass);
    consumption.push(power === null ? null : Math.abs(power));
  }

  _updateHeaderStats(root, hass, topology, config, sumReadings(consumption));

  const chartMetric: ChartMetricDef = getChartMetric(config);
  const showCurrent = chartMetric.entityRole === "current";

  for (const { uuid, circuit } of slots) {
    const slot = root.querySelector(`.circuit-slot[data-uuid="${attrSelectorValue(uuid)}"]`);
    if (!slot) continue;

    const powerW = circuitPowerW(circuit, hass);
    const isProducer = readsAsProducer(circuit, powerW);

    // A meter outside the panel has no relay, so its list chart is never dimmed as off.
    const isOn = drawsAsOn(circuit, hass);

    const powerVal = slot.querySelector(".power-value");
    if (powerVal) {
      powerVal.innerHTML = showCurrent ? formatCircuitCurrentHTML(circuitCurrentA(circuit, hass)) : formatCircuitPowerHTML(powerW);
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
          const wh = readNumber(state);
          if (wh !== null) displayValue = (wh / 1000).toFixed(1) + " kWh";
        }
        valEl.textContent = displayValue;
      }
    }
  }
}
