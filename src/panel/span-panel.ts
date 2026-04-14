import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { INTEGRATION_DOMAIN } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import "../core/side-panel.js";
import { DashboardTab } from "./tab-dashboard.js";
import { MonitoringTab } from "./tab-monitoring.js";
import { SettingsTab } from "./tab-settings.js";
import type { HomeAssistant, PanelDevice, CardConfig } from "../types.js";

interface HaMenuButton extends HTMLElement {
  hass: HomeAssistant;
  narrow: boolean;
}

type TabName = "dashboard" | "monitoring" | "settings";

@customElement("span-panel")
export class SpanPanelElement extends LitElement {
  @property({ attribute: false })
  hass!: HomeAssistant;

  @property({ type: Boolean, reflect: true })
  narrow = false;

  @state() private _panels: PanelDevice[] = [];
  @state() private _selectedPanelId: string | null = null;
  @state() private _activeTab: TabName = "dashboard";
  @state() private _discovered = false;
  @state() private _chartMetric: string | undefined;

  private _dashboardTab = new DashboardTab();
  private _monitoringTab = new MonitoringTab();
  private _settingsTab = new SettingsTab();
  private _onVisibilityChange: (() => void) | null = null;
  private _deviceRegistryUnsub: Promise<() => void> | null = null;

  static styles = css`
    :host {
      color: var(--primary-text-color);
    }
    .header {
      background-color: var(--app-header-background-color);
      color: var(--app-header-text-color, white);
      border-bottom: var(--app-header-border-bottom, none);
    }
    .toolbar {
      height: var(--header-height);
      display: flex;
      align-items: center;
      font-size: 20px;
      padding: 0 16px;
      font-weight: 400;
      box-sizing: border-box;
    }
    .main-title {
      margin: 0 0 0 24px;
      line-height: 20px;
      flex-grow: 1;
    }
    .panel-selector select {
      color: inherit;
      font-size: inherit;
      font-weight: inherit;
      cursor: pointer;
      padding: 4px 8px;
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 6px;
      background-color: rgba(255, 255, 255, 0.1);
    }
    .panel-selector select option {
      background: var(--card-background-color, #333);
      color: var(--primary-text-color);
    }
    .panel-tabs {
      margin-left: max(env(safe-area-inset-left), 24px);
      margin-right: max(env(safe-area-inset-right), 24px);
      display: flex;
      gap: 0;
    }
    .panel-tab {
      padding: 8px 20px;
      cursor: pointer;
      font-size: 0.9em;
      font-weight: 500;
      color: var(--app-header-text-color, white);
      opacity: 0.7;
      border-bottom: 2px solid transparent;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
    }
    .panel-tab.active {
      opacity: 1;
      border-bottom-color: var(--app-header-text-color, white);
    }
    .view {
      padding: 16px;
    }
    .view-content {
      width: 100%;
    }
    .tab-content {
      min-height: 400px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();

    this._onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible" || !this._discovered || !this.hass) return;
      this._scheduleTabRender();
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);

    this._subscribeDeviceRegistry();
  }

  disconnectedCallback(): void {
    this._dashboardTab.stop();
    this._monitoringTab.stop();
    this._settingsTab.stop();
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
    this._unsubscribeDeviceRegistry();
    super.disconnectedCallback();
  }

  firstUpdated(): void {
    if (this.hass && !this._discovered) {
      this._discoverPanels();
    }
  }

  updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has("hass")) {
      const oldHass = changedProps.get("hass") as HomeAssistant | undefined;
      this._dashboardTab.hass = this.hass;

      // Wire up ha-menu-button with current hass/narrow
      const menuBtn = this.renderRoot.querySelector<HaMenuButton>("ha-menu-button");
      if (menuBtn) {
        menuBtn.hass = this.hass;
        menuBtn.narrow = this.narrow;
      }

      if (!this._discovered) {
        this._discoverPanels();
      } else if (!this.shadowRoot!.getElementById("tab-content")) {
        // Re-render only if the tab-content container was lost
        this._scheduleTabRender();
      }

      if (!oldHass && this.hass) {
        this._subscribeDeviceRegistry();
      }
    }

    if (changedProps.has("narrow")) {
      const menuBtn = this.renderRoot.querySelector<HaMenuButton>("ha-menu-button");
      if (menuBtn) menuBtn.narrow = this.narrow;
    }
  }

  setConfig(_config: CardConfig): void {
    // Config is set by HA but the dashboard tab builds its own config
  }

  protected render(): unknown {
    setLanguage(this.hass?.language);

    if (!this._discovered) {
      return html``;
    }

    return html`
      <div class="header">
        <div class="toolbar">
          <ha-menu-button></ha-menu-button>
          <div class="main-title">
            <span class="panel-selector">
              <select id="panel-select" @change=${this._onPanelChange}>
                ${this._panels.map(p => html` <option value=${p.id} ?selected=${p.id === this._selectedPanelId}>${p.name_by_user || p.name || p.id}</option> `)}
              </select>
            </span>
          </div>
        </div>

        <div class="panel-tabs">
          <button class="panel-tab ${this._activeTab === "dashboard" ? "active" : ""}" data-tab="dashboard" @click=${this._onTabClick}>
            ${t("tab.panel")}
          </button>
          <button class="panel-tab ${this._activeTab === "monitoring" ? "active" : ""}" data-tab="monitoring" @click=${this._onTabClick}>
            ${t("tab.monitoring")}
          </button>
          <button class="panel-tab ${this._activeTab === "settings" ? "active" : ""}" data-tab="settings" @click=${this._onTabClick}>
            ${t("tab.settings")}
          </button>
        </div>
      </div>

