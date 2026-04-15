import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { INTEGRATION_DOMAIN } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import "../core/side-panel.js";
import { DashboardTab } from "./tab-dashboard.js";
import { MonitoringTab } from "./tab-monitoring.js";
import { ListViewController, type FavoritesViewStateDetail } from "../core/list-view-controller.js";
import { DashboardController } from "../core/dashboard-controller.js";
import { buildTabBarHTML } from "../core/tab-bar-renderer.js";
import { subscribeAreaUpdates } from "../core/area-resolver.js";
import { discoverTopology } from "../card/card-discovery.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { CARD_STYLES } from "../card/card-styles.js";
import { FAVORITES_CHANGED_EVENT, FavoritesCache, hasAnyFavorites } from "../core/favorites-store.js";
import { FavoritesController } from "../core/favorites-controller.js";
import type { CardConfig, FavoritesMap, FavoritesTopology, HomeAssistant, PanelDevice, PanelTopology } from "../types.js";

const FAVORITES_PANEL_ID = "favorites";
const FAVORITES_VIEW_STATE_KEY = "span_panel_favorites_view_state";

interface FavoritesViewState {
  activeTab?: "activity" | "area" | "monitoring";
  expanded: { activity: string[]; area: string[] };
  searchQuery?: string;
}

function _defaultFavoritesViewState(): FavoritesViewState {
  return { expanded: { activity: [], area: [] } };
}

function _loadFavoritesViewState(): FavoritesViewState {
  try {
    const raw = localStorage.getItem(FAVORITES_VIEW_STATE_KEY);
    if (!raw) return _defaultFavoritesViewState();
    const parsed = JSON.parse(raw) as Partial<FavoritesViewState> | null;
    if (!parsed || typeof parsed !== "object") return _defaultFavoritesViewState();
    const expanded = parsed.expanded ?? { activity: [], area: [] };
    return {
      activeTab: parsed.activeTab,
      expanded: {
        activity: Array.isArray(expanded.activity) ? expanded.activity : [],
        area: Array.isArray(expanded.area) ? expanded.area : [],
      },
      searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : undefined,
    };
  } catch {
    return _defaultFavoritesViewState();
  }
}

function _saveFavoritesViewState(viewState: FavoritesViewState): void {
  try {
    localStorage.setItem(FAVORITES_VIEW_STATE_KEY, JSON.stringify(viewState));
  } catch {
    // LocalStorage quota or disabled — non-fatal; state doesn't persist.
  }
}

