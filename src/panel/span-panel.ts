import { LitElement, html, css, nothing, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { INTEGRATION_DOMAIN } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import { ErrorStore } from "../core/error-store.js";
import "../core/side-panel.js";
import "../core/error-banner.js";
import { DashboardTab } from "./tab-dashboard.js";
import { MonitoringTab } from "./tab-monitoring.js";
import { ListViewController, type FavoritesViewStateDetail } from "../core/list-view-controller.js";
import { DashboardController } from "../core/dashboard-controller.js";
import { buildTabBarHTML } from "../core/tab-bar-renderer.js";
import { subscribeAreaUpdates } from "../core/area-resolver.js";
import { discoverTopology } from "../card/card-discovery.js";
import { RetryManager } from "../core/retry-manager.js";
import { buildHeaderHTML, buildPanelStatsHTML } from "../core/header-renderer.js";
import { updatePanelStatsBlock } from "../core/dom-updater.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { loadListColumns, saveListColumns } from "../helpers/list-columns.js";
import { attrSelectorValue } from "../helpers/selector.js";
import { CARD_STYLES } from "../card/card-styles.js";
import { FAVORITES_CHANGED_EVENT, FavoritesCache, hasAnyFavorites } from "../core/favorites-store.js";
import { FavoritesController, type FavoritesPanelStatsInfo } from "../core/favorites-controller.js";
import {
  clearFavoritesViewState,
  defaultFavoritesViewState,
  loadFavoritesViewState,
  saveFavoritesViewState,
  type FavoritesViewState,
} from "./favorites-view-state.js";
import { buildFavoritesSummaryHTML } from "./favorites-summary.js";
import { coalesceRuns, makeRenderToken } from "./coalesce.js";
import type { FavoritesPanelInfo } from "../core/favorites-sections.js";
import type { CardConfig, FavoritesMap, FavoritesTopology, HomeAssistant, PanelDevice } from "../types.js";

const FAVORITES_PANEL_ID = "favorites";

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
  @state() private _chartMetric: string | undefined;
  @state() private _listColumns: number = loadListColumns();
  @state() private _favorites: FavoritesMap = {};

  private _favoritesViewState: FavoritesViewState = defaultFavoritesViewState();
  /**
   * Per-contributing-panel stats snapshot for the active Favorites
   * render. Populated from ``FavoritesController.build`` and consumed
   * by ``_updateFavoritesPanelStats`` on each interval tick so every
   * per-panel stats block can read from the correct panel's entities.
   */
  private _favoritesPanelStats: FavoritesPanelStatsInfo[] = [];

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
  private readonly _errorStore = new ErrorStore();
  private _watchedPanelId: string | null = null;
  private _discovering = false;
  /**
   * Monotonic token incremented on each ``_refreshFavorites`` call.
   * Concurrent invocations (rapid heart toggles → multiple
   * ``favorites-changed`` events) compare their token against the latest
   * after each await; superseded callbacks bail out without touching
   * state or scheduling another tab render.
   */
  private _refreshSeq = 0;
  private _areaUnsub: (() => void) | null = null;
  /** Cleared on disconnect to tell a pending subscribe to self-cancel. */
  private _areaSubscribing = false;
  private _onVisibilityChange: (() => void) | null = null;
  private _onFavoritesChanged: (() => void) | null = null;
  private _deviceRegistryUnsub: Promise<() => void> | null = null;
  /**
   * True when a tab re-render was requested while any sidebar (favorites
   * mode, real-panel gear mode, per-circuit, or sub-device) was open.
   * `_onSidePanelClosed` consumes the flag and fires the deferred render
   * so the main view catches up to the changes (un-favorited rows, new
   * column count, horizon edits) the user made inside the sidebar.
   */
  private _pendingTabRender = false;
  /**
   * Pending retry timer for ``_recoverIfNeeded``. Cleared on disconnect
   * so a delayed retry cannot fire against a detached element after HA
   * has torn down the panel.
   */
  private _recoverTimer: ReturnType<typeof setTimeout> | null = null;

  private static _shellStyles = css`
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

  /**
   * CARD_STYLES carries the ~700-line stylesheet shared with the
   * Lovelace card (list rows, breaker-grid slots, toggle pill, side
   * panel, etc.). Emit it once via Lit's static styles (scoped to the
   * shadow root) instead of re-injecting it per tab render.
   */
  static override styles = [SpanPanelElement._shellStyles, unsafeCSS(CARD_STYLES)];

  /**
   * Centralised accessor for the shadow root. LitElement guarantees it
   * for any connected component; if it's missing we've hit SSR or a
   * teardown race, both of which should fail loudly rather than be
   * silently bypassed with sprinkled ``!`` assertions.
   */
  private get _root(): ShadowRoot {
    const root = this.shadowRoot;
    if (!root) throw new Error("span-panel: shadow root is not available");
    return root;
  }

  connectedCallback(): void {
    super.connectedCallback();

    this._dashboardTab.errorStore = this._errorStore;
    this._listDashCtrl.errorStore = this._errorStore;
    this._favCache.errorStore = this._errorStore;
    this._monitoringTab.errorStore = this._errorStore;

    this._onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible" || !this._discovered || !this.hass) return;
      this._recoverIfNeeded();
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
    this._areaSubscribing = false;
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
    if (this._persistFavoritesViewStateTimer) {
      clearTimeout(this._persistFavoritesViewStateTimer);
      this._persistFavoritesViewStateTimer = null;
    }
    if (this._recoverTimer) {
      clearTimeout(this._recoverTimer);
      this._recoverTimer = null;
    }
    this._errorStore.dispose();
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
      this._errorStore.updateHass(this.hass);

      if (!this._discovered) {
        this._discoverPanels();
      } else if (!this._root.getElementById("tab-content")) {
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
      (changedProps.has("_discovered") ||
        changedProps.has("_activeTab") ||
        changedProps.has("_selectedPanelId") ||
        changedProps.has("_chartMetric") ||
        changedProps.has("_listColumns"))
    ) {
      // Defensive normalization: the Favorites pseudo-panel has no
      // "By Panel" tab. ``_onPanelChange`` and ``_discoverPanels``
      // redirect when they switch into Favorites, but an external
      // navigate-tab event or a stale state could still land here —
      // coerce to the Activity tab and let the resulting state change
      // schedule the single render.
      if (this._isFavoritesView && this._activeTab === "dashboard") {
        this._activeTab = "activity";
        return;
      }
      this._scheduleTabRender();
    }

    if (changedProps.has("_selectedPanelId")) {
      if (this._selectedPanelId === FAVORITES_PANEL_ID || !this._selectedPanelId) {
        // Favorites pseudo-panel has no panel_status — clear the watch
        this._errorStore.clearPanelStatusWatch();
        this._watchedPanelId = null;
      } else {
        this._updatePanelStatusWatch();
        // Leaving Favorites for a real panel — clear stale per-panel metadata
        // so an accidental gear click before the new per-panel render finishes
        // cannot open a favorites-mode sidebar with stale data.
        this._listDashCtrl.setFavoritesPerPanelInfo(null);
      }
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
      const tabContent = this._root.getElementById("tab-content");
      const topo = this._listDashCtrl.topology;
      if (tabContent && topo) {
        this._listCtrl.updateCollapsedRows(tabContent, this.hass, topo, this._buildDashboardConfig());
        const sidePanel = tabContent.querySelector("span-side-panel") as { hass: HomeAssistant; errorStore: ErrorStore | null } | null;
        if (sidePanel) {
          sidePanel.hass = this.hass;
          sidePanel.errorStore = this._errorStore;
        }
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
          <div class="view-content" style="padding: 24px; color: var(--secondary-text-color);">${t("card.connecting")}</div>
        </div>
      `;
    }

    if (!this._discovered) {
      const hasError = this._errorStore.hasPersistent("discovery-failed");
      return html`
        <div class="header">
          <div class="toolbar">
            <ha-menu-button .hass=${this.hass} .narrow=${this.narrow}></ha-menu-button>
            <div class="main-title">Span Panel</div>
          </div>
        </div>
        <div class="view">
          <span-error-banner .store=${this._errorStore}></span-error-banner>
          ${hasError ? nothing : html`<div class="view-content" style="padding: 24px; color: var(--secondary-text-color);">${t("card.connecting")}</div>`}
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
        <span-error-banner .store=${this._errorStore}></span-error-banner>
        <div class="view-content">
          <div
            class="tab-content"
            id="tab-content"
            @click=${this._onTabContentClick}
            @unit-changed=${this._onUnitChanged}
            @side-panel-closed=${this._onSidePanelClosed}
            @graph-settings-changed=${this._onGraphSettingsChanged}
            @list-columns-changed=${this._onListColumnsChanged}
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
    this._areaSubscribing = false;
    if (this._areaUnsub) {
      this._areaUnsub();
      this._areaUnsub = null;
    }
    // Reactive updated() handles the re-render via _selectedPanelId
    // (and possibly _activeTab) changes.
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
      saveFavoritesViewState(this._favoritesViewState);
    }
    // No explicit _scheduleTabRender — Lit's updated() sees
    // _activeTab change and schedules the render. Calling here too
    // would kick off two concurrent renders and produce flashing.
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
      // Reactive updated() handles the re-render; see _onTabClick.
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
    // The Favorites view uses the multi-entry cache for monitoring; if
    // the side panel adjusted any settings, freshen those too.
    this._listDashCtrl.monitoringMultiCache.invalidate();
    // Replay any tab render that was deferred while the sidebar was open
    // (heart toggle or list-columns change inside a favorites-mode sidebar).
    if (this._pendingTabRender) {
      this._pendingTabRender = false;
      this._scheduleTabRender();
    }
  }

  private _onUnitChanged(e: Event): void {
    const unit = (e as CustomEvent<string>).detail;
    if (!unit || unit === this._chartMetric) return;
    this._chartMetric = unit;
    localStorage.setItem("span_panel_metric", unit);
    // Reactive updated() handles the re-render.
  }

  private _onListColumnsChanged(e: Event): void {
    const n = (e as CustomEvent<number>).detail;
    if (typeof n !== "number" || (n !== 1 && n !== 2 && n !== 3) || n === this._listColumns) return;
    this._listColumns = n;
    saveListColumns(n);
    // Reactive updated() handles the re-render.
  }

  private _onGraphSettingsChanged(): void {
    if (this._activeTab === "dashboard") {
      const container = this._root.getElementById("tab-content");
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
    // Reactive updated() handles the re-render.
  }

  private _persistFavoritesViewStateTimer: ReturnType<typeof setTimeout> | null = null;

  private _onFavoritesViewStateChangedEvent(ev: Event): void {
    if (!this._isFavoritesView) return;
    const detail = (ev as CustomEvent<FavoritesViewStateDetail>).detail;
    if (!detail) return;
    const viewState = this._favoritesViewState;
    viewState.activeTab = detail.view;
    // Prune expansion ids to those still present in the merged topology,
    // but only if we actually have a topology to prune against. An empty
    // ``circuits`` map here usually means the Favorites tab is still
    // re-rendering after a search keystroke; pruning against {} would
    // drop every expansion and the user would lose their open rows.
    const topology = this._listDashCtrl.topology;
    const circuits = topology?.circuits;
    if (circuits && Object.keys(circuits).length > 0) {
      viewState.expanded[detail.view] = detail.expanded.filter(id => id in circuits);
    } else {
      viewState.expanded[detail.view] = detail.expanded;
    }
    viewState.searchQuery = detail.searchQuery;

    // Search-box updates fire on every keystroke; expansion and tab
    // switches are discrete. Debounce localStorage writes so typing a
    // long query doesn't thrash storage.
    if (this._persistFavoritesViewStateTimer) {
      clearTimeout(this._persistFavoritesViewStateTimer);
    }
    this._persistFavoritesViewStateTimer = setTimeout(() => {
      this._persistFavoritesViewStateTimer = null;
      saveFavoritesViewState(viewState);
    }, 250);
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

    const prevPanels = this._panels.filter(p => p.id !== FAVORITES_PANEL_ID);
    const prevById = new Map(prevPanels.map(p => [p.id, p]));
    const newIds = new Set(realPanels.map(p => p.id));
    const idsChanged = prevById.size !== newIds.size || [...prevById.keys()].some(id => !newIds.has(id));
    // Also detect renames so the dropdown reflects user-facing panel
    // renames without requiring a reload. We compare both ``name`` and
    // ``name_by_user`` because HA surfaces either depending on setup.
    const namesChanged =
      !idsChanged &&
      realPanels.some(next => {
        const prev = prevById.get(next.id);
        if (!prev) return false;
        return prev.name !== next.name || prev.name_by_user !== next.name_by_user;
      });
    if (!idsChanged && !namesChanged) return;

    this._panels = this._buildPanelList(realPanels, this._favorites);
    if (!this._panels.some(p => p.id === this._selectedPanelId) && this._panels.length > 0) {
      const firstReal = realPanels[0];
      if (firstReal) {
        this._selectedPanelId = firstReal.id;
        localStorage.setItem("span_panel_selected", this._selectedPanelId);
      }
    }
  }

  private async _updatePanelStatusWatch(): Promise<void> {
    if (!this.hass || !this._selectedPanelId) return;
    if (this._selectedPanelId === FAVORITES_PANEL_ID) return;
    if (this._watchedPanelId === this._selectedPanelId) return;

    const targetPanelId = this._selectedPanelId;
    this._watchedPanelId = targetPanelId;
    try {
      const retry = new RetryManager(this._errorStore);
      const result = await discoverTopology(this.hass, targetPanelId, retry);
      // Guard against supersession: user may have switched panels during fetch.
      if (this._selectedPanelId !== targetPanelId) return;
      const entityId = result.topology?.panel_entities?.panel_status;
      if (entityId) {
        this._errorStore.watchPanelStatus(entityId);
        this._errorStore.updateHass(this.hass);
      }
    } catch (err) {
      console.warn("SPAN Panel: unable to fetch topology for panel status watching", err);
      // Reset so a retry (e.g., user re-selects same panel) can attempt the fetch again.
      if (this._watchedPanelId === targetPanelId) {
        this._watchedPanelId = null;
      }
    }
  }

  private async _discoverPanels(): Promise<void> {
    if (this._discovering) return;
    if (!this.hass) return;
    this._discovering = true;
    try {
      let realPanels: PanelDevice[];
      try {
        const retry = new RetryManager(this._errorStore);
        const devices = await retry.callWS<PanelDevice[]>(
          this.hass,
          { type: "config/device_registry/list" },
          {
            errorId: "fetch:topology",
          }
        );
        realPanels = devices.filter((d: PanelDevice) => d.identifiers?.some(id => id[0] === INTEGRATION_DOMAIN) && !d.via_device_id);
      } catch (err) {
        console.error("SPAN Panel: device discovery failed", err);
        this._errorStore.add({
          key: "discovery-failed",
          level: "error",
          message: t("error.discovery_failed"),
          persistent: true,
          retryFn: () => {
            this._errorStore.remove("discovery-failed");
            this._discoverPanels();
          },
        });
        return;
      }

      this._favorites = await this._loadFavorites();
      this._panels = this._buildPanelList(realPanels, this._favorites);
      this._favoritesViewState = loadFavoritesViewState();

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
    } finally {
      this._discovering = false;
    }
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
    return this._favCache.fetch(this.hass);
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
      clearFavoritesViewState();
      this._favoritesViewState = defaultFavoritesViewState();
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
   * Build the Favorites view summary strip — gear icon, slide-to-arm
   * control, shedding legend, and W/A unit toggle. Styles live in
   * ``CARD_STYLES`` under ``.favorites-summary`` +
   * ``.favorites-summary-right``. The actual HTML is produced by the
   * pure ``buildFavoritesSummaryHTML`` helper in
   * ``src/panel/favorites-summary.ts`` so it can be unit-tested
   * without a DOM; this wrapper just threads the current amps-mode
   * flag through.
   */
  private _buildFavoritesSummaryHTML(): string {
    const isAmpsMode = (this._chartMetric || "power") === "current";
    return buildFavoritesSummaryHTML(isAmpsMode);
  }

  /**
   * Render a responsive grid of per-contributing-panel status cards
   * (Site/Grid/Upstream/Downstream/Solar/Battery). Auto-fits 1-3
   * columns based on viewport width. Live values are filled in by
   * ``_updateFavoritesPanelStats`` on each interval tick.
   */
  private _buildFavoritesPanelStatsGridHTML(perPanelStats: FavoritesPanelStatsInfo[], config: CardConfig): string {
    if (perPanelStats.length === 0) return "";
    const cards = perPanelStats
      .map(
        info => `
      <div class="favorites-panel-card">
        <div class="favorites-panel-card-title">${escapeHtml(info.panelName || info.topology.device_name || "")}</div>
        ${buildPanelStatsHTML(info.topology, config, info.panelDeviceId)}
      </div>
    `
      )
      .join("");
    return `<div class="favorites-panel-stats-grid">${cards}</div>`;
  }

  /**
   * Update each per-panel stats block in the Favorites view from its
   * originating panel's entities. Runs on startIntervals ticks so the
   * Site/Grid/Upstream/... values stay live.
   */
  private _updateFavoritesPanelStats(container: HTMLElement, config: CardConfig): void {
    if (!this.hass || this._favoritesPanelStats.length === 0) return;
    for (const info of this._favoritesPanelStats) {
      const block = container.querySelector(`.panel-stats[data-stats-panel-id="${attrSelectorValue(info.panelDeviceId)}"]`);
      if (!block) continue;
      updatePanelStatsBlock(block, this.hass, info.topology, config, 0);
    }
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

  /**
   * Coalesces concurrent tab-render requests so at most one render is
   * in-flight at a time, with exactly one follow-up if more requests
   * arrived while the current one was running.
   */
  private readonly _tabRenderScheduler = coalesceRuns(async () => this._renderTab());

  /**
   * Monotonic render-token factory. Each call to the returned function
   * increments the counter and returns a ``superseded()`` predicate that
   * tells a render branch whether it has been overtaken by a later render.
   */
  private readonly _beginRender = makeRenderToken();

  /**
   * Visibility-restore recovery. When the browser tab is backgrounded
   * and HA's WebSocket drops/reconnects, a tab re-render kicked off on
   * ``visibilitychange`` can silently bail out mid-flight — a WS call
   * resolving empty, a supersession race, or a cache returning null
   * without throwing — and the Favorites view in particular is left
   * with a blank ``#tab-content`` because it clears the container
   * before awaiting its async build steps.
   *
   * Wrap ``_scheduleTabRender`` in a try/catch **and** verify the
   * container produced content afterwards; if either fails, retry
   * with backoff so the render can catch a freshly-reconnected WS.
   * Mirrors the pre-LitElement ``_recoverIfNeeded`` helper removed
   * during the c4154d2 refactor.
   */
  private async _recoverIfNeeded(attempt = 0): Promise<void> {
    if (!this._discovered || !this.hass) return;
    const MAX_ATTEMPTS = 3;
    const BACKOFF_BASE_MS = 2000;

    const scheduleRetry = (): void => {
      if (attempt >= MAX_ATTEMPTS) return;
      if (this._recoverTimer) clearTimeout(this._recoverTimer);
      this._recoverTimer = setTimeout(
        () => {
          this._recoverTimer = null;
          this._recoverIfNeeded(attempt + 1);
        },
        BACKOFF_BASE_MS * (attempt + 1)
      );
    };

    try {
      await this._scheduleTabRender();
    } catch {
      scheduleRetry();
      return;
    }

    // A render that completed without throwing but left the tab
    // container empty is the symptom we are recovering from. Every
    // successful render path produces at least one child node — the
    // empty-favorites state appends a ``<p>`` with ``list.no_results``,
    // the error paths append a ``<p>`` with the error message, and the
    // normal dashboard/activity/area/monitoring renders produce their
    // respective headers/grids. Zero children means a silent bailout.
    const container = this._root.getElementById("tab-content");
    if (container && container.childNodes.length === 0) {
      scheduleRetry();
    }
  }

  /**
   * Coalesce tab-render requests. If a render is in-flight, remember
   * that another was requested and run exactly one follow-up once the
   * current render completes. Running two ``_renderTab`` calls
   * concurrently causes the tab container to be cleared and rewritten
   * twice in rapid succession, which is visible as flashing.
   */
  private async _scheduleTabRender(): Promise<void> {
    await this.updateComplete;
    // While any sidebar is open, a tab re-render would wipe
    // `#tab-content` and destroy the live sidebar. Defer the render until
    // the sidebar closes (handled by `_onSidePanelClosed`). A modal
    // backdrop prevents tab/panel clicks while the sidebar is open, so
    // only sidebar-originated state changes (heart toggle, list-columns
    // change, horizon edit) take this path. Covers both favorites-mode
    // and real-panel-mode sidebars — any open sidebar qualifies.
    if (this._sidePanelOpen()) {
      this._pendingTabRender = true;
      return;
    }
    await this._tabRenderScheduler();
  }

  private _sidePanelOpen(): boolean {
    const container = this.shadowRoot?.getElementById("tab-content");
    return !!container?.querySelector("span-side-panel[open]");
  }

  private async _renderTab(): Promise<void> {
    const superseded = this._beginRender();

    this._dashboardTab.stop();
    this._monitoringTab.stop();
    this._listCtrl.stop();
    this._listDashCtrl.stopIntervals();
    for (const tab of this._favoritesMonitoringTabs.values()) tab.stop();
    this._favoritesMonitoringTabs.clear();
    this._favoritesPanelStats = [];

    const container = this._root.getElementById("tab-content");
    if (!container) return;

    if (this._isFavoritesView) {
      await this._renderFavoritesTab(container, superseded);
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
          const retry = new RetryManager(this._errorStore);
          const result = await discoverTopology(this.hass, this._selectedPanelId ?? undefined, retry);
          if (superseded()) return;
          const config = this._buildDashboardConfig();
          this._listDashCtrl.init(result.topology, config, this.hass, entryId);
          // A full re-render (including on W/A switch) needs fresh
          // history: ``loadHistory`` merges into ``powerHistory``, so
          // leftover points from the previous metric would contaminate
          // the new chart.
          this._listDashCtrl.powerHistory.clear();
          await this._listDashCtrl.monitoringCache.fetch(this.hass, entryId);
          if (superseded()) return;
          await this._listDashCtrl.fetchAndBuildHorizonMaps();
          if (superseded()) return;
          const headerHTML = result.topology ? buildHeaderHTML(result.topology, config) : "";
          this._listCtrl.setColumns(this._listColumns);
          this._listCtrl.renderActivityView(container, this.hass, result.topology!, config, this._listDashCtrl.monitoringCache.status, headerHTML);
          await this._listDashCtrl.loadHistory();
          if (superseded()) return;
          this._listDashCtrl.updateDOM(container);
          this._listDashCtrl.startIntervals(container);
        } catch (err) {
          if (superseded()) return;
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
          const retry = new RetryManager(this._errorStore);
          const result = await discoverTopology(this.hass, this._selectedPanelId ?? undefined, retry);
          if (superseded()) return;
          const config = this._buildDashboardConfig();
          this._listDashCtrl.init(result.topology, config, this.hass, areaEntryId);
          this._listDashCtrl.powerHistory.clear();
          await this._listDashCtrl.monitoringCache.fetch(this.hass, areaEntryId);
          if (superseded()) return;
          await this._listDashCtrl.fetchAndBuildHorizonMaps();
          if (superseded()) return;
          const headerHTML = result.topology ? buildHeaderHTML(result.topology, config) : "";
          this._listCtrl.setColumns(this._listColumns);
          this._listCtrl.renderAreaView(container, this.hass, result.topology!, config, this._listDashCtrl.monitoringCache.status, headerHTML);
          await this._listDashCtrl.loadHistory();
          if (superseded()) return;
          this._listDashCtrl.updateDOM(container);
          this._listDashCtrl.startIntervals(container);

          if (!this._areaUnsub && !this._areaSubscribing) {
            this._areaSubscribing = true;
            subscribeAreaUpdates(
              this.hass,
              result.topology!,
              () => {
                if (this._activeTab === "area") {
                  this._scheduleTabRender();
                }
              },
              this._errorStore
            )
              .then(unsub => {
                if (this._areaSubscribing) {
                  this._areaUnsub = unsub;
                } else {
                  // Element disconnected or panel changed while
                  // subscribing — unsubscribe immediately so we don't
                  // leak the subscription.
                  unsub();
                }
              })
              .catch((err: unknown) => {
                this._areaSubscribing = false;
                console.warn("SPAN Panel: area subscription failed", err);
                this._errorStore.add({
                  key: "subscribe:area",
                  level: "warning",
                  message: t("error.areas_failed"),
                  persistent: false,
                });
              });
          }
        } catch (err) {
          const errEl = document.createElement("p");
          errEl.style.color = "var(--error-color)";
          errEl.textContent = err instanceof Error ? err.message : String(err);
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
  private async _renderFavoritesTab(container: HTMLElement, superseded: () => boolean): Promise<void> {
    container.innerHTML = "";
    if (!this.hass) return;

    const realPanels = this._panels.filter(p => p.id !== FAVORITES_PANEL_ID);
    const build = await this._favCtrl.build(this.hass, this._favorites, realPanels, this._errorStore);
    if (superseded()) return;

    // Drive the offline-banner watch for every contributing panel whose
    // topology resolved. Each row in <span-error-banner> is scoped per
    // panel_status entity, so the Favorites view shows one banner row per
    // offline contributing panel, labeled with the panel's name.
    const panelStatusEntries = build.perPanelStats
      .map(p => {
        const entityId = p.topology.panel_entities?.panel_status;
        return typeof entityId === "string" ? { entityId, panelName: p.panelName } : null;
      })
      .filter((e): e is { entityId: string; panelName: string } => e !== null);
    this._errorStore.watchPanelStatuses(panelStatusEntries);
    this._errorStore.updateHass(this.hass);

    // Register per-panel metadata for the Favorites sidebar. The
    // controller's `onGearClick` uses this to build one sidebar
    // section per contributing panel.
    const perPanelInfoMap = new Map<string, FavoritesPanelInfo>();
    for (const p of build.perPanelStats) {
      const realPanel = realPanels.find(r => r.id === p.panelDeviceId);
      perPanelInfoMap.set(p.panelDeviceId, {
        panelName: p.panelName,
        topology: p.topology,
        configEntryId: realPanel?.config_entries?.[0] ?? null,
      });
    }
    this._listDashCtrl.setFavoritesPerPanelInfo(perPanelInfoMap);

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
    this._listCtrl.setColumns(this._listColumns);

    const config = this._buildDashboardConfig();
    this._listDashCtrl.init(merged, config, this.hass, primaryEntryId);
    this._listDashCtrl.powerHistory.clear();
    await this._listDashCtrl.fetchAndBuildHorizonMaps();
    if (superseded()) return;
    const monitoringStatus = await this._listDashCtrl.fetchMergedMonitoringStatus(build.entryIds);
    if (superseded()) return;

    this._favoritesPanelStats = build.perPanelStats;
    try {
      await this._listDashCtrl.loadHistory();
      if (superseded()) return;
      const summaryHTML = this._buildFavoritesSummaryHTML();
      const panelStatsHTML = this._buildFavoritesPanelStatsGridHTML(build.perPanelStats, config);
      const subDevicesHTML = hasSubDevices
        ? `<div class="favorites-subdevices-section">
             <div class="sub-devices">${buildSubDevicesHTML(merged, this.hass, config)}</div>
           </div>`
        : "";
      const headerHTML = summaryHTML + panelStatsHTML + subDevicesHTML;
      if (viewName === "activity") {
        this._listCtrl.renderActivityView(container, this.hass, merged as FavoritesTopology, config, monitoringStatus, headerHTML);
      } else {
        this._listCtrl.renderAreaView(container, this.hass, merged as FavoritesTopology, config, monitoringStatus, headerHTML);
      }
      this._updateFavoritesPanelStats(container, config);
      this._listDashCtrl.setupResizeObserver(container, container);
      this._listDashCtrl.startIntervals(container, () => {
        this._updateFavoritesPanelStats(container, config);
      });
    } catch (err) {
      if (superseded()) return;
      const errEl = document.createElement("p");
      errEl.style.color = "var(--error-color)";
      errEl.textContent = (err as Error).message;
      container.appendChild(errEl);
    }
  }

  private async _renderFavoritesMonitoring(container: HTMLElement, entryIds: string[], realPanels: PanelDevice[]): Promise<void> {
    if (!this.hass) return;

    // Monitoring is a pure configuration view — no panel-stats header,
    // matching the real-panel Monitoring tab (see ``_renderTab`` case
    // "monitoring"). The gear/slide-to-enable/legend/W-A summary belongs
    // on the dashboard views (Activity, Area), not here.
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
      tab.errorStore = this._errorStore;
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
