import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { tabToRow, tabToCol, classifyDualTab } from "../helpers/layout.js";
import { getChartMetric } from "../helpers/chart.js";
import { DEVICE_TYPE_PV, RELAY_STATE_CLOSED, SHEDDING_PRIORITIES, MONITORING_COLORS } from "../constants.js";
import { getCircuitMonitoringInfo, hasCustomOverrides, getUtilizationClass, isAlertActive } from "./monitoring-status.js";

/**
 * Build the full grid HTML for the panel breaker grid.
 *
 * @param {object} topology - The panel topology object.
 * @param {number} totalRows - Total number of breaker rows.
 * @param {number} durationMs - History duration in milliseconds.
 * @param {object} hass - Home Assistant object.
 * @param {object} config - Card configuration object.
 * @returns {string} HTML string for the grid.
 */
export function buildGridHTML(topology, totalRows, durationMs, hass, config, monitoringStatus) {
  const tabMap = new Map();
  const occupiedTabs = new Set();

  for (const [uuid, circuit] of Object.entries(topology.circuits)) {
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

  function lookupMonitoring(entry) {
    const circuitEntityId = entry.circuit.entities?.current || entry.circuit.entities?.power;
    const monInfo = monitoringStatus ? getCircuitMonitoringInfo(monitoringStatus, circuitEntityId) : null;
    const selectEid = entry.circuit.entities?.select;
    const sheddingPriority = selectEid && hass.states[selectEid] ? hass.states[selectEid].state : "unknown";
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
      gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2 / 4", "row-span", durationMs, hass, config, monInfo, sheddingPriority);
      gridHTML += `<div class="tab-label tab-right" style="grid-row: ${row}; grid-column: 4;">${rightTab}</div>`;
      continue;
    }

    if (!rowsToSkipLeft.has(row)) {
      if (leftEntry && (leftEntry.layout === "col-span" || leftEntry.layout === "single")) {
        const { monInfo, sheddingPriority } = lookupMonitoring(leftEntry);
        gridHTML += renderCircuitSlot(leftEntry.uuid, leftEntry.circuit, row, "2", leftEntry.layout, durationMs, hass, config, monInfo, sheddingPriority);
      } else if (!occupiedTabs.has(leftTab)) {
        gridHTML += renderEmptySlot(row, "2");
      }
    }

    if (!rowsToSkipRight.has(row)) {
      if (rightEntry && (rightEntry.layout === "col-span" || rightEntry.layout === "single")) {
        const { monInfo, sheddingPriority } = lookupMonitoring(rightEntry);
        gridHTML += renderCircuitSlot(rightEntry.uuid, rightEntry.circuit, row, "3", rightEntry.layout, durationMs, hass, config, monInfo, sheddingPriority);
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
 *
 * @param {string} uuid - Circuit UUID.
 * @param {object} circuit - Circuit data object.
 * @param {number} row - Grid row number.
 * @param {string} col - Grid column value (CSS grid-column).
 * @param {string} layout - Layout type: "single", "row-span", or "col-span".
 * @param {number} _durationMs - History duration in milliseconds (reserved for future use).
 * @param {object} hass - Home Assistant object.
 * @param {object} config - Card configuration object.
 * @returns {string} HTML string for the circuit slot.
 */
export function renderCircuitSlot(uuid, circuit, row, col, layout, _durationMs, hass, config, monitoringInfo, sheddingPriority) {
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

  const chartMetric = getChartMetric(config);
  const showCurrent = chartMetric.entityRole === "current";
  let valueHTML;
  if (showCurrent) {
    const currentEid = circuit.entities?.current;
    const currentState = currentEid ? hass.states[currentEid] : null;
    const amps = currentState ? parseFloat(currentState.state) || 0 : 0;
    valueHTML = `<strong>${chartMetric.format(amps)}</strong><span class="power-unit">A</span>`;
  } else {
    valueHTML = `<strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>`;
  }

  // Shedding icon
  const priority = sheddingPriority || "unknown";
  const shedInfo = SHEDDING_PRIORITIES[priority] || SHEDDING_PRIORITIES.unknown;
  const sheddingHTML = `<ha-icon class="shedding-icon"
    icon="${shedInfo.icon}"
    style="color:${shedInfo.color};--mdc-icon-size:16px;"
    title="${shedInfo.label}"></ha-icon>`;

  // Gear icon
  const hasOverridesFlag = monitoringInfo && hasCustomOverrides(monitoringInfo);
  const gearColor = hasOverridesFlag ? MONITORING_COLORS.custom : "#555";
  const gearHTML = `<button class="gear-icon circuit-gear"
    data-uuid="${escapeHtml(uuid)}" style="color:${gearColor};"
    title="Configure circuit">
    <ha-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></ha-icon>
  </button>`;

  // Utilization (shown when monitoring is active)
  let utilizationHTML = "";
  if (monitoringInfo?.utilization_pct != null) {
    const pct = monitoringInfo.utilization_pct;
    const utilClass = getUtilizationClass(monitoringInfo);
    utilizationHTML = `<span class="utilization ${utilClass}">${Math.round(pct)}%</span>`;
  }

  // Alert and custom monitoring classes
  const alertActive = isAlertActive(monitoringInfo);
  const alertClass = alertActive ? "circuit-alert" : "";
  const customClass = hasOverridesFlag ? "circuit-custom-monitoring" : "";

  const rowSpan = layout === "col-span" ? `${row} / span 2` : `${row}`;
  const layoutClass = layout === "row-span" ? "circuit-row-span" : layout === "col-span" ? "circuit-col-span" : "";

  return `
    <div class="circuit-slot ${isOn ? "" : "circuit-off"} ${isProducer ? "circuit-producer" : ""} ${layoutClass} ${alertClass} ${customClass}"
         style="grid-row: ${rowSpan}; grid-column: ${col};"
         data-uuid="${escapeHtml(uuid)}">
      <div class="circuit-header">
        <div class="circuit-info">
          ${breakerLabel ? `<span class="breaker-badge">${breakerLabel}</span>` : ""}
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
              <span class="toggle-label">${isOn ? "On" : "Off"}</span>
              <span class="toggle-knob"></span>
            </div>
          `
              : ""
          }
        </div>
      </div>
      <div class="circuit-status">
        ${sheddingHTML}
        ${utilizationHTML}
        ${gearHTML}
      </div>
      <div class="chart-container"></div>
    </div>
  `;
}

/**
 * Render an empty breaker slot.
 *
 * @param {number} row - Grid row number.
 * @param {string} col - Grid column value (CSS grid-column).
 * @returns {string} HTML string for the empty slot.
 */
export function renderEmptySlot(row, col) {
  return `
    <div class="circuit-slot circuit-empty" style="grid-row: ${row}; grid-column: ${col};">
      <span class="empty-label">&mdash;</span>
    </div>
  `;
}