      <div class="view">
        <div class="view-content">
          <div
            class="tab-content"
            id="tab-content"
            @click=${this._onTabContentClick}
            @side-panel-closed=${this._onSidePanelClosed}
            @graph-settings-changed=${this._onGraphSettingsChanged}
            @navigate-tab=${this._onNavigateTab}
          ></div>
        </div>
      </div>
    `;
  }

  // ── Event handlers ──────────────────────────────────────────────────

  private _onPanelChange(e: Event): void {
    const select = e.target as HTMLSelectElement;
    this._selectedPanelId = select.value;
    localStorage.setItem("span_panel_selected", select.value);
    this._scheduleTabRender();
  }

  private _onTabClick(e: Event): void {
    const btn = e.currentTarget as HTMLElement;
    const tab = btn.dataset.tab as TabName | undefined;
    if (!tab || tab === this._activeTab) return;
    this._activeTab = tab;
    this._scheduleTabRender();
  }

  private _onTabContentClick(e: Event): void {
    const target = e.target as HTMLElement;

    // Unit toggle
    const btn = target.closest<HTMLElement>(".unit-btn");
    if (btn) {
      const metric = btn.dataset.unit;
      if (!metric || metric === this._chartMetric) return;
      this._chartMetric = metric;
      localStorage.setItem("span_panel_metric", metric);
      if (this._activeTab === "dashboard") {
        this._scheduleTabRender();
      }
      return;
    }

    // Gear/toggle clicks handled by DashboardController
    // (DashboardTab registers its own click listeners on the container)
  }

  private _onSidePanelClosed(): void {
    if (this._activeTab === "dashboard") {
      const ctrl = this._dashboardTab["_ctrl"];
      ctrl.monitoringCache.invalidate();
      ctrl.graphSettingsCache.invalidate();
    }
  }

  private _onGraphSettingsChanged(): void {
    if (this._activeTab === "dashboard") {
      const container = this.shadowRoot!.getElementById("tab-content");
      if (container) {
        const ctrl = this._dashboardTab["_ctrl"];
        ctrl.onGraphSettingsChanged(container);
      }
    } else if (this._activeTab === "settings") {
      this._scheduleTabRender();
    }
  }

  private _onNavigateTab(e: Event): void {
    const tab = (e as CustomEvent<string>).detail;
    if (!tab) return;
    this._activeTab = tab as TabName;
    this._scheduleTabRender();
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private _subscribeDeviceRegistry(): void {
    if (this._deviceRegistryUnsub || !this.hass?.connection) return;
    this._deviceRegistryUnsub = this.hass.connection.subscribeEvents(() => this._refreshPanels(), "device_registry_updated");
  }

  private _unsubscribeDeviceRegistry(): void {
    if (this._deviceRegistryUnsub) {
      this._deviceRegistryUnsub.then(unsub => unsub());
      this._deviceRegistryUnsub = null;
    }
  }

  private async _refreshPanels(): Promise<void> {
    if (!this.hass || !this._discovered) return;

    const devices = await this.hass.callWS<PanelDevice[]>({
      type: "config/device_registry/list",
    });
    const panels = devices.filter((d: PanelDevice) => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);

    const currentIds = new Set(this._panels.map(p => p.id));
    const newIds = new Set(panels.map(p => p.id));
    if (currentIds.size === newIds.size && [...currentIds].every(id => newIds.has(id))) return;

    this._panels = panels;
    if (!this._panels.some(p => p.id === this._selectedPanelId) && this._panels.length > 0) {
      this._selectedPanelId = this._panels[0]!.id;
      localStorage.setItem("span_panel_selected", this._selectedPanelId);
    }
  }

  private async _discoverPanels(): Promise<void> {
    if (!this.hass) return;

    try {
      const devices = await this.hass.callWS<PanelDevice[]>({
        type: "config/device_registry/list",
      });
      this._panels = devices.filter((d: PanelDevice) => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);
    } catch (err) {
      console.error("SPAN Panel: device discovery failed", err);
      return;
    }

    this._discovered = true;

    const stored = localStorage.getItem("span_panel_selected");
    if (stored && this._panels.some(p => p.id === stored)) {
      this._selectedPanelId = stored;
    } else if (this._panels.length > 0) {
      this._selectedPanelId = this._panels[0]!.id;
    }

    this._chartMetric = localStorage.getItem("span_panel_metric") || "power";
  }

  private _buildDashboardConfig(): CardConfig {
    return {
      chart_metric: this._chartMetric,
      history_minutes: 5,
      show_panel: true,
      show_battery: true,
      show_evse: true,
    };
  }

  private async _scheduleTabRender(): Promise<void> {
    await this.updateComplete;
    await this._renderTab();
  }

  private async _renderTab(): Promise<void> {
    this._dashboardTab.stop();
    this._monitoringTab.stop();
    this._settingsTab.stop();

    const container = this.shadowRoot!.getElementById("tab-content");
    if (!container) return;

    switch (this._activeTab) {
      case "dashboard": {
        container.innerHTML = "";
        const config = this._buildDashboardConfig();
        const dashDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const dashEntryId = dashDevice?.config_entries?.[0] ?? null;
        await this._dashboardTab.render(container, this.hass, this._selectedPanelId ?? "", config, dashEntryId);
        break;
      }
      case "monitoring": {
        container.innerHTML = "";
        const monDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const monEntryId = monDevice?.config_entries?.[0] ?? null;
        await this._monitoringTab.render(container, this.hass, monEntryId ?? undefined);
        break;
      }
      case "settings": {
        container.innerHTML = "";
        const selectedDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const configEntryId = selectedDevice?.config_entries?.[0] ?? null;
        await this._settingsTab.render(container, this.hass, configEntryId ?? undefined, this._selectedPanelId ?? undefined);
        break;
      }
    }
  }
}
