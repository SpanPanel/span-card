import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { t } from "../i18n.js";
import { getChartMetric } from "../helpers/chart.js";
import { RELAY_STATE_CLOSED, SHEDDING_PRIORITIES } from "../constants.js";
import { getUtilizationClass } from "./monitoring-status.js";
import { renderCircuitSlot } from "./grid-renderer.js";
import type { Circuit, HomeAssistant, CardConfig, MonitoringPointInfo, SheddingPriorityDef } from "../types.js";

/**
 * Build the search bar HTML for the list view.
 */
export function buildSearchBarHTML(): string {
  return `
    <div class="list-search-container">
      <input class="list-search" type="text" placeholder="${escapeHtml(t("list.search_placeholder"))}" />
      <button class="list-search-clear" style="display:none;">
        <ha-icon icon="mdi:close" style="--mdc-icon-size:18px;"></ha-icon>
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

  const switchEntityId = circuit.entities?.switch;
  const switchState = switchEntityId ? hass.states[switchEntityId] : null;
  const isOn = switchState
    ? switchState.state === "on"
    : ((state?.attributes?.relay_state as string | undefined) || circuit.relay_state) === RELAY_STATE_CLOSED;

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

  // Shedding icon (supports composite: dual-icon or icon+text)
  // Hide for "unknown" priority (e.g. PV systems that have no shedding select entity)
  const priority = sheddingPriority || "unknown";
  let sheddingHTML = "";
  if (priority !== "unknown") {
    const shedInfo: SheddingPriorityDef = SHEDDING_PRIORITIES[priority] ??
      SHEDDING_PRIORITIES.unknown ?? { icon: "mdi:help", color: "#999", label: () => "Unknown" };
    if (shedInfo.icon2) {
      sheddingHTML = `<span class="shedding-composite" title="${shedInfo.label()}">
        <ha-icon class="shedding-icon" icon="${shedInfo.icon}" style="color:${shedInfo.color};--mdc-icon-size:16px;"></ha-icon>
        <ha-icon class="shedding-icon-secondary" icon="${shedInfo.icon2}" style="color:${shedInfo.color};--mdc-icon-size:14px;"></ha-icon>
      </span>`;
    } else if (shedInfo.textLabel) {
      sheddingHTML = `<span class="shedding-composite" title="${shedInfo.label()}">
        <ha-icon class="shedding-icon" icon="${shedInfo.icon}" style="color:${shedInfo.color};--mdc-icon-size:16px;"></ha-icon>
        <span class="shedding-label" style="color:${shedInfo.color}">${shedInfo.textLabel}</span>
      </span>`;
    } else {
      sheddingHTML = `<ha-icon class="shedding-icon" icon="${shedInfo.icon}"
        style="color:${shedInfo.color};--mdc-icon-size:16px;"
        title="${shedInfo.label()}"></ha-icon>`;
    }
  }

  // Utilization badge
  let utilizationHTML = "";
  if (monitoringInfo?.utilization_pct != null) {
    const pct = monitoringInfo.utilization_pct;
    const utilClass = getUtilizationClass(monitoringInfo);
    utilizationHTML = `<span class="utilization ${utilClass}">${Math.round(pct)}%</span>`;
  }

  // ON/OFF badge
  const statusBadge = isOn ? `<span class="list-status-badge list-status-on">ON</span>` : `<span class="list-status-badge list-status-off">OFF</span>`;

  return `
    <div class="list-row ${isOn ? "" : "circuit-off"} ${isExpanded ? "list-row-expanded" : ""}" data-row-uuid="${escapeHtml(uuid)}">
      ${breakerLabel ? `<span class="breaker-badge">${breakerLabel}</span>` : ""}
      <span class="list-circuit-name">${name}</span>
      ${sheddingHTML}
      ${utilizationHTML}
      ${statusBadge}
      <span class="list-power-value">
        ${valueHTML}
      </span>
      <button class="list-expand-toggle ${isExpanded ? "expanded" : ""}" data-expand-uuid="${escapeHtml(uuid)}">
        <ha-icon icon="mdi:chevron-down" style="--mdc-icon-size:18px;"></ha-icon>
      </button>
    </div>
  `;
}

/**
 * Build the expanded detail view for a circuit (wraps renderCircuitSlot).
 */
export function buildExpandedCircuitHTML(
  uuid: string,
  circuit: Circuit,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringInfo: MonitoringPointInfo | null,
  sheddingPriority: string
): string {
  const slotHTML = renderCircuitSlot(uuid, circuit, 0, "1", "single", hass, config, monitoringInfo, sheddingPriority, true);
  return `<div class="list-expanded-content" data-expanded-uuid="${escapeHtml(uuid)}">${slotHTML}</div>`;
}

/**
 * Build an area group header for the "By Area" list view.
 */
export function buildAreaHeaderHTML(areaName: string): string {
  return `<div class="area-header" data-area="${escapeHtml(areaName)}">${escapeHtml(areaName)}</div>`;
}
