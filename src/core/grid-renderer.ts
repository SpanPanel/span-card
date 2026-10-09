import { escapeHtml } from "../helpers/sanitize.js";
import { formatCircuitCurrentHTML, formatCircuitPowerHTML } from "../helpers/format.js";
import { t } from "../i18n.js";
import { tabToRow, tabToCol, classifyDualTab, type PositionRange } from "../helpers/layout.js";
import { getChartMetric } from "../helpers/chart.js";
import { getCircuitMonitoringInfo } from "./monitoring-status.js";
import {
  circuitCurrentA,
  circuitPowerW,
  circuitUtilizationPct,
  getCircuitStateClasses,
  measuresOutsidePanel,
  readsAsProducer,
  relayClosed,
  shedPriorityKey,
  switchPresence,
} from "./circuit-state.js";
import { buildSheddingIconHTML, buildTogglePillHTML } from "./circuit-controls.js";
import type { PanelTopology, Circuit, HomeAssistant, CardConfig, MonitoringStatus, MonitoringPointInfo } from "../types.js";

type SlotLayout = "single" | "row-span" | "col-span";

interface TabMapEntry {
  uuid: string;
  circuit: Circuit;
  layout: SlotLayout;
}

/**
 * Build the full grid HTML for the panel breaker grid: one row per two positions
 * across `positions`, labelled with the positions' own numbers.
 */
export function buildGridHTML(
  topology: PanelTopology,
  positions: PositionRange,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringStatus: MonitoringStatus | null
): string {
  const tabMap = new Map<number, TabMapEntry>();
  const occupiedTabs = new Set<number>();

  for (const [uuid, circuit] of Object.entries(topology.circuits)) {
    // A meter outside the panel is drawn in the Meters strip, never in a breaker space.
    if (measuresOutsidePanel(circuit)) continue;
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

  // A row the range starts or ends inside draws only its in-range side.
  const inRange = (tab: number): boolean => tab >= positions.first && tab <= positions.last;
  const firstRow = tabToRow(positions.first);
  const lastRow = tabToRow(positions.last);

  let gridHTML = "";
  for (let row = firstRow; row <= lastRow; row++) {
    const gridRow = row - firstRow + 1;
    const leftTab = row * 2 - 1;
    const rightTab = row * 2;
    const leftEntry = tabMap.get(leftTab);
    const rightEntry = tabMap.get(rightTab);
    const leftLabel = inRange(leftTab) ? `<div class="tab-label tab-left" style="grid-row: ${gridRow}; grid-column: 1;">${leftTab}</div>` : "";
    const rightLabel = inRange(rightTab) ? `<div class="tab-label tab-right" style="grid-row: ${gridRow}; grid-column: 5;">${rightTab}</div>` : "";

    gridHTML += leftLabel;

    if (leftEntry && leftEntry.layout === "row-span") {
      const { monInfo, sheddingPriority } = lookupMonitoring(leftEntry);
      gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, gridRow, "2 / 5", "row-span", hass, config, monInfo, sheddingPriority);
      gridHTML += rightLabel;
      continue;
    }

    if (!rowsToSkipLeft.has(row)) {
      if (leftEntry && (leftEntry.layout === "col-span" || leftEntry.layout === "single")) {
        const { monInfo, sheddingPriority } = lookupMonitoring(leftEntry);
        gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, gridRow, "2", leftEntry.layout, hass, config, monInfo, sheddingPriority);
      } else if (!occupiedTabs.has(leftTab) && inRange(leftTab)) {
        gridHTML += renderEmptySlot(gridRow, "2");
      }
    }

    if (!rowsToSkipRight.has(row)) {
      if (rightEntry && (rightEntry.layout === "col-span" || rightEntry.layout === "single")) {
        const { monInfo, sheddingPriority } = lookupMonitoring(rightEntry);
        gridHTML += renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, gridRow, "4", rightEntry.layout, hass, config, monInfo, sheddingPriority);
      } else if (!occupiedTabs.has(rightTab) && inRange(rightTab)) {
        gridHTML += renderEmptySlot(gridRow, "4");
      }
    }

    gridHTML += rightLabel;
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
  const powerW = circuitPowerW(circuit, hass);
  const isProducer = readsAsProducer(circuit, powerW);

  const isOn = relayClosed(circuit, hass);
  const presence = switchPresence(circuit, hass);

  const breakerAmps = circuit.breaker_rating_a;
  const breakerLabel = breakerAmps ? `${Math.round(breakerAmps)}A` : "";
  const name = escapeHtml(circuit.name || t("grid.unknown"));

  const showCurrent = getChartMetric(config).entityRole === "current";
  const valueHTML = showCurrent ? formatCircuitCurrentHTML(circuitCurrentA(circuit, hass)) : formatCircuitPowerHTML(powerW);

  const sheddingHTML = buildSheddingIconHTML(sheddingPriority || "unknown");

  // Gear icon
  const gearHTML = `<button class="gear-icon circuit-gear"
    data-uuid="${escapeHtml(uuid)}" style="color:#555;"
    title="${escapeHtml(t("grid.configure"))}">
    <span-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></span-icon>
  </button>`;

  // Utilization — prefer monitoring data, fall back to live current / breaker rating
  let utilizationHTML = "";
  const utilizationPct = circuitUtilizationPct(circuit, hass, monitoringInfo);
  if (utilizationPct !== null) {
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
