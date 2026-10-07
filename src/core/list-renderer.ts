import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { t } from "../i18n.js";
import { getChartMetric } from "../helpers/chart.js";
import { DEVICE_TYPE_PV } from "../constants.js";
import { getCircuitStateClasses, relayClosed, switchPresence } from "./circuit-state.js";
import { buildSheddingIconHTML, buildTogglePillHTML } from "./circuit-controls.js";
import type { Circuit, HomeAssistant, CardConfig, MonitoringPointInfo } from "../types.js";

/**
 * Build the search bar HTML for the list view.
 */
export function buildSearchBarHTML(currentQuery: string = ""): string {
  const valueAttr = currentQuery ? ` value="${escapeHtml(currentQuery)}"` : "";
  const clearDisplay = currentQuery ? "" : "display:none;";
  return `
    <div class="list-search-container">
      <input class="list-search" type="text" placeholder="${escapeHtml(t("list.search_placeholder"))}"${valueAttr} />
      <button class="list-search-clear" style="${clearDisplay}">
        <span-icon icon="mdi:close" style="--mdc-icon-size:18px;"></span-icon>
      </button>
    </div>
  `;
}

/**
 * Build the unit toggle (W / A) for the list view.
 */
export function buildUnitToggleHTML(config: CardConfig): string {
  const isAmpsMode = (config.chart_metric || "power") === "current";
  return `
    <div class="unit-toggle list-unit-toggle" title="${escapeHtml(t("header.toggle_units"))}">
      <button class="unit-btn ${isAmpsMode ? "" : "unit-active"}" data-unit="power">W</button>
      <button class="unit-btn ${isAmpsMode ? "unit-active" : ""}" data-unit="current">A</button>
    </div>
  `;
}

/**
 * Build a compact circuit row for the collapsed list view.
 */
export function buildListRowHTML(
  uuid: string,
  circuit: Circuit,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringInfo: MonitoringPointInfo | null,
  sheddingPriority: string,
  isExpanded: boolean
): string {
  const entityId = circuit.entities?.power;
  const state = entityId ? hass.states[entityId] : null;
  const powerW = state ? parseFloat(state.state) || 0 : 0;

  const isOn = relayClosed(circuit, hass);
  const presence = switchPresence(circuit, hass);

  const breakerAmps = circuit.breaker_rating_a;
  const breakerLabel = breakerAmps ? `${Math.round(breakerAmps)}A` : "";
  const name = escapeHtml(circuit.name || t("grid.unknown"));

  // Power / current value
  const chartMetric = getChartMetric(config);
  const showCurrent = chartMetric.entityRole === "current";
  let valueHTML: string;
  if (!isOn) {
    valueHTML = "";
  } else if (showCurrent) {
    const currentEid = circuit.entities?.current;
    const currentState = currentEid ? hass.states[currentEid] : null;
    const amps = currentState ? parseFloat(currentState.state) || 0 : 0;
    valueHTML = `<strong>${chartMetric.format(amps)}</strong><span class="power-unit">A</span>`;
  } else {
    valueHTML = `<strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>`;
  }

  const sheddingHTML = buildSheddingIconHTML(sheddingPriority || "unknown");

  // Utilization — prefer monitoring data, fall back to live current / breaker rating
  let utilizationHTML = "";
  let utilizationPct = monitoringInfo?.utilization_pct ?? null;
  if (utilizationPct == null && circuit.breaker_rating_a) {
    const curEid = circuit.entities?.current;
    const curState = curEid ? hass.states[curEid] : null;
    const amps = curState ? Math.abs(parseFloat(curState.state) || 0) : 0;
    utilizationPct = Math.round((amps / circuit.breaker_rating_a) * 1000) / 10;
  }
  if (utilizationPct != null) {
    const utilClass = utilizationPct >= 100 ? "utilization-alert" : utilizationPct >= 80 ? "utilization-warning" : "utilization-normal";
    utilizationHTML = `<span class="utilization ${utilClass}">${Math.round(utilizationPct)}%</span>`;
  }

  // Gear — matches the breaker-grid's gear so onGearClick handles it unchanged.
  const gearHTML = `<button class="gear-icon circuit-gear"
  data-uuid="${escapeHtml(uuid)}" style="color:#555;"
  title="${escapeHtml(t("grid.configure"))}">
  <span-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></span-icon>
</button>`;

  // A switch -- operable, or dimmed and inert while unavailable -- gets the pill,
  // armed by the header's slide-confirm; a circuit with none keeps a static badge.
  const statusControl =
    presence === "none"
      ? `<span class="list-status-badge ${isOn ? "list-status-on" : "list-status-off"}">${isOn ? "ON" : "OFF"}</span>`
      : buildTogglePillHTML(isOn, presence);

  return `
    <div class="list-row ${isOn ? "" : "circuit-off"} ${isExpanded ? "list-row-expanded" : ""}"
         data-row-uuid="${escapeHtml(uuid)}" data-uuid="${escapeHtml(uuid)}">
      ${breakerLabel ? `<span class="breaker-badge">${breakerLabel}</span>` : ""}
      ${utilizationHTML}
      <span class="list-circuit-name">${name}</span>
      ${sheddingHTML}
      ${statusControl}
      <span class="list-power-value">
        ${valueHTML}
      </span>
      ${gearHTML}
      <button class="list-expand-toggle ${isExpanded ? "expanded" : ""}" data-expand-uuid="${escapeHtml(uuid)}">
        <span-icon icon="mdi:chevron-down" style="--mdc-icon-size:18px;"></span-icon>
      </button>
    </div>
  `;
}

/**
 * Build the chart-only expanded content for a list row. The collapsed
 * list row already shows breaker / utilization / name / shedding / status /
 * power, so the expanded area only needs to surface the chart. State-
 * visualization classes (off, producer, alert, custom monitoring) still
 * apply to the wrapping slot so border/background signaling is preserved.
 */
export function buildExpandedChartHTML(
  uuid: string,
  circuit: Circuit,
  hass: HomeAssistant,
  _config: CardConfig,
  monitoringInfo: MonitoringPointInfo | null
): string {
  const powerEid = circuit.entities?.power;
  const powerState = powerEid ? hass.states[powerEid] : null;
  const powerW = powerState ? parseFloat(powerState.state) || 0 : 0;
  const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

  const isOn = relayClosed(circuit, hass);

  const stateClasses = getCircuitStateClasses(circuit, monitoringInfo, isOn, isProducer);
  const safeUuid = escapeHtml(uuid);

  return `
    <div class="list-expanded-content" data-expanded-uuid="${safeUuid}">
      <div class="circuit-slot circuit-chart-only ${stateClasses}" data-uuid="${safeUuid}">
        <div class="chart-container"></div>
      </div>
    </div>
  `;
}

/**
 * Build an area group header for the "By Area" list view. The inline
 * ``grid-column: 1 / -1`` is harmless when the list view is in
 * single-column (flex) mode and causes the header to span all columns
 * when grid mode is active.
 */
export function buildAreaHeaderHTML(areaName: string): string {
  return `<div class="area-header" data-area="${escapeHtml(areaName)}" style="grid-column:1 / -1;">${escapeHtml(areaName)}</div>`;
}
