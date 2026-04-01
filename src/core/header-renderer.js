import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import { SHEDDING_PRIORITIES } from "../constants.js";

/**
 * Build the panel header HTML with stats, gear icon, and A/W toggle.
 * @param {object} topology - Panel topology from WebSocket
 * @param {object} config - Card/panel configuration
 * @returns {string} HTML string
 */
export function buildHeaderHTML(topology, config) {
  const panelName = escapeHtml(topology.device_name || t("header.default_name"));
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
          <button class="gear-icon panel-gear" title="${t("header.monitoring_settings")}">
            <ha-icon icon="mdi:cog"></ha-icon>
          </button>
        </div>
        <div class="panel-stats">
          ${
            hasSite
              ? `
          <div class="stat stat-consumption">
            <span class="stat-label">${t("header.site")}</span>
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
            <span class="stat-label">${t("header.grid")}</span>
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
            <span class="stat-label">${t("header.upstream")}</span>
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
            <span class="stat-label">${t("header.downstream")}</span>
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
            <span class="stat-label">${t("header.solar")}</span>
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
            <span class="stat-label">${t("header.battery")}</span>
            <div class="stat-row">
              <span class="stat-value">&mdash;</span>
              <span class="stat-unit">%</span>
            </div>
          </div>`
              : ""
          }
        </div>
      </div>
      <div class="header-center">
        <div class="slide-confirm" data-text-off="${t("header.enable_switches")}" data-text-on="${t("header.switches_enabled")}">
          <span class="slide-confirm-text">${t("header.enable_switches")}</span>
          <div class="slide-confirm-knob">
            <ha-icon icon="mdi:lock"></ha-icon>
          </div>
        </div>
      </div>
      <div class="header-right">
        <div class="header-right-top">
          <span class="meta-item">${firmware}</span>
          <div class="unit-toggle" title="${t("header.toggle_units")}">
            <button class="unit-btn ${isAmpsMode ? "" : "unit-active"}" data-unit="power">W</button>
            <button class="unit-btn ${isAmpsMode ? "unit-active" : ""}" data-unit="current">A</button>
          </div>
        </div>
        <div class="shedding-legend">
          ${Object.entries(SHEDDING_PRIORITIES)
            .filter(([key]) => key !== "unknown")
            .map(([, cfg]) => {
              let icons;
              if (cfg.icon2) {
                icons = `<ha-icon icon="${cfg.icon}" style="color:${cfg.color}"></ha-icon><ha-icon class="shedding-legend-secondary" icon="${cfg.icon2}" style="color:${cfg.color}"></ha-icon>`;
              } else if (cfg.textLabel) {
                icons = `<ha-icon icon="${cfg.icon}" style="color:${cfg.color}"></ha-icon><span class="shedding-legend-text" style="color:${cfg.color}">${cfg.textLabel}</span>`;
              } else {
                icons = `<ha-icon icon="${cfg.icon}" style="color:${cfg.color}"></ha-icon>`;
              }
              return `<div class="shedding-legend-item">${icons}<span class="shedding-legend-label">${cfg.label()}</span></div>`;
            })
            .join("")}
        </div>
      </div>
    </div>
  `;
}
