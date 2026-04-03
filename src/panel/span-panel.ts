import { INTEGRATION_DOMAIN } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
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

const PANEL_STYLES = `
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

type TabName = "dashboard" | "monitoring" | "settings";

export class SpanPanelElement extends HTMLElement {
  private _hass: HomeAssistant | null;
  // _config is set by HA but dashboard builds its own config
  private _panels: PanelDevice[];
  private _selectedPanelId: string | null;
  private _activeTab: TabName;
  private _discovered: boolean;
  private _narrow: boolean;
  private _dashboardTab: DashboardTab;
  private _monitoringTab: MonitoringTab;
  private _settingsTab: SettingsTab;
  private _chartMetric: string | undefined;
  private _onVisibilityChange: (() => void) | null;
  private _deviceRegistryUnsub: Promise<() => void> | null;
  private _shadowListenersBound: boolean;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._panels = [];
    this._selectedPanelId = null;
    this._activeTab = "dashboard";
    this._discovered = false;
    this._narrow = false;
    this._dashboardTab = new DashboardTab();
    this._monitoringTab = new MonitoringTab();
    this._settingsTab = new SettingsTab();
    this._onVisibilityChange = null;
    this._deviceRegistryUnsub = null;
    this._shadowListenersBound = false;
  }

  connectedCallback(): void {
    // When HA navigates back to this panel, re-render if we already have data
    if (this._discovered && this._hass) {
      this._render();
    }

    this._onVisibilityChange = (): void => {
      if (document.visibilityState === "visible" && this._discovered && this._hass) {
        if (!this.shadowRoot!.getElementById("tab-content")) {
          this._render();
        } else {
          this._renderTab();
        }
      }
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
  }

  private _subscribeDeviceRegistry(): void {
    if (this._deviceRegistryUnsub || !this._hass?.connection) return;
    this._deviceRegistryUnsub = this._hass.connection.subscribeEvents(() => this._refreshPanels(), "device_registry_updated");
  }

  private _unsubscribeDeviceRegistry(): void {
    if (this._deviceRegistryUnsub) {
      this._deviceRegistryUnsub.then(unsub => unsub());
      this._deviceRegistryUnsub = null;
    }
  }

  private async _refreshPanels(): Promise<void> {
    if (!this._hass || !this._discovered) return;

    const devices = await this._hass.callWS<PanelDevice[]>({
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
    this._render();
  }

  set hass(val: HomeAssistant) {
    const firstHass = !this._hass && val;
    this._hass = val;
    this._dashboardTab.hass = val;
    // Update ha-menu-button if already rendered
    const menuBtn = this.shadowRoot!.querySelector<HaMenuButton>("ha-menu-button");
    if (menuBtn) menuBtn.hass = val;
    if (!this._discovered) {
      this._discoverPanels();
    } else if (!this.shadowRoot!.getElementById("tab-content")) {
      // Shell DOM was lost (e.g. after prolonged background) — rebuild
      this._render();
    }
    if (firstHass) {
      this._subscribeDeviceRegistry();
    }
  }

  set narrow(val: boolean) {
    this._narrow = val;
    const menuBtn = this.shadowRoot!.querySelector<HaMenuButton>("ha-menu-button");
    if (menuBtn) menuBtn.narrow = val;
  }

  setConfig(_config: CardConfig): void {
    // Config is set by HA but the dashboard tab builds its own config
  }

  private async _discoverPanels(): Promise<void> {
    if (!this._hass) return;
    this._discovered = true;

    const devices = await this._hass.callWS<PanelDevice[]>({
      type: "config/device_registry/list",
    });
    this._panels = devices.filter((d: PanelDevice) => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);

    const stored = localStorage.getItem("span_panel_selected");
    if (stored && this._panels.some(p => p.id === stored)) {
      this._selectedPanelId = stored;
    } else if (this._panels.length > 0) {
      this._selectedPanelId = this._panels[0]!.id;
    }

    this._chartMetric = localStorage.getItem("span_panel_metric") || "power";

    this._render();
  }

  private _render(): void {
    setLanguage(this._hass?.language);
    this.shadowRoot!.innerHTML = `
      <style>${PANEL_STYLES}</style>

      <div class="header">
        <div class="toolbar">
          <ha-menu-button></ha-menu-button>
          <div class="main-title">
            <span class="panel-selector">
              <select id="panel-select">
                ${this._panels
                  .map(
                    p => `
                  <option value="${p.id}" ${p.id === this._selectedPanelId ? "selected" : ""}>
                    ${escapeHtml(p.name_by_user || p.name || p.id)}
                  </option>
                `
                  )
                  .join("")}
              </select>
            </span>
          </div>
        </div>

        <div class="panel-tabs">
          <button class="panel-tab ${this._activeTab === "dashboard" ? "active" : ""}" data-tab="dashboard">${t("tab.panel")}</button>
          <button class="panel-tab ${this._activeTab === "monitoring" ? "active" : ""}" data-tab="monitoring">${t("tab.monitoring")}</button>
          <button class="panel-tab ${this._activeTab === "settings" ? "active" : ""}" data-tab="settings">${t("tab.settings")}</button>
        </div>
      </div>

      <div class="view">
        <div class="view-content">
          <div class="tab-content" id="tab-content"></div>
        </div>
      </div>
    `;

    // Wire up ha-menu-button
    const menuBtn = this.shadowRoot!.querySelector<HaMenuButton>("ha-menu-button");
    if (menuBtn) {
      menuBtn.hass = this._hass!;
      menuBtn.narrow = this._narrow;
    }

    const select = this.shadowRoot!.getElementById("panel-select") as HTMLSelectElement | null;
    if (select) {
      select.addEventListener("change", () => {
        this._selectedPanelId = select.value;
        localStorage.setItem("span_panel_selected", select.value);
        this._renderTab();
      });
    }

    for (const tab of this.shadowRoot!.querySelectorAll<HTMLElement>(".panel-tab")) {
      tab.addEventListener("click", () => {
        this._activeTab = tab.dataset.tab as TabName;
        for (const tabEl of this.shadowRoot!.querySelectorAll<HTMLElement>(".panel-tab")) {
          tabEl.classList.toggle("active", tabEl.dataset.tab === this._activeTab);
        }
        this._renderTab();
      });
    }

    if (!this._shadowListenersBound) {
      this._bindUnitToggle();
      this._bindTabNavigation();

      // Sync: if graph settings change (from side panel or settings tab),
      // invalidate the dashboard cache and re-render the active tab
      this.shadowRoot!.addEventListener("graph-settings-changed", () => {
        this._dashboardTab.invalidateGraphSettings();
        if (this._activeTab === "settings") {
          this._renderTab();
        }
      });
      this._shadowListenersBound = true;
    }

    this._renderTab();
  }

  private _bindUnitToggle(): void {
    this.shadowRoot!.addEventListener("click", (e: Event) => {
      const target = e.target as HTMLElement;
      const btn = target.closest<HTMLElement>(".unit-btn");
      if (!btn) return;
      const metric = btn.dataset.unit;
      if (!metric || metric === this._chartMetric) return;
      this._chartMetric = metric;
      localStorage.setItem("span_panel_metric", metric);
      if (this._activeTab === "dashboard") {
        this._renderTab();
      }
    });
  }

  private _bindTabNavigation(): void {
    this.shadowRoot!.addEventListener("navigate-tab", (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (!tab) return;
      this._activeTab = tab as TabName;
      for (const tabEl of this.shadowRoot!.querySelectorAll<HTMLElement>(".panel-tab")) {
        tabEl.classList.toggle("active", tabEl.dataset.tab === tab);
      }
      this._renderTab();
    });
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
        await this._dashboardTab.render(container, this._hass!, this._selectedPanelId ?? "", config, dashEntryId);
        break;
      }
      case "monitoring": {
        container.innerHTML = "";
        const monDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const monEntryId = monDevice?.config_entries?.[0] ?? null;
        await this._monitoringTab.render(container, this._hass!, monEntryId ?? undefined);
        break;
      }
      case "settings": {
        container.innerHTML = "";
        const selectedDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const configEntryId = selectedDevice?.config_entries?.[0] ?? null;
        await this._settingsTab.render(container, this._hass!, configEntryId ?? undefined, this._selectedPanelId ?? undefined);
        break;
      }
    }
  }
}
