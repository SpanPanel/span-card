import { INTEGRATION_DOMAIN } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import "../core/side-panel.js";
import { DashboardTab } from "./tab-dashboard.js";
import { MonitoringTab } from "./tab-monitoring.js";
import { SettingsTab } from "./tab-settings.js";

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
    background: transparent;
    border: none;
    color: inherit;
    font-size: inherit;
    font-weight: inherit;
    cursor: pointer;
    padding: 0;
    appearance: none;
    -webkit-appearance: none;
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
    display: flex;
    justify-content: center;
    padding: 16px;
  }
  .view-content {
    width: 100%;
    max-width: 900px;
  }
  .tab-content {
    min-height: 400px;
  }
`;

export class SpanPanelElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._panels = [];
    this._selectedPanelId = null;
    this._activeTab = "dashboard";
    this._discovered = false;
    this._narrow = false;
    this._dashboardTab = new DashboardTab();
    this._monitoringTab = new MonitoringTab();
    this._settingsTab = new SettingsTab();
  }

  connectedCallback() {
    // When HA navigates back to this panel, re-render if we already have data
    if (this._discovered && this._hass) {
      this._render();
    }

    this._onVisibilityChange = () => {
      if (document.visibilityState === "visible" && this._discovered && this._hass) {
        this._renderTab();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  disconnectedCallback() {
    this._dashboardTab.stop();
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  set hass(val) {
    this._hass = val;
    this._dashboardTab._hass = val;
    // Update ha-menu-button if already rendered
    const menuBtn = this.shadowRoot.querySelector("ha-menu-button");
    if (menuBtn) menuBtn.hass = val;
    if (!this._discovered) {
      this._discoverPanels();
    }
  }

  set narrow(val) {
    this._narrow = val;
    const menuBtn = this.shadowRoot.querySelector("ha-menu-button");
    if (menuBtn) menuBtn.narrow = val;
  }

  setConfig(config) {
    this._config = config || {};
  }

  async _discoverPanels() {
    if (!this._hass) return;
    this._discovered = true;

    const devices = await this._hass.callWS({
      type: "config/device_registry/list",
    });
    this._panels = devices.filter(d => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);

    const stored = localStorage.getItem("span_panel_selected");
    if (stored && this._panels.some(p => p.id === stored)) {
      this._selectedPanelId = stored;
    } else if (this._panels.length > 0) {
      this._selectedPanelId = this._panels[0].id;
    }

    this._chartMetric = localStorage.getItem("span_panel_metric") || "power";

    this._render();
  }

  _render() {
    setLanguage(this._hass?.language);
    const multiPanel = this._panels.length > 1;
    const selectedPanel = this._panels.find(p => p.id === this._selectedPanelId);
    const panelLabel = selectedPanel ? selectedPanel.name_by_user || selectedPanel.name || selectedPanel.id : "";

    this.shadowRoot.innerHTML = `
      <style>${PANEL_STYLES}</style>

      <div class="header">
        <div class="toolbar">
          <ha-menu-button></ha-menu-button>
          <div class="main-title">
            <span class="panel-selector">
              ${
                multiPanel
                  ? `
                <select id="panel-select">
                  ${this._panels
                    .map(
                      p => `
                    <option value="${p.id}" ${p.id === this._selectedPanelId ? "selected" : ""}>
                      ${p.name_by_user || p.name || p.id}
                    </option>
                  `
                    )
                    .join("")}
                </select>
              `
                  : panelLabel
              }
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
    const menuBtn = this.shadowRoot.querySelector("ha-menu-button");
    if (menuBtn) {
      menuBtn.hass = this._hass;
      menuBtn.narrow = this._narrow;
    }

    const select = this.shadowRoot.getElementById("panel-select");
    if (select) {
      select.addEventListener("change", () => {
        this._selectedPanelId = select.value;
        localStorage.setItem("span_panel_selected", select.value);
        this._renderTab();
      });
    }

    for (const tab of this.shadowRoot.querySelectorAll(".panel-tab")) {
      tab.addEventListener("click", () => {
        this._activeTab = tab.dataset.tab;
        for (const t of this.shadowRoot.querySelectorAll(".panel-tab")) {
          t.classList.toggle("active", t.dataset.tab === this._activeTab);
        }
        this._renderTab();
      });
    }

    this._bindUnitToggle();
    this._bindTabNavigation();

    // Sync: if graph settings change (from side panel or settings tab),
    // re-render settings tab if it's visible
    this.shadowRoot.addEventListener("graph-settings-changed", () => {
      if (this._activeTab === "settings") {
        this._renderTab();
      }
    });

    this._renderTab();
  }

  _bindUnitToggle() {
    this.shadowRoot.addEventListener("click", e => {
      const btn = e.target.closest(".unit-btn");
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

  _bindTabNavigation() {
    this.shadowRoot.addEventListener("navigate-tab", e => {
      const tab = e.detail;
      if (!tab) return;
      this._activeTab = tab;
      for (const t of this.shadowRoot.querySelectorAll(".panel-tab")) {
        t.classList.toggle("active", t.dataset.tab === tab);
      }
      this._renderTab();
    });
  }

  _buildDashboardConfig() {
    return {
      chart_metric: this._chartMetric,
      history_minutes: 5,
      show_panel: true,
      show_battery: true,
      show_evse: true,
    };
  }

  async _renderTab() {
    this._dashboardTab.stop();

    const container = this.shadowRoot.getElementById("tab-content");
    if (!container) return;

    switch (this._activeTab) {
      case "dashboard": {
        container.innerHTML = "";
        const config = this._buildDashboardConfig();
        await this._dashboardTab.render(container, this._hass, this._selectedPanelId, config);
        break;
      }
      case "monitoring": {
        container.innerHTML = "";
        const monDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const monEntryId = monDevice?.config_entries?.[0] || null;
        await this._monitoringTab.render(container, this._hass, monEntryId);
        break;
      }
      case "settings": {
        container.innerHTML = "";
        const selectedDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const configEntryId = selectedDevice?.config_entries?.[0] || null;
        await this._settingsTab.render(container, this._hass, configEntryId, this._selectedPanelId);
        break;
      }
    }
  }
}
