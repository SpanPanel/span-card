import { INTEGRATION_DOMAIN } from "../constants.js";
import "../core/side-panel.js";
import { DashboardTab } from "./tab-dashboard.js";
import { MonitoringTab } from "./tab-monitoring.js";
import { SettingsTab } from "./tab-settings.js";

const PANEL_STYLES = `
  :host {
    display: block;
    padding: 16px;
    max-width: 900px;
    margin: 0 auto;
  }
  .panel-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--divider-color, #333);
    margin-bottom: 16px;
  }
  .panel-tab {
    padding: 8px 20px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 500;
    color: var(--secondary-text-color);
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
  }
  .panel-tab.active {
    color: var(--primary-color);
    border-bottom-color: var(--primary-color);
  }
  .panel-selector {
    margin-bottom: 16px;
  }
  .panel-selector select {
    background: var(--secondary-background-color, #333);
    border: 1px solid var(--divider-color);
    color: var(--primary-text-color);
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 0.9em;
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
    this._dashboardTab = new DashboardTab();
    this._monitoringTab = new MonitoringTab();
    this._settingsTab = new SettingsTab();
  }

  set hass(val) {
    this._hass = val;
    if (!this._discovered) {
      this._discoverPanels();
    }
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
    this._panels = devices.filter(d => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN));

    const stored = localStorage.getItem("span_panel_selected");
    if (stored && this._panels.some(p => p.id === stored)) {
      this._selectedPanelId = stored;
    } else if (this._panels.length > 0) {
      this._selectedPanelId = this._panels[0].id;
    }

    this._render();
  }

  _render() {
    const showSelector = this._panels.length > 1;

    this.shadowRoot.innerHTML = `
      <style>${PANEL_STYLES}</style>

      ${
        showSelector
          ? `
        <div class="panel-selector">
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
        </div>
      `
          : ""
      }

      <div class="panel-tabs">
        <button class="panel-tab ${this._activeTab === "dashboard" ? "active" : ""}" data-tab="dashboard">Panel</button>
        <button class="panel-tab ${this._activeTab === "monitoring" ? "active" : ""}" data-tab="monitoring">Monitoring</button>
        <button class="panel-tab ${this._activeTab === "settings" ? "active" : ""}" data-tab="settings">Settings</button>
      </div>

      <div class="tab-content" id="tab-content"></div>
    `;

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

    this._renderTab();
  }

  async _renderTab() {
    this._dashboardTab.stop();

    const container = this.shadowRoot.getElementById("tab-content");
    if (!container) return;

    switch (this._activeTab) {
      case "dashboard": {
        container.innerHTML = "";
        const config = {
          chart_metric: "power",
          history_minutes: 5,
          show_panel: true,
          show_battery: true,
          show_evse: true,
        };
        await this._dashboardTab.render(container, this._hass, this._selectedPanelId, config);
        break;
      }
      case "monitoring":
        container.innerHTML = "";
        await this._monitoringTab.render(container, this._hass);
        break;
      case "settings":
        container.innerHTML = "";
        this._settingsTab.render(container);
        break;
    }
  }
}
