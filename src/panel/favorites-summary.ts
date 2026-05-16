import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import { buildSheddingLegendHTML } from "../core/header-renderer.js";

/**
 * Build the Favorites view summary strip: gear icon, slide-to-arm,
 * shedding legend, and W/A unit toggle. Legend and W/A cluster in a
 * right-anchored `.favorites-summary-right` wrapper so the layout
 * mirrors the real-panel header.
 *
 * Pure string helper — no DOM, no element state. The panel component
 * invokes it from `_buildFavoritesSummaryHTML`, passing the current
 * amps-mode flag.
 */
export function buildFavoritesSummaryHTML(isAmpsMode: boolean): string {
  return `
    <div class="favorites-summary">
      <button class="gear-icon panel-gear favorites-gear" title="${escapeHtml(t("header.graph_settings"))}">
        <span-icon icon="mdi:cog"></span-icon>
      </button>
      <div class="slide-confirm" data-text-off="${escapeHtml(t("header.enable_switches"))}" data-text-on="${escapeHtml(t("header.switches_enabled"))}">
        <span class="slide-confirm-text">${escapeHtml(t("header.enable_switches"))}</span>
        <div class="slide-confirm-knob">
          <span-icon icon="mdi:lock"></span-icon>
        </div>
      </div>
      <div class="favorites-summary-right">
        ${buildSheddingLegendHTML()}
        <div class="unit-toggle favorites-summary-unit-toggle" title="${escapeHtml(t("header.toggle_units"))}">
          <button class="unit-btn ${isAmpsMode ? "" : "unit-active"}" data-unit="power">W</button>
          <button class="unit-btn ${isAmpsMode ? "unit-active" : ""}" data-unit="current">A</button>
        </div>
      </div>
    </div>
  `;
}
