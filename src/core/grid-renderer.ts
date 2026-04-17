import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { t } from "../i18n.js";
import { tabToRow, tabToCol, classifyDualTab } from "../helpers/layout.js";
import { getChartMetric } from "../helpers/chart.js";
import { DEVICE_TYPE_PV, RELAY_STATE_CLOSED, SHEDDING_PRIORITIES, MONITORING_COLORS } from "../constants.js";
import { getCircuitMonitoringInfo, hasCustomOverrides } from "./monitoring-status.js";
import { getCircuitStateClasses } from "./circuit-state.js";
import type { PanelTopology, Circuit, HomeAssistant, CardConfig, MonitoringStatus, MonitoringPointInfo, SheddingPriorityDef } from "../types.js";

type SlotLayout = "single" | "row-span" | "col-span";

interface TabMapEntry {
  uuid: string;
  circuit: Circuit;
  layout: SlotLayout;
}

/**
 * Build the full grid HTML for the panel breaker grid.
 */
export function buildGridHTML(
  topology: PanelTopology,
  totalRows: number,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringStatus: MonitoringStatus | null
): string {
  const tabMap = new Map<number, TabMapEntry>();
  const occupiedTabs = new Set<number>();

  for (const [uuid, circuit] of Object.entries(topology.circuits)) {
    const tabs = circuit.tabs;
    if (!tabs || tabs.length === 0) continue;
    const primaryTab = Math.min(...tabs);
    const layout: SlotLayout = tabs.length === 1 ? "single" : (classifyDualTab(tabs) ?? "single");
    tabMap.set(primaryTab, { uuid, circuit, layout });
    for (const tab of tabs) occupiedTabs.add(tab);
  }

  const rowsToSkipLeft = new Set<number>();
  const rowsToSkipRight = new Set<number>();

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

  function lookupMonitoring(entry: TabMapEntry): {
    monInfo: MonitoringPointInfo | null;
    sheddingPriority: string;
  } {
    const circuitEntityId = entry.circuit.entities?.current ?? entry.circuit.entities?.power;
    const monInfo = monitoringStatus ? getCircuitMonitoringInfo(monitoringStatus, circuitEntityId ?? "") : null;
    let sheddingPriority: string;
    if (entry.circuit.always_on) {
      sheddingPriority = "always_on";
    } else {
      const selectEid = entry.circuit.entities?.select;
      sheddingPriority = selectEid && hass.states[selectEid] ? hass.states[selectEid].state : "unknown";
    }
    return { monInfo, sheddingPriority };
  }

  let gridHTML = "";
  for (let row = 1; row <= totalRows; row++) {
    const leftTab = row * 2 - 1;
    const rightTab = row * 2;
    const leftEntry = tabMap.get(leftTab);
    const rightEntry = tabMap.get(rightTab);

    gridHTML += `<div class="tab-label tab-left" style="grid-row: ${row}; grid-column: 1;">${leftTab}</div>`;

    if (leftEntry && leftEntry.layout === "row-span") {
      const { monInfo, sheddingPriority } = lookupMonitoring(leftEntry);
      gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2 / 4", "row-span", hass, config, monInfo, sheddingPriority);
      gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 4;">${rightTab}</div>`;
      continue;
    }

    if (!rowsToSkipLeft.has(row)) {
      if (leftEntry && (leftEntry.layout === "col-span" || leftEntry.layout === "single")) {
        const { monInfo, sheddingPriority } = lookupMonitoring(leftEntry);
        gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2", leftEntry.layout, hass, config, monInfo, sheddingPriority);
      } else if (!occupiedTabs.has(leftTab)) {
        gridHTML += renderEmptySlot(row, "2");
      }
    }

    if (!rowsToSkipRight.has(row)) {
      if (rightEntry && (rightEntry.layout === "col-span" || rightEntry.layout === "single")) {
        const { monInfo, sheddingPriority } = lookupMonitoring(rightEntry);
        gridHTML += renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, row, "3", rightEntry.layout, hass, config, monInfo, sheddingPriority);
      } else if (!occupiedTabs.has(rightTab)) {
        gridHTML += renderEmptySlot(row, "3");
      }
    }

    gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 4;">${rightTab}</div>`;
  }
  return gridHTML;
}

/**
 * Render a single circuit breaker slot.
 */
