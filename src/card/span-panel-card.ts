import { LitElement, html, unsafeCSS, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { DEFAULT_CHART_METRIC } from "../constants.js";
import { setLanguage, t } from "../i18n.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { loadListColumns } from "../helpers/list-columns.js";
import { buildHeaderHTML } from "../core/header-renderer.js";
import { buildGridHTML } from "../core/grid-renderer.js";
import { buildSubDevicesHTML } from "../core/sub-device-renderer.js";
import { buildMonitoringSummaryHTML } from "../core/monitoring-status.js";
import { DashboardController } from "../core/dashboard-controller.js";
import { ListViewController } from "../core/list-view-controller.js";
import { buildTabBarHTML, bindTabBarEvents } from "../core/tab-bar-renderer.js";
import { subscribeAreaUpdates } from "../core/area-resolver.js";
import { ErrorStore } from "../core/error-store.js";
import { discoverTopology, discoverEntitiesFallback } from "./card-discovery.js";
import { RetryManager } from "../core/retry-manager.js";
import { CARD_STYLES } from "./card-styles.js";
import "../core/side-panel.js";
import "../core/error-banner.js";
import type { HomeAssistant, PanelTopology, PanelDevice, CardConfig } from "../types.js";

interface SpanSidePanelElement extends HTMLElement {
  hass: HomeAssistant;
  errorStore: ErrorStore | null;
}

const PREVIEW_CIRCUITS = [
  {
    name: "Kitchen",
    watts: "120",
    path: "M0,28 L8,26 L16,24 L24,22 L32,25 L40,20 L48,18 L56,22 L64,19 L72,16 L80,18 L88,15 L96,17 L104,14 L112,16 L120,13",
  },
  {
    name: "Living Room",
    watts: "85",
    path: "M0,22 L8,24 L16,20 L24,26 L32,18 L40,22 L48,16 L56,20 L64,24 L72,18 L80,22 L88,20 L96,16 L104,22 L112,18 L120,20",
  },
  {
    name: "Master Bed",
    watts: "193",
    path: "M0,8 L8,10 L16,8 L24,12 L32,10 L40,8 L48,10 L56,8 L64,10 L72,8 L80,12 L88,10 L96,8 L104,10 L112,8 L120,10",
  },
  {
    name: "HVAC",
    watts: "64",
    path: "M0,30 L8,28 L16,26 L24,22 L32,18 L40,14 L48,18 L56,22 L64,26 L72,22 L80,18 L88,22 L96,26 L104,22 L112,18 L120,22",
  },
];

@customElement("span-panel-card")
export class SpanPanelCard extends LitElement {
  @property({ attribute: false })
  hass!: HomeAssistant;

  @state() private _config: CardConfig = {};
  @state() private _discovered = false;
  @state() private _discovering = false;
  @state() private _topology: PanelTopology | null = null;
  @state() private _activeTab: "panel" | "activity" | "area" = "panel";

  private _panelDevice: PanelDevice | null = null;
  private _panelSize = 0;
  private _historyLoaded = false;
  private readonly _ctrl = new DashboardController();
  private readonly _listCtrl = new ListViewController(this._ctrl);
  private readonly _errorStore = new ErrorStore();
  private _areaUnsub: (() => void) | null = null;
  /**
   * Set while a ``subscribeAreaUpdates`` promise is in-flight. If the
   * element disconnects before the promise resolves we flip this to
   * ``false`` so the later ``.then`` callback can unsubscribe immediately
   * instead of leaking the subscription.
   */
  private _areaSubscribing = false;
  private _tabBarCleanup: (() => void) | null = null;
  private _onVisibilityChange: (() => void) | null = null;

  static override styles = unsafeCSS(CARD_STYLES);

  private get _configEntryId(): string | null {
    return this._panelDevice?.config_entries?.[0] ?? null;
  }

  /**
   * Centralised accessor for the shadow root. LitElement guarantees this
   * is set for a connected component; a null here means SSR or a teardown
   * race, both of which we want to surface loudly rather than paper over
   * with `!` assertions sprinkled at every use site.
   */
  private get _root(): ShadowRoot {
    const root = this.shadowRoot;
    if (!root) throw new Error("span-panel-card: shadow root is not available");
    return root;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._ctrl.startIntervals(this._root);

    this._onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !this._discovered || !this.hass) return;
      this._ctrl.recordSamples();
      this._ctrl.updateDOM(this._root);
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  disconnectedCallback(): void {
    this._ctrl.stopIntervals();
    this._listCtrl.stop();
    this._areaSubscribing = false;
    if (this._areaUnsub) {
      this._areaUnsub();
      this._areaUnsub = null;
    }
    if (this._tabBarCleanup) {
      this._tabBarCleanup();
      this._tabBarCleanup = null;
    }
    if (this._onVisibilityChange) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
    this._errorStore.dispose();
    super.disconnectedCallback();
  }

  setConfig(config: CardConfig): void {
    this._errorStore.clear();
    this._config = config;
    this._discovered = false;
    this._discovering = false;
    this._historyLoaded = false;
    this._topology = null;
    this._panelDevice = null;
    this._panelSize = 0;
    this._activeTab = "panel";
    this._ctrl.reset();
    this._ctrl.setConfig(config);
    this._ctrl.errorStore = this._errorStore;
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

  protected render(): unknown {
    setLanguage(this.hass?.language);

    // State 1: No device_id — show placeholder preview
    if (!this._config.device_id) {
      return this._renderPreview();
    }

    // State 2: Not yet discovered
    if (!this._discovered) {
      const hasError = this._errorStore.hasPersistent("discovery-failed");
      return html`
        <ha-card>
          <span-error-banner .store=${this._errorStore}></span-error-banner>
          ${hasError ? nothing : html`<div style="padding: 24px; color: var(--secondary-text-color);">${escapeHtml(t("card.connecting"))}</div>`}
        </ha-card>
      `;
    }

    // State 3: Discovered — render card shell; content populated imperatively
    return html`
      <ha-card
        @click=${this._onCardClick}
        @graph-settings-changed=${this._onGraphSettingsChanged}
        @unit-changed=${this._onListUnitChanged}
        @list-columns-changed=${this._onListColumnsChanged}
        @side-panel-closed=${this._onSidePanelClosed}
      >
        <span-error-banner .store=${this._errorStore}></span-error-banner>
        <div id="card-tabs"></div>
        <div id="card-content"></div>
      </ha-card>
      <span-side-panel @side-panel-closed=${this._onSidePanelClosed}></span-side-panel>
    `;
  }

  updated(changedProps: Map<string, unknown>): void {
    if (!changedProps.has("hass") || !this.hass) return;

    setLanguage(this.hass.language);
    this._ctrl.hass = this.hass;
    this._errorStore.updateHass(this.hass);

    if (!this._config.device_id) return;

    if (!this._discovered && !this._discovering) {
      this._startDiscovery();
      return;
    }

    if (this._discovered) {
      this._ctrl.recordSamples();
      this._ctrl.updateDOM(this._root);

      const sidePanel = this._root.querySelector("span-side-panel") as SpanSidePanelElement | null;
      if (sidePanel) {
        sidePanel.hass = this.hass;
        sidePanel.errorStore = this._errorStore;
      }
    }

    if (this._discovered && this._activeTab !== "panel" && this._topology) {
      this._listCtrl.updateCollapsedRows(this._root, this.hass, this._topology, this._config);
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  private async _startDiscovery(): Promise<void> {
    if (this._discovering) return;
    this._discovering = true;

    await this._discoverTopology();

    if (this._errorStore.hasPersistent("discovery-failed")) {
      this._discovering = false;
      return;
    }

    this._discovered = true;
    this._discovering = false;
    this._ctrl.init(this._topology, this._config, this.hass, this._configEntryId);

    // Start watching panel_status binary sensor for online/offline state
    if (this._topology?.panel_entities?.panel_status) {
      this._errorStore.watchPanelStatus(this._topology.panel_entities.panel_status);
      this._errorStore.updateHass(this.hass);
    }

    // Subscribe to area changes. The subscribe call is async, so guard
    // against disconnect-before-resolve: if ``_areaSubscribing`` is cleared
    // (disconnectedCallback), drop the unsubscribe on the floor — we'd
    // otherwise store it on a detached element and never call it.
    if (this._topology) {
      this._areaSubscribing = true;
      subscribeAreaUpdates(
        this.hass,
        this._topology,
        () => {
          if (this._activeTab === "area" && this._discovered) {
            this._populateCardContent();
          }
        },
        this._errorStore
      )
        .then(unsub => {
          if (this._areaSubscribing) {
            this._areaUnsub = unsub;
          } else {
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

    // Wait for lit to render the card-content div
    await this.updateComplete;

    this._populateCardContent();
    this._loadHistory();

    this._ctrl.monitoringCache.fetch(this.hass, this._configEntryId).then(() => {
      if (this._discovered) this._ctrl.updateDOM(this._root);
    });
  }

  private async _discoverTopology(): Promise<void> {
    if (!this.hass) return;
    const retry = new RetryManager(this._errorStore);
    try {
      const result = await discoverTopology(this.hass, this._config.device_id, retry);
      this._topology = result.topology;
      this._panelDevice = result.panelDevice;
      this._panelSize = result.panelSize;
    } catch (err) {
      console.error("SPAN Panel: topology fetch failed, falling back to entity discovery", err);
      try {
        const result = await discoverEntitiesFallback(this.hass, this._config.device_id, retry);
        this._topology = result.topology;
        this._panelDevice = result.panelDevice;
        this._panelSize = result.panelSize;
      } catch (fallbackErr) {
        console.error("SPAN Panel: fallback discovery also failed", fallbackErr);
        this._errorStore.add({
          key: "discovery-failed",
          level: "error",
          message: t("error.discovery_failed"),
          persistent: true,
          retryFn: () => {
            this._errorStore.remove("discovery-failed");
            this._startDiscovery();
          },
        });
      }
    }
  }

  private async _loadHistory(): Promise<void> {
    if (this._historyLoaded || !this._topology || !this.hass) return;
    this._historyLoaded = true;

    await this._ctrl.fetchAndBuildHorizonMaps();

    try {
      await this._ctrl.loadHistory();
      this._ctrl.updateDOM(this._root);
    } catch (err) {
      console.warn("SPAN Panel: history fetch failed, charts will populate live", err);
    }
  }

  // ── Imperative card content ────────────────────────────────────────────

  private _populateCardContent(): void {
    const container = this._root.querySelector("#card-content");
    if (!container || !this.hass || !this._topology || !this._panelSize) return;

    // Populate tab bar
    const tabsContainer = this._root.querySelector("#card-tabs");
    if (tabsContainer) {
      const tabDefs = [
        { id: "panel", label: t("tab.by_panel"), icon: "mdi:view-dashboard" },
        { id: "activity", label: t("tab.by_activity"), icon: "mdi:sort-descending" },
        { id: "area", label: t("tab.by_area"), icon: "mdi:home-group" },
      ];
      tabsContainer.innerHTML = buildTabBarHTML(tabDefs, this._activeTab, this._config.tab_style ?? "text");

      // Clean up previous tab bar events
      if (this._tabBarCleanup) {
        this._tabBarCleanup();
        this._tabBarCleanup = null;
      }
      // Bind new tab bar events
      this._tabBarCleanup = bindTabBarEvents(tabsContainer, tabId => {
        const validTabs = ["panel", "activity", "area"] as const;
        type ValidTab = (typeof validTabs)[number];
        if (validTabs.includes(tabId as ValidTab)) {
          this._activeTab = tabId as ValidTab;
          this._listCtrl.stop();
          this._populateCardContent();
        }
      });
    }

    if (this._activeTab === "panel") {
      const totalRows = Math.ceil(this._panelSize / 2);
      const headerHTML = buildHeaderHTML(this._topology, this._config);
      const monitoringStatus = this._ctrl.monitoringCache.status;
      const monitoringSummaryHTML = buildMonitoringSummaryHTML(monitoringStatus);
      const gridHTML = buildGridHTML(this._topology, totalRows, this.hass, this._config, monitoringStatus);
      const subDevHTML = buildSubDevicesHTML(this._topology, this.hass, this._config);

      container.innerHTML = `
        ${headerHTML}
        ${monitoringSummaryHTML}
        ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
        ${this._config.show_panel !== false ? `<div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">${gridHTML}</div>` : ""}
      `;

      const slideEl = container.querySelector(".slide-confirm");
      if (slideEl) {
        const haCard = this._root.querySelector("ha-card");
        this._ctrl.bindSlideConfirm(slideEl, haCard);
        if (haCard) haCard.classList.add("switches-disabled");
      }

      const sidePanel = this._root.querySelector("span-side-panel") as SpanSidePanelElement | null;
      if (sidePanel) {
        sidePanel.hass = this.hass;
        sidePanel.errorStore = this._errorStore;
      }

      this._ctrl.recordSamples();
      this._ctrl.updateDOM(this._root);
      this._ctrl.setupResizeObserver(this._root, this._root.querySelector("ha-card"));
    } else if (this._activeTab === "activity") {
      container.innerHTML = "";
      const listHeaderHTML = buildHeaderHTML(this._topology, this._config);
      this._listCtrl.setColumns(loadListColumns());
      this._listCtrl.renderActivityView(container as HTMLElement, this.hass, this._topology, this._config, this._ctrl.monitoringCache.status, listHeaderHTML);
      this._ctrl.updateDOM(this._root);
    } else if (this._activeTab === "area") {
      container.innerHTML = "";
      const listHeaderHTML = buildHeaderHTML(this._topology, this._config);
      this._listCtrl.setColumns(loadListColumns());
      this._listCtrl.renderAreaView(container as HTMLElement, this.hass, this._topology, this._config, this._ctrl.monitoringCache.status, listHeaderHTML);
      this._ctrl.updateDOM(this._root);
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  private _onCardClick(ev: Event): void {
    if (this._activeTab !== "panel") return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    // Unit toggle
    const unitBtn = target.closest(".unit-btn") as HTMLElement | null;
    if (unitBtn) {
      this._onUnitToggle(unitBtn);
      return;
    }

    // Toggle pill
    const togglePill = target.closest(".toggle-pill");
    if (togglePill) {
      this._ctrl.onToggleClick(ev, this._root);
      return;
    }

    // Gear icon
    const gearBtn = target.closest(".gear-icon") as HTMLElement | null;
    if (gearBtn) {
      this._ctrl.onGearClick(ev, this._root);
      return;
    }
  }

  private async _onUnitToggle(btn: HTMLElement): Promise<void> {
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
    this._populateCardContent();
    await this._loadHistory();
    this._ctrl.updateDOM(this._root);
  }

  private async _onListUnitChanged(e: Event): Promise<void> {
    const unit = (e as CustomEvent<string>).detail;
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
    this._populateCardContent();
    await this._loadHistory();
    this._ctrl.updateDOM(this._root);
  }

  private _onGraphSettingsChanged(): void {
    this._ctrl.onGraphSettingsChanged(this._root);
  }

  private _onListColumnsChanged(e: Event): void {
    const n = (e as CustomEvent<number>).detail;
    if (typeof n !== "number" || (n !== 1 && n !== 2 && n !== 3)) return;
    // Re-render the active list view so the grid reflows. The setting
    // is already persisted by the side panel; loadListColumns() reads
    // the new value during _populateCardContent.
    if (this._activeTab === "activity" || this._activeTab === "area") {
      this._populateCardContent();
    }
  }

  private _onSidePanelClosed(): void {
    this._ctrl.monitoringCache.invalidate();
    this._ctrl.graphSettingsCache.invalidate();
  }

  // ── Preview render ─────────────────────────────────────────────────────

  private _renderPreview(): unknown {
    const cards = PREVIEW_CIRCUITS.map(
      c => html`
        <div style="background:var(--card-background-color,#1c1c1c);border:1px solid var(--divider-color,#333);border-radius:8px;padding:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-size:0.7em;color:var(--primary-text-color);">${c.name}</span>
            <span style="font-size:0.7em;font-weight:600;color:var(--primary-text-color);"
              >${c.watts}<span style="font-size:0.8em;color:var(--secondary-text-color);">W</span></span
            >
          </div>
          <svg viewBox="0 0 120 32" style="width:100%;height:24px;" preserveAspectRatio="none">
            <path d="${c.path}" fill="none" stroke="var(--primary-color,#4dd9af)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      `
    );

    return html`
      <ha-card>
        <div style="padding: 16px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <span style="font-weight:600;font-size:1.1em;color:var(--primary-text-color);">SPAN Panel</span>
            <span style="font-size:0.75em;color:var(--secondary-text-color);">Live Power</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">${cards}</div>
          <div style="margin-top:8px;font-size:0.7em;color:var(--secondary-text-color);">${t("card.no_device")}</div>
        </div>
      </ha-card>
    `;
  }
}
