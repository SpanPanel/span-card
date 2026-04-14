import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { INTEGRATION_DOMAIN } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import "../core/side-panel.js";
import { DashboardTab } from "./tab-dashboard.js";
import { MonitoringTab } from "./tab-monitoring.js";
import { ListViewController } from "../core/list-view-controller.js";
import { DashboardController } from "../core/dashboard-controller.js";
import { buildTabBarHTML } from "../core/tab-bar-renderer.js";
import { subscribeAreaUpdates } from "../core/area-resolver.js";
import { discoverTopology } from "../card/card-discovery.js";
import { CARD_STYLES } from "../card/card-styles.js";
import type { HomeAssistant, PanelDevice, CardConfig } from "../types.js";

interface HaMenuButton extends HTMLElement {
  hass: HomeAssistant;
  narrow: boolean;
}

type TabName = "dashboard" | "activity" | "area" | "monitoring";

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
  @state() private _discoveryError: string | null = null;
  @state() private _chartMetric: string | undefined;

  private _dashboardTab = new DashboardTab();
  private _monitoringTab = new MonitoringTab();
  private _listDashCtrl = new DashboardController();
  private _listCtrl = new ListViewController(this._listDashCtrl);
  private _areaUnsub: (() => void) | null = null;
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
    .shared-tab-bar {
      display: flex;
      gap: 0;
    }
    .shared-tab {
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
    .shared-tab.active {
      opacity: 1;
      border-bottom-color: var(--app-header-text-color, white);
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
    this._listCtrl.stop();
    this._listDashCtrl.stopIntervals();
    if (this._areaUnsub) {
      this._areaUnsub();
      this._areaUnsub = null;
    }
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
      this._listDashCtrl.hass = this.hass;

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

    // Render tab content when discovery completes or active tab/panel/metric changes
    if (
      this._discovered &&
      (changedProps.has("_discovered") || changedProps.has("_activeTab") || changedProps.has("_selectedPanelId") || changedProps.has("_chartMetric"))
    ) {
      this._scheduleTabRender();
    }

    // Live-update collapsed rows when hass changes on list view tabs
    if (changedProps.has("hass") && this._discovered && (this._activeTab === "activity" || this._activeTab === "area")) {
      const tabContent = this.shadowRoot!.getElementById("tab-content");
      const topo = this._listDashCtrl.topology;
      if (tabContent && topo) {
        this._listCtrl.updateCollapsedRows(tabContent, this.hass, topo, this._buildDashboardConfig());
        const sidePanel = tabContent.querySelector("span-side-panel") as { hass: HomeAssistant } | null;
        if (sidePanel) sidePanel.hass = this.hass;
      }
    }
  }

  setConfig(_config: CardConfig): void {
    // Config is set by HA but the dashboard tab builds its own config
  }

  protected render(): unknown {
    setLanguage(this.hass?.language);

    if (!this._discovered) {
      return html`
        <div class="header">
          <div class="toolbar">
            <ha-menu-button></ha-menu-button>
            <div class="main-title">Span Panel</div>
          </div>
        </div>
        <div class="view">
          <div class="view-content" style="padding: 24px; color: var(--secondary-text-color);">${this._discoveryError ?? "Loading\u2026"}</div>
        </div>
      `;
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

        <div class="panel-tabs" @click=${this._onTabClick}>
          ${unsafeHTML(
            buildTabBarHTML(
              [
                { id: "dashboard", label: t("tab.by_panel"), icon: "mdi:view-dashboard" },
                { id: "activity", label: t("tab.by_activity"), icon: "mdi:sort-descending" },
                { id: "area", label: t("tab.by_area"), icon: "mdi:home-group" },
                { id: "monitoring", label: t("tab.monitoring"), icon: "mdi:monitor-eye" },
              ],
              this._activeTab,
              "text"
            )
          )}
        </div>
      </div>

      <div class="view">
        <div class="view-content">
          <div
            class="tab-content"
            id="tab-content"
            @click=${this._onTabContentClick}
            @unit-changed=${this._onUnitChanged}
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
    if (this._areaUnsub) {
      this._areaUnsub();
      this._areaUnsub = null;
    }
    this._scheduleTabRender();
  }

  private _onTabClick(e: Event): void {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>(".shared-tab");
    if (!btn) return;
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

  private _onUnitChanged(e: Event): void {
    const unit = (e as CustomEvent<string>).detail;
    if (!unit || unit === this._chartMetric) return;
    this._chartMetric = unit;
    localStorage.setItem("span_panel_metric", unit);
    this._scheduleTabRender();
  }

  private _onGraphSettingsChanged(): void {
    if (this._activeTab === "dashboard") {
      const container = this.shadowRoot!.getElementById("tab-content");
      if (container) {
        const ctrl = this._dashboardTab["_ctrl"];
        ctrl.onGraphSettingsChanged(container);
      }
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
      this._discoveryError = `Discovery failed: ${(err as Error).message ?? err}`;
      return;
    }

    this._discoveryError = null;
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
    this._listCtrl.stop();
    this._listDashCtrl.stopIntervals();

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
      case "activity": {
        container.innerHTML = "";
        const device = this._panels.find(p => p.id === this._selectedPanelId);
        const entryId = device?.config_entries?.[0] ?? null;
        try {
          const result = await discoverTopology(this.hass, this._selectedPanelId ?? undefined);
          const config = this._buildDashboardConfig();
          this._listDashCtrl.init(result.topology, config, this.hass, entryId);
          await this._listDashCtrl.monitoringCache.fetch(this.hass, entryId);
          await this._listDashCtrl.fetchAndBuildHorizonMaps();
          this._listCtrl.renderActivityView(container, this.hass, result.topology!, config, this._listDashCtrl.monitoringCache.status);
          container.insertAdjacentHTML("afterbegin", `<style>${CARD_STYLES}</style>`);
          await this._listDashCtrl.loadHistory();
          this._listDashCtrl.updateDOM(container);
          this._listDashCtrl.startIntervals(container);
        } catch (err) {
          const errEl = document.createElement("p");
          errEl.style.color = "var(--error-color)";
          errEl.textContent = (err as Error).message;
          container.appendChild(errEl);
        }
        break;
      }
      case "area": {
        container.innerHTML = "";
        const areaDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const areaEntryId = areaDevice?.config_entries?.[0] ?? null;
        try {
          const result = await discoverTopology(this.hass, this._selectedPanelId ?? undefined);
          const config = this._buildDashboardConfig();
          this._listDashCtrl.init(result.topology, config, this.hass, areaEntryId);
          await this._listDashCtrl.monitoringCache.fetch(this.hass, areaEntryId);
          await this._listDashCtrl.fetchAndBuildHorizonMaps();
          this._listCtrl.renderAreaView(container, this.hass, result.topology!, config, this._listDashCtrl.monitoringCache.status);
          container.insertAdjacentHTML("afterbegin", `<style>${CARD_STYLES}</style>`);
          await this._listDashCtrl.loadHistory();
          this._listDashCtrl.updateDOM(container);
          this._listDashCtrl.startIntervals(container);

          if (!this._areaUnsub) {
            subscribeAreaUpdates(this.hass, result.topology!, () => {
              if (this._activeTab === "area") {
                this._scheduleTabRender();
              }
            })
              .then(unsub => {
                this._areaUnsub = unsub;
              })
              .catch(() => {});
          }
        } catch (err) {
          const errEl = document.createElement("p");
          errEl.style.color = "var(--error-color)";
          errEl.textContent = (err as Error).message;
          container.appendChild(errEl);
        }
        break;
      }
      case "monitoring": {
        container.innerHTML = "";
        const monDevice = this._panels.find(p => p.id === this._selectedPanelId);
        const monEntryId = monDevice?.config_entries?.[0] ?? null;
        await this._monitoringTab.render(container, this.hass, monEntryId ?? undefined);
        break;
      }
    }
  }
}
