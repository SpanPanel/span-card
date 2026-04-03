import { discoverTopology } from "../card/card-discovery.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { buildMonitoringSummaryHTML } from "../core/monitoring-status.js";
import { DashboardController } from "../core/dashboard-controller.js";
import { CARD_STYLES } from "../card/card-styles.js";
import "../core/side-panel.js";
import type { HomeAssistant, CardConfig } from "../types.js";

export class DashboardTab {
  private readonly _ctrl = new DashboardController();
  private _container: HTMLElement | null = null;
  private _onGearClick: ((ev: Event) => void) | null = null;
  private _onToggleClick: ((ev: Event) => void) | null = null;
  private _onSidePanelClosed: (() => void) | null = null;
  private _onGraphSettingsChanged: (() => void) | null = null;

  get hass(): HomeAssistant | null {
    return this._ctrl.hass;
  }

  set hass(val: HomeAssistant | null) {
    this._ctrl.hass = val;
  }

  async render(container: HTMLElement, hass: HomeAssistant, deviceId: string, config: CardConfig, configEntryId?: string | null): Promise<void> {
    this.stop();
    this._ctrl.reset();
    this._ctrl.showMonitoring = true;
    this._container = container;
    this._ctrl.hass = hass;

    let topology, panelSize;
    try {
      const result = await discoverTopology(hass, deviceId);
      topology = result.topology;
      panelSize = result.panelSize;
    } catch (err) {
      container.innerHTML = `<p style="color:var(--error-color);">${escapeHtml((err as Error).message)}</p>`;
      return;
    }

    this._ctrl.init(topology, config, hass, configEntryId ?? null);
    await this._ctrl.monitoringCache.fetch(hass, configEntryId ?? null);
    await this._ctrl.fetchAndBuildHorizonMaps();

    const totalRows = Math.ceil(panelSize / 2);
    const monitoringStatus = this._ctrl.monitoringCache.status;

    const headerHTML = buildHeaderHTML(topology!, config);
    const monitoringSummaryHTML = buildMonitoringSummaryHTML(monitoringStatus);
    const gridHTML = buildGridHTML(topology!, totalRows, hass, config, monitoringStatus);
    const subDevHTML = buildSubDevicesHTML(topology!, hass, config);

    container.innerHTML = `
      <style>${CARD_STYLES}</style>
      ${headerHTML}
      ${monitoringSummaryHTML}
      ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
      ${
        config.show_panel !== false
          ? `
        <div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">
          ${gridHTML}
        </div>
      `
          : ""
      }
      <span-side-panel></span-side-panel>
    `;

    this._onGearClick = (ev: Event) => {
      this._ctrl.onGearClick(ev, container);
    };
    this._onToggleClick = (ev: Event) => {
      this._ctrl.onToggleClick(ev, container);
    };
    container.addEventListener("click", this._onGearClick);
    container.addEventListener("click", this._onToggleClick);

    this._onSidePanelClosed = () => {
      this._ctrl.monitoringCache.invalidate();
      this._ctrl.graphSettingsCache.invalidate();
    };
    container.addEventListener("side-panel-closed", this._onSidePanelClosed);

    this._onGraphSettingsChanged = () => this._ctrl.onGraphSettingsChanged(container);
    container.addEventListener("graph-settings-changed", this._onGraphSettingsChanged);

    try {
      await this._ctrl.loadHistory();
    } catch {
      // Charts will populate live
    }

    this._ctrl.updateDOM(container);

    const slideEl = container.querySelector(".slide-confirm");
    if (slideEl) {
      this._ctrl.bindSlideConfirm(slideEl, container);
      container.classList.add("switches-disabled");
    }

    this._ctrl.setupResizeObserver(container, container);
    this._ctrl.startIntervals(container);
  }

  stop(): void {
    this._ctrl.stopIntervals();
    if (this._container) {
      if (this._onGearClick) {
        this._container.removeEventListener("click", this._onGearClick);
        this._onGearClick = null;
      }
      if (this._onToggleClick) {
        this._container.removeEventListener("click", this._onToggleClick);
        this._onToggleClick = null;
      }
      if (this._onSidePanelClosed) {
        this._container.removeEventListener("side-panel-closed", this._onSidePanelClosed);
        this._onSidePanelClosed = null;
      }
      if (this._onGraphSettingsChanged) {
        this._container.removeEventListener("graph-settings-changed", this._onGraphSettingsChanged);
        this._onGraphSettingsChanged = null;
      }
    }
  }
}
