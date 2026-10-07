import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { t } from "../i18n.js";
import { tabToRow, tabToCol, classifyDualTab } from "../helpers/layout.js";
import { getChartMetric } from "../helpers/chart.js";
import { DEVICE_TYPE_PV } from "../constants.js";
import { getCircuitMonitoringInfo } from "./monitoring-status.js";
import { getCircuitStateClasses, relayClosed, shedPriorityKey, switchPresence } from "./circuit-state.js";
import { buildSheddingIconHTML, buildTogglePillHTML } from "./circuit-controls.js";
import type { PanelTopology, Circuit, HomeAssistant, CardConfig, MonitoringStatus, MonitoringPointInfo } from "../types.js";

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
    const sheddingPriority = shedPriorityKey(entry.circuit, hass);
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
      gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2 / 5", "row-span", hass, config, monInfo, sheddingPriority);
      gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 5;">${rightTab}</div>`;
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
        gridHTML += renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, row, "4", rightEntry.layout, hass, config, monInfo, sheddingPriority);
      } else if (!occupiedTabs.has(rightTab)) {
        gridHTML += renderEmptySlot(row, "4");
      }
    }

    gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 5;">${rightTab}</div>`;
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

  const isOn = relayClosed(circuit, hass);
  const presence = switchPresence(circuit, hass);

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

  const sheddingHTML = buildSheddingIconHTML(sheddingPriority || "unknown");

  // Gear icon
  const gearHTML = `<button class="gear-icon circuit-gear"
    data-uuid="${escapeHtml(uuid)}" style="color:#555;"
    title="${escapeHtml(t("grid.configure"))}">
    <span-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></span-icon>
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
          ${buildTogglePillHTML(isOn, presence)}
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