function _clearFavoritesViewState(): void {
  try {
    localStorage.removeItem(FAVORITES_VIEW_STATE_KEY);
  } catch {
    // non-fatal
  }
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
  @state() private _favorites: FavoritesMap = {};

  private _favoritesViewState: FavoritesViewState = _defaultFavoritesViewState();

  private _dashboardTab = new DashboardTab();
  private _monitoringTab = new MonitoringTab();
  private _listDashCtrl = new DashboardController();
  private _listCtrl = new ListViewController(this._listDashCtrl);
  private _favCache = new FavoritesCache();
  private _favCtrl = new FavoritesController();
  /**
   * Per-panel monitoring tabs used when rendering the Favorites view's
   * Monitoring tab — one block per contributing panel's config entry.
   */
  private _favoritesMonitoringTabs: Map<string, MonitoringTab> = new Map();
  /**
   * Monotonic token incremented on each ``_refreshFavorites`` call.
   * Concurrent invocations (rapid heart toggles → multiple
   * ``favorites-changed`` events) compare their token against the latest
   * after each await; superseded callbacks bail out without touching
   * state or scheduling another tab render.
   */
  private _refreshSeq = 0;
  private _areaUnsub: (() => void) | null = null;
  private _onVisibilityChange: (() => void) | null = null;
  private _onFavoritesChanged: (() => void) | null = null;
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
      display: flex;
      align-items: center;
      gap: 16px;
      min-width: 0;
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
      display: flex;
      gap: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .panel-tabs::-webkit-scrollbar {
      display: none;
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

    this._onFavoritesChanged = (): void => {
      this._refreshFavorites();
    };
    document.addEventListener(FAVORITES_CHANGED_EVENT, this._onFavoritesChanged);

    this._subscribeDeviceRegistry();
  }

  disconnectedCallback(): void {
    this._dashboardTab.stop();
    this._monitoringTab.stop();
    this._listCtrl.stop();
    this._listDashCtrl.stopIntervals();
    for (const tab of this._favoritesMonitoringTabs.values()) tab.stop();
    this._favoritesMonitoringTabs.clear();
    if (this._areaUnsub) {
      this._areaUnsub();
      this._areaUnsub = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
    if (this._onFavoritesChanged) {
      document.removeEventListener(FAVORITES_CHANGED_EVENT, this._onFavoritesChanged);
      this._onFavoritesChanged = null;
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

    // Render tab content when discovery completes or active tab/panel/metric changes
    if (
      this._discovered &&
      (changedProps.has("_discovered") || changedProps.has("_activeTab") || changedProps.has("_selectedPanelId") || changedProps.has("_chartMetric"))
    ) {
      this._scheduleTabRender();
    }

    // Keep the <select> visually synced with ``_selectedPanelId``.
    // When the options list is rebuilt (e.g. Favorites entry prepended),
    // the browser's ``select.value`` can stick to the previous value or
    // silently slide to the first option, which is wrong when Favorites
    // is prepended or removed. Force the property every update.
    if (this._discovered && (changedProps.has("_panels") || changedProps.has("_selectedPanelId"))) {
      const selectEl = this.shadowRoot?.getElementById("panel-select") as HTMLSelectElement | null;
      if (selectEl && this._selectedPanelId !== null && selectEl.value !== this._selectedPanelId) {
        selectEl.value = this._selectedPanelId;
      }
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

    // ``ha-menu-button`` reads ``this.hass.kioskMode`` in its willUpdate;
    // creating it before HA has assigned ``hass`` throws. Render a bare
    // shell until hass arrives — the ``hass`` setter will request a new
    // render via Lit reactivity once HA injects the property.
    if (!this.hass) {
      return html`
        <div class="header">
          <div class="toolbar">
            <div class="main-title">Span Panel</div>
          </div>
        </div>
        <div class="view">
          <div class="view-content" style="padding: 24px; color: var(--secondary-text-color);">${"Loading\u2026"}</div>
        </div>
      `;
    }

    if (!this._discovered) {
      return html`
        <div class="header">
          <div class="toolbar">
            <ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>
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
          <ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>
          <div class="main-title">
            <span class="panel-selector">
              <select id="panel-select" @change=${this._onPanelChange}>
                ${this._panels.map(p => html` <option value=${p.id} ?selected=${p.id === this._selectedPanelId}>${p.name_by_user || p.name || p.id}</option> `)}
              </select>
            </span>
            <div class="panel-tabs" @click=${this._onTabClick}>${unsafeHTML(buildTabBarHTML(this._buildTabList(), this._activeTab, "text"))}</div>
          </div>
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
            @favorites-view-state-changed=${this._onFavoritesViewStateChangedEvent}
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
    // The Favorites pseudo-panel has no "By Panel" tab, so re-route away
    // from it when the user lands on favorites with that tab active.
    if (this._isFavoritesView && this._activeTab === "dashboard") {
      this._activeTab = "activity";
    }
    if (this._areaUnsub) {
      this._areaUnsub();
      this._areaUnsub = null;
    }
    this._scheduleTabRender();
  }

  private get _isFavoritesView(): boolean {
    return this._selectedPanelId === FAVORITES_PANEL_ID;
  }

  private _onTabClick(e: Event): void {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>(".shared-tab");
    if (!btn) return;
    const tab = btn.dataset.tab as TabName | undefined;
    if (!tab || tab === this._activeTab) return;
    this._activeTab = tab;
    if (this._isFavoritesView && tab !== "dashboard") {
      this._favoritesViewState.activeTab = tab;
      _saveFavoritesViewState(this._favoritesViewState);
    }
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

  private _onFavoritesViewStateChangedEvent(ev: Event): void {
    if (!this._isFavoritesView) return;
    const detail = (ev as CustomEvent<FavoritesViewStateDetail>).detail;
    if (!detail) return;
    const viewState = this._favoritesViewState;
    viewState.activeTab = detail.view;
    // Prune expansion ids to those still present in the merged topology.
    const valid = this._listDashCtrl.topology?.circuits ?? {};
    viewState.expanded[detail.view] = detail.expanded.filter(id => id in valid);
    viewState.searchQuery = detail.searchQuery;
    _saveFavoritesViewState(viewState);
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
    const realPanels = devices.filter((d: PanelDevice) => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);

    const prevRealIds = new Set(this._panels.filter(p => p.id !== FAVORITES_PANEL_ID).map(p => p.id));
    const newRealIds = new Set(realPanels.map(p => p.id));
    const realChanged = prevRealIds.size !== newRealIds.size || [...prevRealIds].some(id => !newRealIds.has(id));
    if (!realChanged) return;

    this._panels = this._buildPanelList(realPanels, this._favorites);
    if (!this._panels.some(p => p.id === this._selectedPanelId) && this._panels.length > 0) {
      const firstReal = realPanels[0];
      if (firstReal) {
        this._selectedPanelId = firstReal.id;
        localStorage.setItem("span_panel_selected", this._selectedPanelId);
      }
    }
  }

  private async _discoverPanels(): Promise<void> {
    if (!this.hass) return;

    let realPanels: PanelDevice[];
    try {
      const devices = await this.hass.callWS<PanelDevice[]>({
        type: "config/device_registry/list",
      });
      realPanels = devices.filter((d: PanelDevice) => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);
    } catch (err) {
      console.error("SPAN Panel: device discovery failed", err);
      this._discoveryError = `Discovery failed: ${(err as Error).message ?? err}`;
      return;
    }

    this._favorites = await this._loadFavorites();
    this._panels = this._buildPanelList(realPanels, this._favorites);
    this._favoritesViewState = _loadFavoritesViewState();

    this._discoveryError = null;
    this._discovered = true;

    const stored = localStorage.getItem("span_panel_selected");
    if (stored && this._panels.some(p => p.id === stored)) {
      this._selectedPanelId = stored;
    } else if (realPanels.length > 0) {
      this._selectedPanelId = realPanels[0]!.id;
    }

    // Restore the user's favorites tab when re-entering the pseudo-panel.
    if (this._selectedPanelId === FAVORITES_PANEL_ID) {
      const restoredTab = this._favoritesViewState.activeTab;
      if (restoredTab === "activity" || restoredTab === "area" || restoredTab === "monitoring") {
        this._activeTab = restoredTab;
      } else if (this._activeTab === "dashboard") {
        this._activeTab = "activity";
      }
    }

    this._chartMetric = localStorage.getItem("span_panel_metric") || "power";
  }

  /**
   * Build the dropdown list, optionally prepending a synthetic Favorites
   * entry when at least one favorite is configured.
   */
  private _buildPanelList(realPanels: PanelDevice[], favorites: FavoritesMap): PanelDevice[] {
    if (!hasAnyFavorites(favorites)) return realPanels;
    const favoritesEntry: PanelDevice = {
      id: FAVORITES_PANEL_ID,
      name: t("panel.favorites"),
      model: "__favorites__",
    };
    return [favoritesEntry, ...realPanels];
  }

  private async _loadFavorites(): Promise<FavoritesMap> {
    if (!this.hass) return {};
    try {
      return await this._favCache.fetch(this.hass);
    } catch (err) {
      console.warn("SPAN Panel: favorites fetch failed", err);
      return {};
    }
  }

  /**
   * React to a ``favorites-changed`` event dispatched by a heart toggle
   * in the side panel. Re-fetches the favorites map and updates the
   * dropdown entry. Re-renders the tab only when needed:
   *
   * - Favorites view: always re-render so removed targets disappear
   *   immediately. The open side panel is destroyed as a side effect,
   *   which is acceptable UX since the user just un-favorited the
   *   target they were inspecting.
   * - Real panel view: skip the re-render so the open Graph Settings
   *   side panel stays interactive while the user toggles hearts on
   *   multiple targets in a row.
   */
  private async _refreshFavorites(): Promise<void> {
    const myToken = ++this._refreshSeq;
    this._favCache.invalidate();
    const favorites = await this._loadFavorites();
    // Bail out if a newer refresh has superseded us — its reload + render
    // will land with the latest data; don't double-render or fight it.
    if (myToken !== this._refreshSeq) return;
    const wasOnFavorites = this._selectedPanelId === FAVORITES_PANEL_ID;
    this._favorites = favorites;

    const realPanels = this._panels.filter(p => p.id !== FAVORITES_PANEL_ID);
    this._panels = this._buildPanelList(realPanels, favorites);

    if (wasOnFavorites && !hasAnyFavorites(favorites)) {
      // Last favorite removed — fall back to the first real panel and
      // drop the persisted Favorites view state so a fresh return opens
      // with defaults. The selectedPanelId change reactively re-renders
      // the tab content via ``updated()``.
      _clearFavoritesViewState();
      this._favoritesViewState = _defaultFavoritesViewState();
      const fallback = realPanels[0];
      if (fallback) {
        this._selectedPanelId = fallback.id;
        localStorage.setItem("span_panel_selected", fallback.id);
      } else {
        this._selectedPanelId = null;
      }
    } else if (this._isFavoritesView) {
      // Re-render the favorites view so newly un-favorited rows /
      // sub-device tiles are removed from the list.
      this._scheduleTabRender();
    } else {
      // Keep per-panel favorites fresh so the next gear click (or a
      // re-opened side panel) reflects the current heart state.
      this._applyPanelFavorites();
    }
  }

  /**
   * Build the tab list for the current panel selection. The Favorites
   * pseudo-panel drops "By Panel" because its merged topology has no
   * physical breaker grid to render.
   */
  private _buildTabList(): { id: string; label: string; icon: string }[] {
    const tabs: { id: string; label: string; icon: string }[] = [];
    if (!this._isFavoritesView) {
      tabs.push({ id: "dashboard", label: t("tab.by_panel"), icon: "mdi:view-dashboard" });
    }
    tabs.push(
      { id: "activity", label: t("tab.by_activity"), icon: "mdi:sort-descending" },
      { id: "area", label: t("tab.by_area"), icon: "mdi:home-group" },
      { id: "monitoring", label: t("tab.monitoring"), icon: "mdi:monitor-eye" }
    );
    return tabs;
  }

  /**
   * Build the persistent panel-stats header HTML for the current real
   * panel, including the slide-to-confirm switches control so tappable
   * ON/OFF badges in list views require explicit user arming.
   */
  private _buildCurrentPanelHeaderHTML(topology: PanelTopology, config: CardConfig): string {
    return buildHeaderHTML(topology, config);
  }

  /**
   * Build a minimal summary strip for the Favorites pseudo-panel. The
   * aggregate has no panel-level stats to render, so we surface the
   * circuit + panel counts and the W/A unit toggle (since the list view
   * no longer renders its own — the persistent header owns it).
   */
  private _buildFavoritesSummaryHTML(): string {
    const isAmpsMode = (this._chartMetric || "power") === "current";
    return `
      <div class="favorites-summary" style="padding:8px 24px;border-bottom:1px solid var(--divider-color,#e0e0e0);display:flex;align-items:center;justify-content:flex-end;">
        <div class="unit-toggle" title="${escapeHtml(t("header.toggle_units"))}">
          <button class="unit-btn ${isAmpsMode ? "" : "unit-active"}" data-unit="power">W</button>
          <button class="unit-btn ${isAmpsMode ? "unit-active" : ""}" data-unit="current">A</button>
        </div>
      </div>
    `;
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
    for (const tab of this._favoritesMonitoringTabs.values()) tab.stop();
    this._favoritesMonitoringTabs.clear();

    const container = this.shadowRoot!.getElementById("tab-content");
    if (!container) return;

    if (this._isFavoritesView) {
      await this._renderFavoritesTab(container);
      return;
    }

    this._listDashCtrl.clearFavoriteRefs();
    this._listCtrl.setViewName(null);
    this._applyPanelFavorites();

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
          const headerHTML = result.topology ? this._buildCurrentPanelHeaderHTML(result.topology, config) : "";
          this._listCtrl.renderActivityView(container, this.hass, result.topology!, config, this._listDashCtrl.monitoringCache.status, headerHTML);
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
          const headerHTML = result.topology ? this._buildCurrentPanelHeaderHTML(result.topology, config) : "";
          this._listCtrl.renderAreaView(container, this.hass, result.topology!, config, this._listDashCtrl.monitoringCache.status, headerHTML);
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
        // Monitoring is a pure configuration view — no panel-stats header.
        await this._monitoringTab.render(container, this.hass, monEntryId ?? undefined);
        break;
      }
    }
  }

  /**
   * Render the Favorites pseudo-panel for the current active tab.
   * Skips the "By Panel" tab entirely — that tab is filtered out of the
   * tab bar and ``_onPanelChange`` auto-reroutes to Activity when the
   * user switches panels while it was active.
   */
  private async _renderFavoritesTab(container: HTMLElement): Promise<void> {
    if (this._activeTab === "dashboard") this._activeTab = "activity";

    container.innerHTML = "";
    if (!this.hass) return;

    const realPanels = this._panels.filter(p => p.id !== FAVORITES_PANEL_ID);
    const build = await this._favCtrl.build(this.hass, this._favorites, realPanels);
    const merged = build.topology;
    const primaryEntryId = build.entryIds[0] ?? null;

    const hasCircuits = Object.keys(merged.circuits).length > 0;
    const hasSubDevices = Object.keys(merged.sub_devices ?? {}).length > 0;
    if (!hasCircuits && !hasSubDevices) {
      const empty = document.createElement("p");
      empty.style.color = "var(--secondary-text-color)";
      empty.style.padding = "24px";
      empty.textContent = t("list.no_results");
      container.appendChild(empty);
      return;
    }

    this._listDashCtrl.setFavoriteRefs(merged._favoriteRefs);
    this._listDashCtrl.setPanelFavorites(null);

    if (this._activeTab === "monitoring") {
      this._listCtrl.setViewName(null);
      await this._renderFavoritesMonitoring(container, build.entryIds, realPanels);
      return;
    }

    const viewName = this._activeTab as "activity" | "area";
    const validCircuitIds = new Set(Object.keys(merged.circuits));
    const storedExpanded = this._favoritesViewState.expanded[viewName].filter(id => validCircuitIds.has(id));
    this._listCtrl.setViewName(viewName);
    this._listCtrl.setInitialExpansion(storedExpanded);
    this._listCtrl.setInitialSearchQuery(this._favoritesViewState.searchQuery ?? "");

    const config = this._buildDashboardConfig();
    this._listDashCtrl.init(merged, config, this.hass, primaryEntryId);
    await this._listDashCtrl.fetchAndBuildHorizonMaps();
    const monitoringStatus = await this._listDashCtrl.fetchMergedMonitoringStatus(build.entryIds);

    const summaryHTML = this._buildFavoritesSummaryHTML();
    const subDevicesHTML = hasSubDevices
      ? `<div class="favorites-subdevices-section" style="padding:8px 16px 0;">
           <div class="sub-devices">${buildSubDevicesHTML(merged, this.hass, config)}</div>
         </div>`
      : "";
    const headerHTML = summaryHTML + subDevicesHTML;
    try {
      if (viewName === "activity") {
        this._listCtrl.renderActivityView(container, this.hass, merged as FavoritesTopology, config, monitoringStatus, headerHTML);
      } else {
        this._listCtrl.renderAreaView(container, this.hass, merged as FavoritesTopology, config, monitoringStatus, headerHTML);
      }
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
  }

  private async _renderFavoritesMonitoring(container: HTMLElement, entryIds: string[], realPanels: PanelDevice[]): Promise<void> {
    if (!this.hass) return;

    container.insertAdjacentHTML("beforeend", this._buildFavoritesSummaryHTML());

    const wrapper = document.createElement("div");
    wrapper.className = "favorites-monitoring-stack";
    container.appendChild(wrapper);

    const panelsByEntry = new Map<string, PanelDevice>();
    for (const panel of realPanels) {
      const eid = panel.config_entries?.[0];
      if (eid) panelsByEntry.set(eid, panel);
    }

    // Build into a local map and only assign to the instance field after
    // every render attempts so a single failure can't orphan tabs that
    // _renderTab's cleanup loop never sees.
    const tabs = new Map<string, MonitoringTab>();
    for (const entryId of entryIds) {
      const panel = panelsByEntry.get(entryId);
      const block = document.createElement("div");
      block.className = "favorites-monitoring-block";
      block.style.marginBottom = "24px";

      const heading = document.createElement("h2");
      heading.style.margin = "8px 0 12px";
      heading.style.fontSize = "1em";
      heading.textContent = panel?.name_by_user ?? panel?.name ?? entryId;
      block.appendChild(heading);

      const body = document.createElement("div");
      block.appendChild(body);
      wrapper.appendChild(block);

      const tab = new MonitoringTab();
      tabs.set(entryId, tab);
      try {
        await tab.render(body, this.hass, entryId);
      } catch (err) {
        console.warn("SPAN Panel: favorites monitoring render failed", entryId, err);
        const errEl = document.createElement("p");
        errEl.style.color = "var(--error-color)";
        errEl.textContent = (err as Error).message ?? String(err);
        body.appendChild(errEl);
      }
    }
    this._favoritesMonitoringTabs = tabs;
  }

  /**
   * For real-panel renders, push the current panel's favorited circuit
   * uuids and sub-device ids into the shared list controller so hearts
   * render with the right fill state when a side panel opens from any
   * gear click on the dashboard.
   */
  private _applyPanelFavorites(): void {
    if (!this._selectedPanelId || this._isFavoritesView) {
      this._listDashCtrl.setPanelFavorites(null);
      this._dashboardTab.setPanelFavorites(null);
      return;
    }
    const entry = this._favorites[this._selectedPanelId];
    const info = {
      panelDeviceId: this._selectedPanelId,
      circuitUuids: new Set(entry?.circuits ?? []),
      subDeviceIds: new Set(entry?.sub_devices ?? []),
    };
    this._listDashCtrl.setPanelFavorites(info);
    this._dashboardTab.setPanelFavorites(info);
  }
}
