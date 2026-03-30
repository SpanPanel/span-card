import { escapeHtml } from "../helpers/sanitize.js";

/**
 * Build the panel header HTML with stats, gear icon, and A/W toggle.
 * @param {object} topology - Panel topology from WebSocket
 * @param {object} config - Card/panel configuration
 * @returns {string} HTML string
 */
export function buildHeaderHTML(topology, config) {
  const panelName = escapeHtml(topology.device_name || "SPAN Panel");
  const serial = escapeHtml(topology.serial || "");
  const firmware = escapeHtml(topology.firmware || "");
  const isAmpsMode = (config.chart_metric || "power") === "current";

  const hasSite = !!topology.panel_entities?.site_power;
  const hasGrid = !!topology.panel_entities?.dsm_state;
  const hasUpstream = !!topology.panel_entities?.current_power;
  const hasDownstream = !!topology.panel_entities?.feedthrough_power;
  const hasSolar = !!topology.panel_entities?.pv_power;
  const hasBattery = !!topology.panel_entities?.battery_level;

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
