import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import { SHEDDING_PRIORITIES } from "../constants.js";
import type { PanelTopology, CardConfig, SheddingPriorityDef } from "../types.js";

export interface HeaderRenderOptions {
  /**
   * Include the slide-to-enable switches control. All tabs that expose
   * toggleable circuit controls (the By Panel breaker grid and the By
   * Activity / By Area list views with their tappable ON/OFF badges)
   * should render this control so taps require explicit user arming.
   * Set false only if the view has no toggleable circuit controls.
   */
  showSwitches?: boolean;
}

/**
 * Build the shedding-legend HTML block. One `.shedding-legend-item` per
 * non-"unknown" entry in `SHEDDING_PRIORITIES`. Consumed by
 * `buildHeaderHTML` (real-panel header) and by the Favorites summary
 * strip in `src/panel/span-panel.ts`. Kept as a string-returning helper
 * so both call sites consume the same DOM shape from one source.
 */
export function buildSheddingLegendHTML(): string {
  return `<div class="shedding-legend">
    ${Object.entries(SHEDDING_PRIORITIES)
      .filter(([key]: [string, SheddingPriorityDef]) => key !== "unknown")
      .map(([, cfg]: [string, SheddingPriorityDef]) => {
        const icon = escapeHtml(cfg.icon);
        const color = escapeHtml(cfg.color);
        const label = escapeHtml(cfg.label());
        let icons: string;
        if (cfg.icon2) {
          const icon2 = escapeHtml(cfg.icon2);
          icons = `<span-icon icon="${icon}" style="color:${color}"></span-icon><span-icon class="shedding-legend-secondary" icon="${icon2}" style="color:${color}"></span-icon>`;
        } else if (cfg.textLabel) {
          const textLabel = escapeHtml(cfg.textLabel);
          icons = `<span-icon icon="${icon}" style="color:${color}"></span-icon><span class="shedding-legend-text" style="color:${color}">${textLabel}</span>`;
        } else {
          icons = `<span-icon icon="${icon}" style="color:${color}"></span-icon>`;
        }
        return `<div class="shedding-legend-item">${icons}<span class="shedding-legend-label">${label}</span></div>`;
      })
      .join("")}
  </div>`;
}

/**
 * Build just the panel-stats block (Site / Grid / Upstream / Downstream /
 * Solar / Battery) for one panel. Extracted so the Favorites view can
 * render a per-panel grid of stats. The returned block is a standalone
 * ``.panel-stats`` container with a ``data-stats-panel-id`` attribute so
 * per-panel updates can address it individually.
 */
export function buildPanelStatsHTML(topology: PanelTopology, config: CardConfig, panelDeviceId?: string): string {
  const isAmpsMode: boolean = (config.chart_metric || "power") === "current";
  const hasSite: boolean = !!topology.panel_entities?.site_power;
  const hasGrid: boolean = !!topology.panel_entities?.dsm_state;
  const hasUpstream: boolean = !!topology.panel_entities?.current_power;
  const hasDownstream: boolean = !!topology.panel_entities?.feedthrough_power;
  const hasSolar: boolean = !!topology.panel_entities?.pv_power;
  const hasBattery: boolean = !!topology.panel_entities?.battery_level;

  const idAttr = panelDeviceId ? ` data-stats-panel-id="${escapeHtml(panelDeviceId)}"` : "";

  return `
    <div class="panel-stats"${idAttr}>
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
  `;
}

/**
 * Build the panel header HTML with stats, gear icon, and A/W toggle.
 */
export function buildHeaderHTML(topology: PanelTopology, config: CardConfig, options: HeaderRenderOptions = {}): string {
  const panelName: string = escapeHtml(topology.device_name || t("header.default_name"));
  const serial: string = escapeHtml(topology.serial || "");
  const firmware: string = escapeHtml(topology.firmware || "");
  const isAmpsMode: boolean = (config.chart_metric || "power") === "current";
  const showSwitches = options.showSwitches !== false;

  return `
    <div class="panel-header">
      <div class="header-left">
        <div class="panel-identity">
          <h1 class="panel-title">${panelName}</h1>
          <span class="panel-serial">${serial}</span>
          <button class="gear-icon panel-gear" title="${escapeHtml(t("header.graph_settings"))}">
            <span-icon icon="mdi:cog"></span-icon>
          </button>
          ${
            showSwitches
              ? `<div class="slide-confirm" data-text-off="${escapeHtml(t("header.enable_switches"))}" data-text-on="${escapeHtml(t("header.switches_enabled"))}">
            <span class="slide-confirm-text">${escapeHtml(t("header.enable_switches"))}</span>
            <div class="slide-confirm-knob">
              <span-icon icon="mdi:lock"></span-icon>
            </div>
          </div>`
              : ""
          }
        </div>
        ${buildPanelStatsHTML(topology, config)}
      </div>
      <div class="header-right">
        <div class="header-right-top">
          <span class="meta-item">${firmware}</span>
          <div class="unit-toggle" title="${escapeHtml(t("header.toggle_units"))}">
            <button class="unit-btn ${isAmpsMode ? "" : "unit-active"}" data-unit="power">W</button>
            <button class="unit-btn ${isAmpsMode ? "unit-active" : ""}" data-unit="current">A</button>
          </div>
        </div>
        ${buildSheddingLegendHTML()}
      </div>
    </div>
  `;
}
