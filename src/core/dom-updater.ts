import {
  BESS_CHART_METRICS,
  DEVICE_TYPE_PV,
  RELAY_STATE_CLOSED,
  SHEDDING_PRIORITIES,
  CIRCUIT_CHART_HEIGHT,
  CIRCUIT_COL_SPAN_CHART_HEIGHT,
  BESS_CHART_COL_HEIGHT,
  EVSE_CHART_HEIGHT,
} from "../constants.js";
import { formatPowerSigned, formatPowerUnit, formatKw } from "../helpers/format.js";
import { t } from "../i18n.js";
import { getChartMetric } from "../helpers/chart.js";
import { findSubDevicePowerEntity } from "../helpers/entity-finder.js";
import { getHistoryDurationMs, getHorizonDurationMs } from "../helpers/history.js";
import { updateChart } from "../chart/chart-update.js";
import type { HomeAssistant, PanelTopology, CardConfig, HistoryMap, ChartMetricDef } from "../types.js";

// ── Header stats ───────────────────────────────────────────────────────────

function _updateHeaderStats(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology, config: CardConfig, totalConsumption: number): void {
  const isAmpsMode = (config.chart_metric || "power") === "current";

  // Site / consumption stat
  const consumptionEl = root.querySelector(".stat-consumption .stat-value");
  const consumptionUnitEl = root.querySelector(".stat-consumption .stat-unit");
  if (isAmpsMode) {
    const siteEid = topology.panel_entities?.site_power;
    const siteState = siteEid ? hass.states[siteEid] : null;
    const amps = siteState ? parseFloat(siteState.attributes?.amperage as string) : NaN;
    if (consumptionEl) consumptionEl.textContent = Number.isFinite(amps) ? Math.abs(amps).toFixed(1) : "--";
    if (consumptionUnitEl) consumptionUnitEl.textContent = "A";
  } else {
    const siteEid = topology.panel_entities?.site_power;
    if (siteEid) {
      const state = hass.states[siteEid];
      if (state) totalConsumption = Math.abs(parseFloat(state.state) || 0);
    }
    if (consumptionEl) consumptionEl.textContent = formatKw(totalConsumption);
    if (consumptionUnitEl) consumptionUnitEl.textContent = "kW";
  }

  // Upstream stat
  const upstreamEl = root.querySelector(".stat-upstream .stat-value");
  const upstreamUnitEl = root.querySelector(".stat-upstream .stat-unit");
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
  const downstreamEl = root.querySelector(".stat-downstream .stat-value");
  const downstreamUnitEl = root.querySelector(".stat-downstream .stat-unit");
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
  const solarEl = root.querySelector(".stat-solar .stat-value");
  const solarUnitEl = root.querySelector(".stat-solar .stat-unit");
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
  const batteryEl = root.querySelector(".stat-battery .stat-value");
  if (batteryEl) {
    const battEid = topology.panel_entities?.battery_level;
    const battState = battEid ? hass.states[battEid] : null;
    if (battState) batteryEl.textContent = `${Math.round(parseFloat(battState.state) || 0)}`;
  }

  // Grid / DSM state
  const gridStateEl = root.querySelector(".stat-grid-state .stat-value");
  if (gridStateEl) {
    const gridEid = topology.panel_entities?.dsm_state;
    const gridState = gridEid ? hass.states[gridEid] : null;
    gridStateEl.textContent = gridState ? hass.formatEntityState?.(gridState) || gridState.state : "--";
  }
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
    const slot = root.querySelector(`[data-uuid="${uuid}"]`);
    if (!slot) continue;

    const entityId = circuit.entities?.power;
    const state = entityId ? hass.states[entityId] : null;
    const powerW = state ? parseFloat(state.state) || 0 : 0;
    const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

    const switchEntityId = circuit.entities?.switch;
    const switchState = switchEntityId ? hass.states[switchEntityId] : null;
    const isOn = switchState
      ? switchState.state === "on"
      : ((state?.attributes?.relay_state as string | undefined) || circuit.relay_state) === RELAY_STATE_CLOSED;

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

    const toggle = slot.querySelector(".toggle-pill") as HTMLElement | null;
    if (toggle) {
      toggle.className = `toggle-pill ${isOn ? "toggle-on" : "toggle-off"}`;
      const label = toggle.querySelector(".toggle-label");
      if (label) label.textContent = isOn ? t("grid.on") : t("grid.off");
    }

    slot.classList.toggle("circuit-off", !isOn);
    slot.classList.toggle("circuit-producer", isProducer);

    // Update shedding priority icon
    let priority: string;
    if (circuit.always_on) {
      priority = "always_on";
    } else {
      const selectEid = circuit.entities?.select;
      const selectState = selectEid ? hass.states[selectEid] : null;
      priority = selectState ? selectState.state : "unknown";
    }
    // "unknown" key always exists in SHEDDING_PRIORITIES, so the fallback is guaranteed
    const shedInfo = (SHEDDING_PRIORITIES[priority] ?? SHEDDING_PRIORITIES["unknown"])!;
    const sheddingIcon = slot.querySelector(".shedding-icon") as HTMLElement | null;
    if (sheddingIcon) {
      sheddingIcon.setAttribute("icon", shedInfo.icon);
      sheddingIcon.style.color = shedInfo.color;
      sheddingIcon.title = shedInfo.label();
    }
    // Update secondary icon if present
    const secondaryIcon = slot.querySelector(".shedding-icon-secondary") as HTMLElement | null;
    if (secondaryIcon) {
      if (shedInfo.icon2) {
        secondaryIcon.setAttribute("icon", shedInfo.icon2);
        secondaryIcon.style.color = shedInfo.color;
        secondaryIcon.style.display = "";
      } else {
        secondaryIcon.style.display = "none";
      }
    }
    // Update text label if present
    const sheddingLabel = slot.querySelector(".shedding-label") as HTMLElement | null;
    if (sheddingLabel) {
      if (shedInfo.textLabel) {
        sheddingLabel.textContent = shedInfo.textLabel;
        sheddingLabel.style.color = shedInfo.color;
        sheddingLabel.style.display = "";
      } else {
        sheddingLabel.style.display = "none";
      }
    }

    const chartContainer = slot.querySelector(".chart-container") as HTMLElement | null;
    if (chartContainer) {
      const history = powerHistory.get(uuid) || [];
      const h = slot.classList.contains("circuit-col-span") ? CIRCUIT_COL_SPAN_CHART_HEIGHT : CIRCUIT_CHART_HEIGHT;
      const circuitDuration = horizonMap?.has(uuid) ? getHorizonDurationMs(horizonMap.get(uuid)!) : defaultDurationMs;
      updateChart(chartContainer, hass, history, circuitDuration, chartMetric, isProducer, h, circuit.breaker_rating_a ?? undefined);
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
      const chartKey = (cc as HTMLElement).dataset.chartKey;
      if (!chartKey) continue;
      const history = powerHistory.get(chartKey) || [];
      let metric: ChartMetricDef = BESS_CHART_METRICS["power"]!;
      if (chartKey.endsWith("_soc")) metric = BESS_CHART_METRICS["soc"]!;
      else if (chartKey.endsWith("_soe")) metric = BESS_CHART_METRICS["soe"]!;
      const isBessCol = !!cc.closest(".bess-chart-col");
      const devDuration = subDeviceHorizonMap?.has(devId) ? getHorizonDurationMs(subDeviceHorizonMap.get(devId)!) : defaultDurationMs;
      updateChart(cc as HTMLElement, hass, history, devDuration, metric, false, isBessCol ? BESS_CHART_COL_HEIGHT : EVSE_CHART_HEIGHT);
    }

    for (const entityId of Object.keys(sub.entities || {})) {
      const valEl = section.querySelector(`[data-eid="${entityId}"]`);
      if (!valEl) continue;
      const state = hass.states[entityId];
      if (state) {
        const unit = state.attributes.unit_of_measurement as string | undefined;
        valEl.textContent = `${state.state}${unit ? " " + unit : ""}`;
      }
    }
  }
}