export function renderCircuitSlot(
  uuid: string,
  circuit: Circuit,
  row: number,
  col: string,
  layout: SlotLayout,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringInfo: MonitoringPointInfo | null,
  sheddingPriority: string,
  inline = false
): string {
  const entityId = circuit.entities?.power;
  const state = entityId ? hass.states[entityId] : null;
  const powerW = state ? parseFloat(state.state) || 0 : 0;
  const isProducer = circuit.device_type === DEVICE_TYPE_PV || powerW < 0;

  const switchEntityId = circuit.entities?.switch;
  const switchState = switchEntityId ? hass.states[switchEntityId] : null;
  const isOn = switchState
    ? switchState.state === "on"
    : ((state?.attributes?.relay_state as string | undefined) || circuit.relay_state) === RELAY_STATE_CLOSED;

  const breakerAmps = circuit.breaker_rating_a;
  const breakerLabel = breakerAmps ? `${Math.round(breakerAmps)}A` : "";
  const name = escapeHtml(circuit.name || t("grid.unknown"));

  const chartMetric = getChartMetric(config);
  const showCurrent = chartMetric.entityRole === "current";
  let valueHTML: string;
  if (showCurrent) {
    const currentEid = circuit.entities?.current;
    const currentState = currentEid ? hass.states[currentEid] : null;
    const amps = currentState ? parseFloat(currentState.state) || 0 : 0;
    valueHTML = `<strong>${chartMetric.format(amps)}</strong><span class="power-unit">A</span>`;
  } else {
    valueHTML = `<strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>`;
  }

  // Shedding icon (supports composite: dual-icon or icon+text)
  // Hidden for "unknown" priority (e.g. PV systems with no shedding select entity)
  const priority = sheddingPriority || "unknown";
  let sheddingHTML = "";
  if (priority !== "unknown") {
    const shedInfo: SheddingPriorityDef = SHEDDING_PRIORITIES[priority] ??
      SHEDDING_PRIORITIES.unknown ?? { icon: "mdi:help", color: "#999", label: () => "Unknown" };
    // Escape every value that ends up inside an attribute. ``label()``
    // resolves through i18n so future translations may contain quotes,
    // and inline-style injection breaks on a stray ``"`` or ``;``.
    const safeLabel = escapeHtml(shedInfo.label());
    const safeIcon = escapeHtml(shedInfo.icon);
    const safeColor = escapeHtml(shedInfo.color);
    if (shedInfo.icon2) {
      const safeIcon2 = escapeHtml(shedInfo.icon2);
      sheddingHTML = `<span class="shedding-composite" title="${safeLabel}">
        <ha-icon class="shedding-icon" icon="${safeIcon}" style="color:${safeColor};--mdc-icon-size:16px;"></ha-icon>
        <ha-icon class="shedding-icon-secondary" icon="${safeIcon2}" style="color:${safeColor};--mdc-icon-size:14px;"></ha-icon>
      </span>`;
    } else if (shedInfo.textLabel) {
      const safeTextLabel = escapeHtml(shedInfo.textLabel);
      sheddingHTML = `<span class="shedding-composite" title="${safeLabel}">
        <ha-icon class="shedding-icon" icon="${safeIcon}" style="color:${safeColor};--mdc-icon-size:16px;"></ha-icon>
        <span class="shedding-label" style="color:${safeColor}">${safeTextLabel}</span>
      </span>`;
    } else {
      sheddingHTML = `<ha-icon class="shedding-icon" icon="${safeIcon}"
        style="color:${safeColor};--mdc-icon-size:16px;"
        title="${safeLabel}"></ha-icon>`;
    }
  }

  // Gear icon
  const hasOverridesFlag = monitoringInfo && hasCustomOverrides(monitoringInfo);
  const gearColor = hasOverridesFlag ? MONITORING_COLORS.custom : "#555";
  const gearHTML = `<button class="gear-icon circuit-gear"
    data-uuid="${escapeHtml(uuid)}" style="color:${gearColor};"
    title="${escapeHtml(t("grid.configure"))}">
    <ha-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></ha-icon>
  </button>`;

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

  const stateClasses = getCircuitStateClasses(circuit, monitoringInfo, isOn, isProducer);

  const rowSpan = layout === "col-span" ? `${row} / span 2` : `${row}`;
  const layoutClass = inline ? "" : layout === "row-span" ? "circuit-row-span" : layout === "col-span" ? "circuit-col-span" : "";
  const gridStyle = inline ? "" : `style="grid-row: ${rowSpan}; grid-column: ${col};"`;

  return `
    <div class="circuit-slot ${stateClasses} ${layoutClass}"
         ${gridStyle}
         data-uuid="${escapeHtml(uuid)}">
      <div class="circuit-header">
        <div class="circuit-info">
          ${breakerLabel ? `<span class="breaker-badge">${breakerLabel}</span>` : ""}
          ${utilizationHTML}
          <span class="circuit-name">${name}</span>
        </div>
        <div class="circuit-controls">
          <span class="power-value">
            ${valueHTML}
          </span>
          ${
            circuit.is_user_controllable !== false && circuit.entities?.switch
              ? `
            <div class="toggle-pill ${isOn ? "toggle-on" : "toggle-off"}">
              <span class="toggle-label">${isOn ? t("grid.on") : t("grid.off")}</span>
              <span class="toggle-knob"></span>
            </div>
          `
              : ""
          }
        </div>
      </div>
      <div class="circuit-status">
        ${sheddingHTML}
        ${gearHTML}
      </div>
      <div class="chart-container"></div>
    </div>
  `;
}

/**
 * Render an empty breaker slot.
 */
export function renderEmptySlot(row: number, col: string): string {
  return `
    <div class="circuit-slot circuit-empty" style="grid-row: ${row}; grid-column: ${col};">
      <span class="empty-label">&mdash;</span>
    </div>
  `;
}
