import { DEFAULT_CHART_METRIC } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { buildMonitoringSummaryHTML } from "../core/monitoring-status.js";
import { DashboardController } from "../core/dashboard-controller.js";
import { discoverTopology, discoverEntitiesFallback } from "./card-discovery.js";
import { CARD_STYLES } from "./card-styles.js";
import "../core/side-panel.js";
import type { HomeAssistant, PanelTopology, PanelDevice, CardConfig } from "../types.js";

interface SpanSidePanelElement extends HTMLElement {
  hass: HomeAssistant;
}

export class SpanPanelCard extends HTMLElement {
  private _hass: HomeAssistant | null = null;
  private _config: CardConfig = {};
  private _discovered = false;
  private _discovering = false;
  private _discoveryError: string | null = null;

  private _topology: PanelTopology | null = null;
  private _panelDevice: PanelDevice | null = null;
  private _panelSize = 0;

  private _historyLoaded = false;
  private _rendered = false;

  private readonly _ctrl = new DashboardController();

  private readonly _handleToggleClick: (ev: Event) => void;
  private readonly _handleUnitToggle: (ev: Event) => void;
  private readonly _handleGearClick: (ev: Event) => void;
  private readonly _handleGraphSettingsChanged: () => void;
  private _onVisibilityChange: (() => void) | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._handleToggleClick = (ev: Event) => this._ctrl.onToggleClick(ev, this.shadowRoot!);
    this._handleUnitToggle = this._onUnitToggle.bind(this);
    this._handleGearClick = (ev: Event) => this._ctrl.onGearClick(ev, this.shadowRoot!);
    this._handleGraphSettingsChanged = () => this._ctrl.onGraphSettingsChanged(this.shadowRoot!);
  }

  connectedCallback(): void {
    this._ctrl.startIntervals(this.shadowRoot!);

    if (this._discovered && this._hass && this._rendered) {
      this._ctrl.updateDOM(this.shadowRoot!);
    }

    this._onVisibilityChange = () => {
      if (document.visibilityState === "visible" && this._discovered && this._hass) {
        this._ctrl.updateDOM(this.shadowRoot!);
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  disconnectedCallback(): void {
    this._ctrl.stopIntervals();
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  setConfig(config: CardConfig): void {
    this._config = config;
    this._discovered = false;
    this._rendered = false;
    this._historyLoaded = false;
    this._discoveryError = null;
    this._ctrl.reset();
    this._ctrl.setConfig(config);
  }

  private get _configEntryId(): string | null {
    return this._panelDevice?.config_entries?.[0] ?? null;
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this._ctrl.hass = hass;
    setLanguage(hass?.language);
    if (!this._config.device_id) {
      this.shadowRoot!.innerHTML = `
        <ha-card>
          <div style="padding: 24px; color: var(--secondary-text-color);">
            ${t("card.no_device")}
          </div>
        </ha-card>
      `;
      return;
    }
    if (!this._discovered && !this._discovering) {
      this._discovering = true;
      this._discoverTopology().then(() => {
        this._discovered = true;
        this._discovering = false;
        this._ctrl.init(this._topology, this._config, this._hass, this._configEntryId);
        this._render();
        this._loadHistory();
        this._ctrl.monitoringCache.fetch(hass, this._configEntryId).then(() => {
          if (this._rendered) this._ctrl.updateDOM(this.shadowRoot!);
        });
      });
      return;
    }
    if (this._discovered) {
      this._ctrl.recordSamples();
      this._ctrl.updateDOM(this.shadowRoot!);
    }
  }

  getCardSize(): number {
    return Math.ceil(this._panelSize / 2) + 3;
  }

  static getConfigElement(): HTMLElement {
    return document.createElement("span-panel-card-editor");
  }

  static getStubConfig(): CardConfig {
    return {
      device_id: "",
      history_days: 0,
      history_hours: 0,
      history_minutes: 5,
      chart_metric: DEFAULT_CHART_METRIC,
      show_panel: true,
      show_battery: true,
      show_evse: true,
    };
  }

  private async _discoverTopology(): Promise<void> {
    if (!this._hass) return;
    try {
      const result = await discoverTopology(this._hass, this._config.device_id);
      this._topology = result.topology;
      this._panelDevice = result.panelDevice;
      this._panelSize = result.panelSize;
    } catch (err) {
      console.error("SPAN Panel: topology fetch failed, falling back to entity discovery", err);
      try {
        const result = await discoverEntitiesFallback(this._hass, this._config.device_id);
        this._topology = result.topology;
        this._panelDevice = result.panelDevice;
        this._panelSize = result.panelSize;
      } catch (fallbackErr) {
        console.error("SPAN Panel: fallback discovery also failed", fallbackErr);
        this._discoveryError = (fallbackErr as Error).message;
      }
    }
  }

  private async _loadHistory(): Promise<void> {
    if (this._historyLoaded || !this._topology || !this._hass) return;
    this._historyLoaded = true;

    await this._ctrl.fetchAndBuildHorizonMaps();

    try {
      await this._ctrl.loadHistory();
      this._ctrl.updateDOM(this.shadowRoot!);
    } catch (err) {
      console.warn("SPAN Panel: history fetch failed, charts will populate live", err);
    }
  }

  private async _onUnitToggle(event: Event): Promise<void> {
    const target = event.target as HTMLElement | null;
    const btn = target?.closest(".unit-btn") as HTMLElement | null;
    if (!btn) return;
    const unit = btn.dataset.unit;
    if (!unit || unit === (this._config.chart_metric ?? "power")) return;
    this._config = { ...this._config, chart_metric: unit };
    this._ctrl.setConfig(this._config);
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
    this._ctrl.powerHistory.clear();
    this._historyLoaded = false;
    this._rendered = false;
    this._render();
    await this._loadHistory();
    this._ctrl.updateDOM(this.shadowRoot!);
  }

  private _render(): void {
    const hass = this._hass;
    if (!hass || !this._topology || !this._panelSize) {
      const msg = this._discoveryError ?? (!this._topology ? t("card.device_not_found") : t("card.loading"));
      this.shadowRoot!.innerHTML = `
        <ha-card>
          <div style="padding: 24px; color: var(--secondary-text-color);">
            ${escapeHtml(msg)}
          </div>
        </ha-card>
      `;
      return;
    }

    const topo = this._topology;
    const totalRows = Math.ceil(this._panelSize / 2);
    const headerHTML = buildHeaderHTML(topo, this._config);
    const monitoringStatus = this._ctrl.monitoringCache.status;
    const monitoringSummaryHTML = buildMonitoringSummaryHTML(monitoringStatus);
    const gridHTML = buildGridHTML(topo, totalRows, hass, this._config, monitoringStatus);
    const subDevHTML = buildSubDevicesHTML(topo, hass, this._config);

    const sr = this.shadowRoot!;

    sr.removeEventListener("click", this._handleToggleClick);
    sr.removeEventListener("click", this._handleUnitToggle);
    sr.removeEventListener("click", this._handleGearClick);
    sr.removeEventListener("graph-settings-changed", this._handleGraphSettingsChanged);

    sr.innerHTML = `
      <style>${CARD_STYLES}</style>
      <ha-card>
        ${headerHTML}
        ${monitoringSummaryHTML}
        ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
        ${
          this._config.show_panel !== false
            ? `
        <div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">
          ${gridHTML}
        </div>
        `
            : ""
        }
      </ha-card>
      <span-side-panel></span-side-panel>
    `;

    sr.addEventListener("click", this._handleToggleClick);
    sr.addEventListener("click", this._handleUnitToggle);
    sr.addEventListener("click", this._handleGearClick);
    sr.addEventListener("graph-settings-changed", this._handleGraphSettingsChanged);

    const slideEl = sr.querySelector(".slide-confirm");
    if (slideEl) {
      this._ctrl.bindSlideConfirm(slideEl, sr.querySelector("ha-card"));
      const card = sr.querySelector("ha-card");
      if (card) card.classList.add("switches-disabled");
    }

    const sidePanel = sr.querySelector("span-side-panel") as SpanSidePanelElement | null;
    if (sidePanel) sidePanel.hass = hass;

    this._rendered = true;
    this._ctrl.recordSamples();
    this._ctrl.updateDOM(sr);
    this._ctrl.setupResizeObserver(sr, sr.querySelector("ha-card"));
  }
}
