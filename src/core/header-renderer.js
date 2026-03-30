import { escapeHtml } from "../helpers/sanitize.js";

/**
 * Check whether a panel-level entity with the given suffix exists in hass.states.
 * Searches for entities starting with "sensor.span_panel_" and ending with "_<suffix>".
 * @param {object} hass - Home Assistant object
 * @param {string} suffix - Entity ID suffix to match
 * @returns {boolean}
 */
function _hasPanelEntity(hass, suffix) {
  if (!hass?.states) return false;
  for (const entityId of Object.keys(hass.states)) {
    if (entityId.startsWith("sensor.span_panel_") && entityId.endsWith(`_${suffix}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether any solar/PV panel-level entity exists in hass.states.
 * Looks for entities matching pv/solar power patterns.
 * @param {object} hass - Home Assistant object
 * @returns {boolean}
 */
function _hasSolarEntity(hass) {
  if (!hass?.states) return false;
  for (const entityId of Object.keys(hass.states)) {
    if (!entityId.startsWith("sensor.span_panel_")) continue;
    const local = entityId.slice("sensor.span_panel_".length);
    if ((local.includes("pv") && local.includes("power")) || local.includes("solar")) {
      return true;
    }
  }
  return false;
}

/**
 * Build the panel header HTML with stats, gear icon, and A/W toggle.
 * @param {object} topology - Panel topology from WebSocket
 * @param {object} config - Card/panel configuration
 * @param {object} hass - Home Assistant object used to conditionally show stats
 * @returns {string} HTML string
 */
export function buildHeaderHTML(topology, config, hass) {
  const panelName = escapeHtml(topology.device_name || "SPAN Panel");
  const serial = escapeHtml(topology.serial || "");
  const firmware = escapeHtml(topology.firmware || "");
  const isAmpsMode = (config.chart_metric || "power") === "current";

  const hasSite = _hasPanelEntity(hass, "current_power");
  const hasGrid = _hasPanelEntity(hass, "dsm_state");
  const hasUpstream = _hasPanelEntity(hass, "current_power");
  const hasDownstream = _hasPanelEntity(hass, "feedthrough_power");
  const hasSolar = _hasSolarEntity(hass);
  const hasBattery = _hasPanelEntity(hass, "battery_percentage");

  return `
    <div class="panel-header">
      <div class="header-left">
        <div class="panel-identity">
          <h1 class="panel-title">${panelName}</h1>
          <span class="panel-serial">${serial}</span>
          <button class="gear-icon panel-gear" title="Panel monitoring settings">
            <ha-icon icon="mdi:cog"></ha-icon>
          </button>
        </div>
        <div class="panel-stats">
          ${
            hasSite
              ? `
          <div class="stat stat-consumption">
            <span class="stat-label">Site</span>
            <div class="stat-row">
              <span class="stat-value">0</span>
              <span class="stat-unit">${isAmpsMode ? "A" : "kW"}</span>
            </div>
          </div>`
              : ""
          }
          ${
            hasGrid
              ? `
          <div class="stat stat-grid-state">
            <span class="stat-label">Grid</span>
            <div class="stat-row">
              <span class="stat-value">--</span>
            </div>
          </div>`
              : ""
          }
          ${
            hasUpstream
              ? `
          <div class="stat stat-upstream">
            <span class="stat-label">Upstream</span>
            <div class="stat-row">
              <span class="stat-value">--</span>
              <span class="stat-unit">${isAmpsMode ? "A" : "kW"}</span>
            </div>
          </div>`
              : ""
          }
          ${
            hasDownstream
              ? `
          <div class="stat stat-downstream">
            <span class="stat-label">Downstream</span>
            <div class="stat-row">
              <span class="stat-value">--</span>
              <span class="stat-unit">${isAmpsMode ? "A" : "kW"}</span>
            </div>
          </div>`
              : ""
          }
          ${
            hasSolar
              ? `
          <div class="stat stat-solar">
            <span class="stat-label">Solar</span>
            <div class="stat-row">
              <span class="stat-value">--</span>
              <span class="stat-unit">${isAmpsMode ? "A" : "kW"}</span>
            </div>
          </div>`
              : ""
          }
          ${
            hasBattery
              ? `
          <div class="stat stat-battery">
            <span class="stat-label">Battery</span>
            <div class="stat-row">
              <span class="stat-value">&mdash;</span>
              <span class="stat-unit">%</span>
            </div>
          </div>`
              : ""
          }
        </div>
      </div>
      <div class="header-right">
        <span class="meta-item">${firmware}</span>
        <div class="unit-toggle" title="Toggle Watts / Amps">
          <button class="unit-btn ${isAmpsMode ? "" : "unit-active"}" data-unit="power">W</button>
          <button class="unit-btn ${isAmpsMode ? "unit-active" : ""}" data-unit="current">A</button>
        </div>
      </div>
    </div>
  `;
}
