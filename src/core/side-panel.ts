// src/core/side-panel.ts
import { escapeHtml } from "../helpers/sanitize.js";
import { loadListColumns, saveListColumns } from "../helpers/list-columns.js";
import { INTEGRATION_DOMAIN, SHEDDING_PRIORITIES, GRAPH_HORIZONS, DEFAULT_GRAPH_HORIZON, INPUT_DEBOUNCE_MS } from "../constants.js";
import { t } from "../i18n.js";
import { addFavorite, removeFavorite } from "./favorites-store.js";
import { sortedCircuitsForSection } from "./favorites-sections.js";
import type { HomeAssistant, PanelTopology, GraphSettings, CircuitEntities, CircuitGraphOverride, MonitoringPointInfo } from "../types.js";
import type { ErrorStore } from "./error-store.js";

const PRIORITY_OPTIONS: string[] = Object.keys(SHEDDING_PRIORITIES).filter(k => k !== "unknown" && k !== "always_on");

// ── Interfaces for config shapes passed to open() ────────────────────────

interface GraphHorizonInfo extends CircuitGraphOverride {
  globalHorizon: string;
}

interface PanelModeConfig {
  panelMode: true;
  subDeviceMode?: undefined;
  favoritesMode?: undefined;
  topology: PanelTopology;
  graphSettings: GraphSettings | null;
  /**
   * When set, the per-target lists in panel mode render a heart button
   * beside each horizon selector for toggling favorites. Only the
   * dashboard (``<span-panel>``) sets this — the standalone card leaves
   * it undefined so hearts never appear there.
   */
  showFavorites?: boolean;
  /** HA device id of the panel whose side panel is open (source of favorites). */
  favoritePanelDeviceId?: string;
  /**
   * Circuit uuids favorited for this panel at the moment the side panel
   * was opened. Snapshot — not live. Subsequent toggles update only the
   * clicked heart's optimistic class via ``_toggleFavoriteEntity``; if
   * the user closes and reopens the side panel, ``DashboardController.onGearClick``
   * rebuilds the config from the latest ``_panelFavorites``.
   */
  favoriteCircuitUuids?: Set<string>;
  /** Sub-device HA device ids favorited for this panel — same snapshot semantics. */
  favoriteSubDeviceIds?: Set<string>;
  /** Override config entry id used for cross-panel service routing (favorites). */
  configEntryId?: string | null;
}

interface CircuitModeConfig {
  panelMode?: undefined;
  subDeviceMode?: undefined;
  favoritesMode?: undefined;
  uuid: string;
  name: string;
  tabs: number[];
  breaker_rating_a?: number;
  voltage?: number;
  entities: CircuitEntities;
  is_user_controllable?: boolean;
  always_on?: boolean;
  monitoringInfo: MonitoringPointInfo | null;
  showMonitoring?: boolean;
  graphHorizonInfo: GraphHorizonInfo;
  /** Dashboard-only: render the Favorite section on this side panel. */
  showFavorites?: boolean;
  /** HA device id of the panel that owns this circuit. */
  favoritePanelDeviceId?: string;
  /** Initial favorite state; ``addFavorite``/``removeFavorite`` update live. */
  isFavorite?: boolean;
  /** Route domain service calls to this config entry (favorites view). */
  configEntryId?: string | null;
}

interface SubDeviceModeConfig {
  panelMode?: undefined;
  subDeviceMode: true;
  favoritesMode?: undefined;
  subDeviceId: string;
  name: string;
  deviceType: string;
  /** Sub-device entity registry map from topology, used to pick a routable entity_id for favoriting. */
  entities?: Record<string, { domain: string }>;
  graphHorizonInfo: GraphHorizonInfo;
  /** Dashboard-only: render the Favorite section on this side panel. */
  showFavorites?: boolean;
  /** HA device id of the panel that owns this sub-device. */
  favoritePanelDeviceId?: string;
  /** Initial favorite state. */
  isFavorite?: boolean;
  /** Route domain service calls to this config entry (favorites view). */
  configEntryId?: string | null;
}

export interface FavoritesPanelSection {
  panelDeviceId: string;
  panelName: string;
  topology: PanelTopology;
  graphSettings: GraphSettings | null;
  favoriteCircuitUuids: Set<string>;
  configEntryId: string | null;
}

interface FavoritesModeConfig {
  favoritesMode: true;
  panelMode?: undefined;
  subDeviceMode?: undefined;
  perPanelSections: FavoritesPanelSection[];
}

type SidePanelConfig = PanelModeConfig | CircuitModeConfig | SubDeviceModeConfig | FavoritesModeConfig;

// ── Custom element interface for span-switch ───────────────────────────────

interface SpanSwitchElement extends HTMLElement {
  checked: boolean;
}

// ── Styles ────────────────────────────────────────────────────────────────

const STYLES = `
  :host {
    display: block;
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 360px;
    max-width: 90vw;
    z-index: 1000;
    transform: translateX(100%);
    transition: transform 0.3s ease;
    pointer-events: none;
  }
  :host([open]) {
    transform: translateX(0);
    pointer-events: auto;
  }

  .backdrop {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: -1;
  }
  :host([open]) .backdrop {
    display: block;
  }

  .panel {
    height: 100%;
    background: var(--card-background-color, #fff);
    border-left: 1px solid var(--divider-color, #e0e0e0);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .panel-header .title {
    font-size: 18px;
    font-weight: 500;
    color: var(--primary-text-color, #212121);
    margin: 0;
  }
  .panel-header .subtitle {
    font-size: 13px;
    color: var(--secondary-text-color, #727272);
    margin: 2px 0 0 0;
  }
  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--secondary-text-color, #727272);
    padding: 4px;
    line-height: 1;
    font-size: 20px;
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .section {
    margin-bottom: 20px;
  }
  .section-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--secondary-text-color, #727272);
    margin: 0 0 8px 0;
    letter-spacing: 0.5px;
  }

  .field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
  }
  .field-label {
    font-size: 14px;
    color: var(--primary-text-color, #212121);
  }

  select {
    padding: 6px 8px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 4px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-size: 14px;
  }

  input[type="number"] {
    width: 72px;
    padding: 6px 8px;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 4px;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-size: 14px;
    text-align: right;
  }
  input[type="number"]:disabled {
    opacity: 0.5;
  }

  .radio-group {
    display: flex;
    gap: 16px;
    padding: 8px 0;
  }
  .radio-group label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: var(--primary-text-color, #212121);
    cursor: pointer;
  }

  .horizon-bar {
    display: flex;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    overflow: hidden;
    margin-top: 4px;
  }
  .horizon-segment {
    flex: 1;
    padding: 6px 0;
    text-align: center;
    font-size: 13px;
    cursor: pointer;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    border: none;
    border-right: 1px solid var(--divider-color, #e0e0e0);
    transition: background 0.15s ease, color 0.15s ease;
    user-select: none;
    line-height: 1.4;
  }
  .horizon-segment:last-child {
    border-right: none;
  }
  .horizon-segment:hover:not(.active) {
    background: var(--secondary-background-color, #f5f5f5);
  }
  .horizon-segment.active {
    background: var(--primary-color, #03a9f4);
    color: #fff;
    font-weight: 600;
  }
  .horizon-segment.referenced {
    box-shadow: inset 0 -3px 0 var(--primary-color, #03a9f4);
  }

  .unit-toggle {
    display: inline-flex;
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 6px;
    overflow: hidden;
  }
  .unit-btn {
    padding: 4px 10px;
    border: none;
    border-right: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .unit-btn:last-child {
    border-right: none;
  }
  .unit-btn:hover:not(.unit-active) {
    background: var(--secondary-background-color, #f5f5f5);
  }
  .unit-btn.unit-active {
    background: var(--primary-color, #03a9f4);
    color: #fff;
    font-weight: 600;
  }

  .monitoring-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .fav-heart {
    background: none;
    border: 1px solid var(--divider-color, #e0e0e0);
    color: var(--secondary-text-color, #727272);
    border-radius: 4px;
    padding: 2px 6px;
    cursor: pointer;
    font-size: 0.9em;
    margin-right: 6px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
  }
  .fav-heart.active {
    color: var(--primary-color, #03a9f4);
    border-color: var(--primary-color, #03a9f4);
  }
  .fav-heart:hover:not(.active) {
    background: var(--secondary-background-color, #f5f5f5);
  }
  .fav-heart span-icon {
    --mdc-icon-size: 16px;
  }

  .panel-mode-info {
    font-size: 14px;
    color: var(--primary-text-color, #212121);
    line-height: 1.6;
  }
  .panel-mode-info p {
    margin: 0 0 12px 0;
  }

`;

// ── Component ─────────────────────────────────────────────────────────────

class SpanSidePanel extends HTMLElement {
  errorStore: ErrorStore | null = null;
  private _hass: HomeAssistant | null;
  private _config: SidePanelConfig | null;
  private _debounceTimers: Record<string, ReturnType<typeof setTimeout>>;
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._debounceTimers = {};
  }

  set hass(val: HomeAssistant | null) {
    this._hass = val;
    if (this.hasAttribute("open") && this._config) {
      this._updateLiveState();
    }
  }

  get hass(): HomeAssistant | null {
    return this._hass;
  }

  disconnectedCallback(): void {
    this._clearDebounceTimers();
    this._config = null;
  }

  open(config: SidePanelConfig): void {
    this._config = config;
    this._render();
    // Force reflow before adding attribute so the transition animates
    void this.offsetHeight;
    this.setAttribute("open", "");
    // Expose the active mode as a host attribute so parents can detect
    // which sidebar variant is open (e.g. to defer tab re-renders while
    // a favorites-mode sidebar is live).
    this.setAttribute("data-mode", this._modeFor(config));
  }

  close(): void {
    // Cancel any still-pending debounced writes so they don't fire
    // against a torn-down ``_config`` and leak a stale service call.
    this._clearDebounceTimers();
    this.removeAttribute("open");
    this.removeAttribute("data-mode");
    this._config = null;
    this.dispatchEvent(new CustomEvent("side-panel-closed", { bubbles: true, composed: true }));
  }

  private _clearDebounceTimers(): void {
    for (const key of Object.keys(this._debounceTimers)) {
      clearTimeout(this._debounceTimers[key]);
    }
    this._debounceTimers = {};
  }

  private _modeFor(cfg: SidePanelConfig): "favorites" | "panel" | "subDevice" | "circuit" {
    if (cfg.favoritesMode) return "favorites";
    if (cfg.panelMode) return "panel";
    if (cfg.subDeviceMode) return "subDevice";
    return "circuit";
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  private _render(): void {
    const cfg = this._config;
    if (!cfg) return;

    const shadow = this.shadowRoot;
    if (!shadow) return;
    shadow.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = STYLES;
    shadow.appendChild(style);

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    backdrop.addEventListener("click", () => this.close());
    shadow.appendChild(backdrop);

    const panel = document.createElement("div");
    panel.className = "panel";
    shadow.appendChild(panel);

    if (cfg.favoritesMode) {
      this._renderFavoritesMode(panel);
    } else if (cfg.panelMode) {
      this._renderPanelMode(panel);
    } else if (cfg.subDeviceMode) {
      this._renderSubDeviceMode(panel, cfg);
    } else {
      this._renderCircuitMode(panel, cfg);
    }
  }

  private _renderPanelMode(panel: HTMLDivElement): void {
    const cfg = this._config as PanelModeConfig;
    const header = this._createHeader(t("sidepanel.graph_settings"), t("sidepanel.global_defaults"));
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";

    const graphSettings = cfg.graphSettings;
    const topology = cfg.topology;
    const globalHorizon = graphSettings?.global_horizon ?? DEFAULT_GRAPH_HORIZON;
    const circuitSettings = graphSettings?.circuits ?? {};

    // ── List view columns ──
    // Placed above the horizon sections so the horizon-related sections
    // (global default + per-circuit scales) sit together below.
    body.appendChild(this._buildListColumnsSection());

    // ── Global default horizon ──
    const globalSection = document.createElement("div");
    globalSection.className = "section";

    const globalLabel = document.createElement("div");
    globalLabel.className = "section-label";
    globalLabel.textContent = t("sidepanel.graph_horizon");
    globalSection.appendChild(globalLabel);

    const globalRow = document.createElement("div");
    globalRow.className = "field-row";

    const globalFieldLabel = document.createElement("span");
    globalFieldLabel.className = "field-label";
    globalFieldLabel.textContent = t("sidepanel.global_default");
    globalRow.appendChild(globalFieldLabel);

    const globalSelect = document.createElement("select");
    for (const key of Object.keys(GRAPH_HORIZONS)) {
      const opt = document.createElement("option");
      opt.value = key;
      const labelKey = `horizon.${key}`;
      const translated = t(labelKey);
      opt.textContent = translated !== labelKey ? translated : key;
      if (key === globalHorizon) opt.selected = true;
      globalSelect.appendChild(opt);
    }
    globalSelect.addEventListener("change", () => {
      const data: Record<string, unknown> = { horizon: globalSelect.value };
      if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
      this._callDomainService("set_graph_time_horizon", data)
        .then(() => {
          this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
        })
        .catch((err: Error) => {
          console.warn("SPAN Panel: graph horizon service failed", err);
          this.errorStore?.add({
            key: "service:graph_horizon",
            level: "error",
            message: t("error.graph_horizon_failed"),
            persistent: false,
          });
        });
    });
    globalRow.appendChild(globalSelect);
    globalSection.appendChild(globalRow);
    body.appendChild(globalSection);

    // ── Per-circuit horizon scales ──
    if (topology?.circuits) {
      const circuitSection = document.createElement("div");
      circuitSection.className = "section";

      const circuitLabel = document.createElement("div");
      circuitLabel.className = "section-label";
      circuitLabel.textContent = t("sidepanel.circuit_scales");
      circuitSection.appendChild(circuitLabel);

      const circuits = Object.entries(topology.circuits).sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || ""));

      for (const [uuid, circuit] of circuits) {
        const row = this._buildPanelModeCircuitRow(
          uuid,
          circuit,
          circuitSettings[uuid],
          globalHorizon,
          cfg.configEntryId ?? null,
          cfg.showFavorites ?? false,
          cfg.favoritePanelDeviceId,
          cfg.favoriteCircuitUuids
        );
        circuitSection.appendChild(row);
      }

      body.appendChild(circuitSection);
    }

    // ── Per-sub-device horizon scales ──
    const subDeviceSettings = graphSettings?.sub_devices ?? {};
    if (topology?.sub_devices) {
      const subDevSection = document.createElement("div");
      subDevSection.className = "section";

      const subDevLabel = document.createElement("div");
      subDevLabel.className = "section-label";
      subDevLabel.textContent = t("sidepanel.subdevice_scales");
      subDevSection.appendChild(subDevLabel);

      const subDevices = Object.entries(topology.sub_devices).sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || ""));

      for (const [devId, sub] of subDevices) {
        const row = document.createElement("div");
        row.className = "field-row";

        const nameLabel = document.createElement("span");
        nameLabel.className = "field-label";
        nameLabel.textContent = sub.name || devId;
        nameLabel.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;";
        row.appendChild(nameLabel);

        if (cfg.showFavorites && cfg.favoritePanelDeviceId) {
          const heart = this._buildSubDeviceFavoriteHeart(sub.entities, cfg.favoriteSubDeviceIds?.has(devId) ?? false);
          if (heart) row.appendChild(heart);
        }

        const subDevData = subDeviceSettings[devId] || { horizon: globalHorizon, has_override: false };
        const effectiveHorizon = subDevData.has_override ? subDevData.horizon : globalHorizon;

        const select = document.createElement("select");
        select.dataset.subdevId = devId;
        for (const key of Object.keys(GRAPH_HORIZONS)) {
          const opt = document.createElement("option");
          opt.value = key;
          const labelKey = `horizon.${key}`;
          const translated = t(labelKey);
          opt.textContent = translated !== labelKey ? translated : key;
          if (key === effectiveHorizon) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener("change", () => {
          this._debounce(`subdev-${devId}`, INPUT_DEBOUNCE_MS, () => {
            const data: Record<string, unknown> = {
              subdevice_id: devId,
              horizon: select.value,
            };
            if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
            this._callDomainService("set_subdevice_graph_horizon", data)
              .then(() => {
                this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
              })
              .catch((err: Error) => {
                console.warn("SPAN Panel: graph horizon service failed", err);
                this.errorStore?.add({
                  key: "service:graph_horizon",
                  level: "error",
                  message: t("error.graph_horizon_failed"),
                  persistent: false,
                });
              });
          });
        });
        row.appendChild(select);

        if (subDevData.has_override) {
          const resetBtn = document.createElement("button");
          resetBtn.textContent = "\u21ba";
          resetBtn.title = t("sidepanel.reset_to_global");
          Object.assign(resetBtn.style, {
            background: "none",
            border: "1px solid var(--divider-color, #e0e0e0)",
            color: "var(--primary-text-color)",
            borderRadius: "4px",
            padding: "3px 6px",
            cursor: "pointer",
            marginLeft: "4px",
            fontSize: "0.85em",
          });
          resetBtn.addEventListener("click", () => {
            const data: Record<string, unknown> = { subdevice_id: devId };
            if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
            this._callDomainService("clear_subdevice_graph_horizon", data)
              .then(() => {
                select.value = globalHorizon;
                resetBtn.remove();
                this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
              })
              .catch((err: Error) => {
                console.warn("SPAN Panel: graph horizon service failed", err);
                this.errorStore?.add({
                  key: "service:graph_horizon",
                  level: "error",
                  message: t("error.graph_horizon_failed"),
                  persistent: false,
                });
              });
          });
          row.appendChild(resetBtn);
        }

        subDevSection.appendChild(row);
      }

      body.appendChild(subDevSection);
    }

    panel.appendChild(body);
  }

  private _buildPanelModeCircuitRow(
    uuid: string,
    circuit: PanelTopology["circuits"][string],
    circuitSetting: CircuitGraphOverride | undefined,
    globalHorizon: string,
    configEntryId: string | null,
    showFavorites: boolean,
    favoritePanelDeviceId: string | undefined,
    favoriteCircuitUuids: Set<string> | undefined
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "field-row";

    const nameLabel = document.createElement("span");
    nameLabel.className = "field-label";
    nameLabel.textContent = circuit.name || uuid;
    nameLabel.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;";
    row.appendChild(nameLabel);

    if (showFavorites && favoritePanelDeviceId) {
      const heart = this._buildFavoriteHeart(circuit.entities, favoriteCircuitUuids?.has(uuid) ?? false);
      if (heart) row.appendChild(heart);
    }

    const circuitData = circuitSetting || { horizon: globalHorizon, has_override: false };
    const effectiveHorizon = circuitData.has_override ? circuitData.horizon : globalHorizon;

    const select = document.createElement("select");
    select.dataset.uuid = uuid;
    for (const key of Object.keys(GRAPH_HORIZONS)) {
      const opt = document.createElement("option");
      opt.value = key;
      const labelKey = `horizon.${key}`;
      const translated = t(labelKey);
      opt.textContent = translated !== labelKey ? translated : key;
      if (key === effectiveHorizon) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      this._debounce(`circuit-${uuid}`, INPUT_DEBOUNCE_MS, () => {
        const data: Record<string, unknown> = {
          circuit_id: uuid,
          horizon: select.value,
        };
        if (configEntryId) data.config_entry_id = configEntryId;
        this._callDomainService("set_circuit_graph_horizon", data)
          .then(() => {
            this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
          })
          .catch((err: Error) => {
            console.warn("SPAN Panel: graph horizon service failed", err);
            this.errorStore?.add({
              key: "service:graph_horizon",
              level: "error",
              message: t("error.graph_horizon_failed"),
              persistent: false,
            });
          });
      });
    });
    row.appendChild(select);

    if (circuitData.has_override) {
      const resetBtn = document.createElement("button");
      resetBtn.textContent = "\u21ba";
      resetBtn.title = t("sidepanel.reset_to_global");
      Object.assign(resetBtn.style, {
        background: "none",
        border: "1px solid var(--divider-color, #e0e0e0)",
        color: "var(--primary-text-color)",
        borderRadius: "4px",
        padding: "3px 6px",
        cursor: "pointer",
        marginLeft: "4px",
        fontSize: "0.85em",
      });
      resetBtn.addEventListener("click", () => {
        const data: Record<string, unknown> = { circuit_id: uuid };
        if (configEntryId) data.config_entry_id = configEntryId;
        this._callDomainService("clear_circuit_graph_horizon", data)
          .then(() => {
            select.value = globalHorizon;
            resetBtn.remove();
            this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
          })
          .catch((err: Error) => {
            console.warn("SPAN Panel: graph horizon service failed", err);
            this.errorStore?.add({
              key: "service:graph_horizon",
              level: "error",
              message: t("error.graph_horizon_failed"),
              persistent: false,
            });
          });
      });
      row.appendChild(resetBtn);
    }

    return row;
  }

  private _renderFavoritesMode(panel: HTMLDivElement): void {
    const cfg = this._config as FavoritesModeConfig;
    const header = this._createHeader(t("sidepanel.graph_settings"), t("sidepanel.favorites_subtitle"));
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";

    // List View Columns (frontend setting, view-agnostic)
    body.appendChild(this._buildListColumnsSection());

    // Per-contributing-panel sections: one passive-label section per panel
    // that has any favorited circuit. No global default horizon section —
    // per the spec, horizons are per-circuit in this mode.
    for (const section of cfg.perPanelSections) {
      body.appendChild(this._buildFavoritesPanelSection(section));
    }

    panel.appendChild(body);
  }

  private _buildFavoritesPanelSection(section: FavoritesPanelSection): HTMLDivElement {
    const div = document.createElement("div");
    div.className = "section";

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = section.panelName;
    div.appendChild(label);

    const globalHorizon = section.graphSettings?.global_horizon ?? DEFAULT_GRAPH_HORIZON;
    const circuitSettings = section.graphSettings?.circuits ?? {};

    // Every circuit in this panel's topology — not just the favorited
    // ones. Each row's heart discriminates active vs. inactive based on
    // `section.favoriteCircuitUuids`, so users can un-favorite or newly
    // favorite any circuit on this panel without leaving the Favorites
    // view. Mirrors the real-panel gear sidebar (`_renderPanelMode`).
    const rows = sortedCircuitsForSection(section.topology);

    for (const { uuid, circuit } of rows) {
      const row = this._buildPanelModeCircuitRow(
        uuid,
        circuit,
        circuitSettings[uuid],
        globalHorizon,
        section.configEntryId,
        true, // showFavorites: always true inside favorites-mode rows
        section.panelDeviceId,
        section.favoriteCircuitUuids
      );
      div.appendChild(row);
    }

    return div;
  }

  private _renderCircuitMode(panel: HTMLDivElement, cfg: CircuitModeConfig): void {
    const subtitle = `${escapeHtml(String(cfg.breaker_rating_a))}A \u00b7 ${escapeHtml(String(cfg.voltage))}V \u00b7 Tabs [${escapeHtml(String(cfg.tabs))}]`;
    const header = this._createHeader(escapeHtml(cfg.name), subtitle);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";
    panel.appendChild(body);

    this._renderRelaySection(body, cfg);
    if (cfg.showFavorites) {
      this._renderFavoriteSection(body, cfg);
    }
    this._renderSheddingSection(body, cfg);
    this._renderGraphHorizonSection(body, cfg);
    if (cfg.showMonitoring) {
      this._renderMonitoringSection(body, cfg);
    }
  }

  private _favoriteEntityId(entities: CircuitEntities | undefined): string | null {
    return entities?.current ?? entities?.power ?? null;
  }

  /**
   * Pick any entity_id from a sub-device's entity map. The favorites
   * service resolves the entity to its parent SPAN panel + sub-device
   * id, so any sensor on the sub-device works. Prefers a sensor.
   */
  private _subDeviceFavoriteEntityId(entities: Record<string, { domain: string }> | undefined): string | null {
    if (!entities) return null;
    let fallback: string | null = null;
    for (const [entityId, info] of Object.entries(entities)) {
      if (info.domain === "sensor") return entityId;
      if (!fallback) fallback = entityId;
    }
    return fallback;
  }

  /**
   * Build a heart toggle for a sub-device row in panel-mode Graph
   * Settings. Returns ``null`` when the sub-device has no entities to
   * resolve (favorites services need an entity_id).
   */
  private _buildSubDeviceFavoriteHeart(entities: Record<string, { domain: string }> | undefined, isFavorite: boolean): HTMLButtonElement | null {
    const entityId = this._subDeviceFavoriteEntityId(entities);
    if (!entityId) return null;
    return this._buildHeartButton(entityId, isFavorite);
  }

  /**
   * Build the "List view columns" section for the Graph Settings
   * panel — a segmented 1/2/3 control backed by localStorage. Clicking
   * a button persists the choice and dispatches ``list-columns-changed``
   * up the DOM so ``span-panel.ts`` re-renders the active list view.
   */
  private _buildListColumnsSection(): HTMLDivElement {
    const section = document.createElement("div");
    section.className = "section";

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = t("sidepanel.list_view_columns");
    section.appendChild(label);

    const row = document.createElement("div");
    row.className = "field-row";

    const fieldLabel = document.createElement("span");
    fieldLabel.className = "field-label";
    fieldLabel.textContent = t("sidepanel.columns");
    row.appendChild(fieldLabel);

    const current = loadListColumns();

    const group = document.createElement("div");
    group.className = "unit-toggle";
    for (const n of [1, 2, 3]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `unit-btn${n === current ? " unit-active" : ""}`;
      btn.dataset.columns = String(n);
      btn.textContent = String(n);
      btn.addEventListener("click", () => {
        saveListColumns(n);
        for (const other of group.querySelectorAll<HTMLElement>(".unit-btn")) {
          other.classList.toggle("unit-active", other === btn);
        }
        this.dispatchEvent(
          new CustomEvent<number>("list-columns-changed", {
            detail: n,
            bubbles: true,
            composed: true,
          })
        );
      });
      group.appendChild(btn);
    }
    row.appendChild(group);
    section.appendChild(row);
    return section;
  }

  /**
   * Build a heart toggle for a circuit row in panel-mode Graph Settings.
   * Returns ``null`` when the circuit has no routable sensor entity
   * (favorites services need an entity_id to resolve the target).
   */
  private _buildFavoriteHeart(entities: CircuitEntities | undefined, isFavorite: boolean): HTMLButtonElement | null {
    const entityId = this._favoriteEntityId(entities);
    if (!entityId) {
      console.warn("SPAN Panel: circuit has no current/power sensor; favorite heart suppressed");
      return null;
    }
    return this._buildHeartButton(entityId, isFavorite);
  }

  /**
   * Shared heart-button builder used by both circuit and sub-device
   * panel-mode rows and by the per-target side-panel Favorite section.
   * Renders an accessible toggle (``role=switch``, ``aria-checked``,
   * ``aria-label``) so screen readers announce both the action and the
   * current state — ``title`` alone isn't surfaced.
   */
  private _buildHeartButton(entityId: string, isFavorite: boolean): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = isFavorite ? "fav-heart active" : "fav-heart";
    btn.dataset.role = "fav-heart";
    btn.title = t("sidepanel.save_to_favorites");
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", String(isFavorite));
    btn.setAttribute("aria-label", t("sidepanel.save_to_favorites"));

    const icon = document.createElement("span-icon");
    icon.setAttribute("icon", isFavorite ? "mdi:heart" : "mdi:heart-outline");
    btn.appendChild(icon);

    btn.addEventListener("click", (ev: Event) => {
      ev.stopPropagation();
      this._toggleFavoriteEntity(btn, icon, entityId).catch(() => {
        // error message shown inside _toggleFavoriteEntity
      });
    });

    return btn;
  }

  private async _toggleFavoriteEntity(btn: HTMLButtonElement, icon: HTMLElement, entityId: string): Promise<void> {
    if (!this._hass) return;
    const wasActive = btn.classList.contains("active");
    const nextActive = !wasActive;
    // Optimistically flip class, icon, and aria-checked; roll back on error.
    btn.classList.toggle("active", nextActive);
    icon.setAttribute("icon", nextActive ? "mdi:heart" : "mdi:heart-outline");
    btn.setAttribute("aria-checked", String(nextActive));
    try {
      if (nextActive) {
        await addFavorite(this._hass, entityId);
      } else {
        await removeFavorite(this._hass, entityId);
      }
    } catch (err) {
      btn.classList.toggle("active", wasActive);
      icon.setAttribute("icon", wasActive ? "mdi:heart" : "mdi:heart-outline");
      btn.setAttribute("aria-checked", String(wasActive));
      console.warn("SPAN Panel: favorite toggle failed", err);
      this.errorStore?.add({
        key: "service:favorites",
        level: "error",
        message: t("error.favorites_toggle_failed"),
        persistent: false,
      });
      throw err;
    }
  }

  private _renderFavoriteSection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    const entityId = this._favoriteEntityId(cfg.entities);
    if (!entityId) return;
    this._appendFavoriteHeartSection(body, entityId, cfg.isFavorite === true);
  }

  /**
   * Build a Favorite section with a heart icon (filled = favorited,
   * outlined = not). Used in both the per-circuit and per-sub-device
   * side panels. A heart deliberately avoids the visual confusion of
   * placing an span-switch directly under the breaker relay switch.
   */
  private _appendFavoriteHeartSection(body: HTMLDivElement, entityId: string, isFavorite: boolean): void {
    const section = document.createElement("div");
    section.className = "section";
    section.innerHTML = `<div class="section-label">${escapeHtml(t("sidepanel.favorite"))}</div>`;

    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = t("sidepanel.save_to_favorites");

    row.appendChild(label);
    row.appendChild(this._buildHeartButton(entityId, isFavorite));
    section.appendChild(row);
    body.appendChild(section);
  }

  private _renderSubDeviceMode(panel: HTMLDivElement, cfg: SubDeviceModeConfig): void {
    const header = this._createHeader(escapeHtml(cfg.name), escapeHtml(cfg.deviceType));
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";
    panel.appendChild(body);

    if (cfg.showFavorites) {
      this._renderSubDeviceFavoriteSection(body, cfg);
    }
    this._renderSubDeviceHorizonSection(body, cfg);
  }

  private _renderSubDeviceFavoriteSection(body: HTMLDivElement, cfg: SubDeviceModeConfig): void {
    const entityId = this._subDeviceFavoriteEntityId(cfg.entities);
    if (!entityId) return;
    this._appendFavoriteHeartSection(body, entityId, cfg.isFavorite === true);
  }

  private _renderSubDeviceHorizonSection(body: HTMLDivElement, cfg: SubDeviceModeConfig): void {
    const section = document.createElement("div");
    section.className = "section";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = t("sidepanel.graph_horizon");
    section.appendChild(sectionLabel);

    const graphInfo = cfg.graphHorizonInfo;
    const hasOverride = graphInfo?.has_override === true;
    const currentHorizon = graphInfo?.horizon || DEFAULT_GRAPH_HORIZON;
    const globalHorizon = graphInfo?.globalHorizon || DEFAULT_GRAPH_HORIZON;

    const bar = document.createElement("div");
    bar.className = "horizon-bar";

    const segments: { key: string; label: string }[] = [{ key: "global", label: t("sidepanel.global") }];
    for (const key of Object.keys(GRAPH_HORIZONS)) {
      segments.push({ key, label: key });
    }

    const activeKey = hasOverride ? currentHorizon : "global";

    const updateSegmentStates = (newActiveKey: string): void => {
      for (const btn of bar.querySelectorAll<HTMLButtonElement>(".horizon-segment")) {
        const key = btn.dataset.horizon;
        btn.classList.toggle("active", key === newActiveKey);
        btn.classList.toggle("referenced", newActiveKey === "global" && key === globalHorizon);
      }
    };

    for (const { key, label } of segments) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "horizon-segment";
      btn.dataset.horizon = key;
      btn.textContent = label;
      btn.classList.toggle("active", key === activeKey);
      btn.classList.toggle("referenced", activeKey === "global" && key === globalHorizon);

      btn.addEventListener("click", () => {
        if (btn.classList.contains("active")) return;

        const subDeviceId = cfg.subDeviceId;
        // Without ``config_entry_id`` the backend's _get_horizon_manager
        // falls back to the FIRST loaded SPAN entry's manager — wrong
        // panel when more than one is configured. The panel-mode list
        // and circuit-mode side panel both pass it; thread it here too.
        const baseData: Record<string, unknown> = { subdevice_id: subDeviceId };
        if (cfg.configEntryId) baseData.config_entry_id = cfg.configEntryId;
        if (key === "global") {
          updateSegmentStates("global");
          this._callDomainService("clear_subdevice_graph_horizon", baseData)
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => {
              console.warn("SPAN Panel: graph horizon service failed", err);
              this.errorStore?.add({
                key: "service:graph_horizon",
                level: "error",
                message: t("error.graph_horizon_failed"),
                persistent: false,
              });
            });
        } else {
          updateSegmentStates(key);
          this._callDomainService("set_subdevice_graph_horizon", { ...baseData, horizon: key })
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => {
              console.warn("SPAN Panel: graph horizon service failed", err);
              this.errorStore?.add({
                key: "service:graph_horizon",
                level: "error",
                message: t("error.graph_horizon_failed"),
                persistent: false,
              });
            });
        }
      });

      bar.appendChild(btn);
    }

    section.appendChild(bar);
    body.appendChild(section);
  }

  private _createHeader(title: string, subtitle: string): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "panel-header";

    const titleWrap = document.createElement("div");
    const safeTitle = escapeHtml(title);
    const safeSubtitle = escapeHtml(subtitle);
    titleWrap.innerHTML = `<div class="title">${safeTitle}</div>` + (safeSubtitle ? `<div class="subtitle">${safeSubtitle}</div>` : "");

    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.innerHTML = "\u2715";
    closeBtn.addEventListener("click", () => this.close());

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    return header;
  }

  // ── Relay section ───────────────────────────────────────────────────

  private _renderRelaySection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    if (cfg.is_user_controllable === false || !cfg.entities?.switch) return;

    const section = document.createElement("div");
    section.className = "section";
    section.innerHTML = `<div class="section-label">${escapeHtml(t("sidepanel.relay"))}</div>`;

    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = t("sidepanel.breaker");

    const toggle = document.createElement("span-switch") as SpanSwitchElement;
    toggle.dataset.role = "relay-toggle";
    const entityId = cfg.entities.switch;
    const currentState = this._hass?.states?.[entityId]?.state;
    if (currentState === "on") {
      toggle.setAttribute("checked", "");
    }

    toggle.addEventListener("change", () => {
      const isOn = toggle.hasAttribute("checked") || toggle.checked;
      this._callService("switch", isOn ? "turn_on" : "turn_off", { entity_id: entityId }).catch((err: Error) => {
        console.warn("SPAN Panel: relay toggle failed", err);
        this.errorStore?.add({
          key: "service:relay",
          level: "error",
          message: t("error.relay_failed"),
          persistent: false,
        });
      });
    });

    row.appendChild(label);
    row.appendChild(toggle);
    section.appendChild(row);
    body.appendChild(section);
  }

  // ── Shedding section ────────────────────────────────────────────────

  private _renderSheddingSection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    if (!cfg.entities?.select) return;

    const section = document.createElement("div");
    section.className = "section";
    section.innerHTML = `<div class="section-label">${escapeHtml(t("sidepanel.shedding_priority"))}</div>`;

    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = t("sidepanel.priority_label");

    const selectEl = document.createElement("select");
    selectEl.dataset.role = "shedding-select";
    const entityId = cfg.entities.select;
    const currentPriority = this._hass?.states?.[entityId]?.state || "";

    for (const key of PRIORITY_OPTIONS) {
      const priority = SHEDDING_PRIORITIES[key];
      if (!priority) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = t(`shedding.select.${key}`) || priority.label();
      if (key === currentPriority) opt.selected = true;
      selectEl.appendChild(opt);
    }

    selectEl.addEventListener("change", () => {
      this._callService("select", "select_option", { entity_id: entityId, option: selectEl.value }).catch((err: Error) => {
        console.warn("SPAN Panel: shedding update failed", err);
        this.errorStore?.add({
          key: "service:shedding",
          level: "error",
          message: t("error.shedding_failed"),
          persistent: false,
        });
      });
    });

    row.appendChild(label);
    row.appendChild(selectEl);
    section.appendChild(row);
    body.appendChild(section);
  }

  // ── Graph horizon section ──────────────────────────────────────────

  private _renderGraphHorizonSection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    const section = document.createElement("div");
    section.className = "section";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = t("sidepanel.graph_horizon");
    section.appendChild(sectionLabel);

    const graphInfo = cfg.graphHorizonInfo;
    const hasOverride = graphInfo?.has_override === true;
    const currentHorizon = graphInfo?.horizon || DEFAULT_GRAPH_HORIZON;
    const globalHorizon = graphInfo?.globalHorizon || DEFAULT_GRAPH_HORIZON;

    // Segmented button bar: Global | 5m | 1h | 1d | 1w | 1M
    const bar = document.createElement("div");
    bar.className = "horizon-bar";

    const segments: { key: string; label: string }[] = [{ key: "global", label: t("sidepanel.global") }];
    for (const key of Object.keys(GRAPH_HORIZONS)) {
      segments.push({ key, label: key });
    }

    const activeKey = hasOverride ? currentHorizon : "global";

    const updateSegmentStates = (newActiveKey: string): void => {
      for (const btn of bar.querySelectorAll<HTMLButtonElement>(".horizon-segment")) {
        const key = btn.dataset.horizon;
        btn.classList.toggle("active", key === newActiveKey);
        btn.classList.toggle("referenced", newActiveKey === "global" && key === globalHorizon);
      }
    };

    for (const { key, label } of segments) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "horizon-segment";
      btn.dataset.horizon = key;
      btn.textContent = label;
      btn.classList.toggle("active", key === activeKey);
      btn.classList.toggle("referenced", activeKey === "global" && key === globalHorizon);

      btn.addEventListener("click", () => {
        if (btn.classList.contains("active")) return;

        const circuitId = cfg.uuid;
        const baseData: Record<string, unknown> = { circuit_id: circuitId };
        if (cfg.configEntryId) baseData.config_entry_id = cfg.configEntryId;
        if (key === "global") {
          updateSegmentStates("global");
          this._callDomainService("clear_circuit_graph_horizon", baseData)
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => {
              console.warn("SPAN Panel: graph horizon service failed", err);
              this.errorStore?.add({
                key: "service:graph_horizon",
                level: "error",
                message: t("error.graph_horizon_failed"),
                persistent: false,
              });
            });
        } else {
          updateSegmentStates(key);
          this._callDomainService("set_circuit_graph_horizon", {
            ...baseData,
            horizon: key,
          })
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => {
              console.warn("SPAN Panel: graph horizon service failed", err);
              this.errorStore?.add({
                key: "service:graph_horizon",
                level: "error",
                message: t("error.graph_horizon_failed"),
                persistent: false,
              });
            });
        }
      });

      bar.appendChild(btn);
    }

    section.appendChild(bar);
    body.appendChild(section);
  }

  // ── Monitoring section ──────────────────────────────────────────────

  private _renderMonitoringSection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    const section = document.createElement("div");
    section.className = "section";

    const headerRow = document.createElement("div");
    headerRow.className = "monitoring-header";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = t("sidepanel.monitoring");
    sectionLabel.style.margin = "0";

    const enableToggle = document.createElement("span-switch") as SpanSwitchElement;
    enableToggle.dataset.role = "monitoring-toggle";

    const info = cfg.monitoringInfo;
    const isEnabled = info != null && info.monitoring_enabled !== false;
    if (isEnabled) {
      enableToggle.setAttribute("checked", "");
    }

    headerRow.appendChild(sectionLabel);
    headerRow.appendChild(enableToggle);
    section.appendChild(headerRow);

    const detailsWrap = document.createElement("div");
    detailsWrap.dataset.role = "monitoring-details";
    detailsWrap.style.display = isEnabled ? "block" : "none";
    section.appendChild(detailsWrap);

    const hasCustom = info?.has_override === true;

    // Global / Custom radio
    const radioGroup = document.createElement("div");
    radioGroup.className = "radio-group";
    radioGroup.innerHTML = `
      <label><input type="radio" name="monitoring-mode" value="global" ${!hasCustom ? "checked" : ""} /> ${escapeHtml(t("sidepanel.global"))}</label>
      <label><input type="radio" name="monitoring-mode" value="custom" ${hasCustom ? "checked" : ""} /> ${escapeHtml(t("sidepanel.custom"))}</label>
    `;
    detailsWrap.appendChild(radioGroup);

    // Threshold fields
    const thresholdsWrap = document.createElement("div");
    thresholdsWrap.dataset.role = "threshold-fields";
    thresholdsWrap.style.display = hasCustom ? "block" : "none";

    const continuousVal = info?.continuous_threshold_pct ?? 80;
    const spikeVal = info?.spike_threshold_pct ?? 100;
    const windowVal = info?.window_duration_m ?? 15;
    const cooldownVal = info?.cooldown_duration_m ?? 15;

    thresholdsWrap.appendChild(this._createThresholdRow(t("sidepanel.continuous_pct"), "continuous", continuousVal, cfg));
    thresholdsWrap.appendChild(this._createThresholdRow(t("sidepanel.spike_pct"), "spike", spikeVal, cfg));
    thresholdsWrap.appendChild(this._createDurationRow(t("sidepanel.window_duration"), "window-m", windowVal, 1, 180, "m", cfg));
    thresholdsWrap.appendChild(this._createDurationRow(t("sidepanel.cooldown"), "cooldown-m", cooldownVal, 1, 180, "m", cfg));
    detailsWrap.appendChild(thresholdsWrap);

    // Event: monitoring enable toggle
    enableToggle.addEventListener("change", () => {
      const checked = enableToggle.checked;
      detailsWrap.style.display = checked ? "block" : "none";
      const entityId = cfg.entities?.power || cfg.uuid;
      const data: Record<string, unknown> = {
        circuit_id: entityId,
        monitoring_enabled: checked,
      };
      if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
      this._callDomainService("set_circuit_threshold", data).catch((err: Error) => {
        console.warn("SPAN Panel: monitoring update failed", err);
        this.errorStore?.add({
          key: "service:monitoring",
          level: "error",
          message: t("error.threshold_failed"),
          persistent: false,
        });
      });
    });

    // Event: radio change
    const radios = radioGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    for (const radio of radios) {
      radio.addEventListener("change", () => {
        const isCustom = radio.value === "custom" && radio.checked;
        thresholdsWrap.style.display = isCustom ? "block" : "none";
        if (!isCustom && radio.checked) {
          const entityId = cfg.entities?.power || cfg.uuid;
          const data: Record<string, unknown> = { circuit_id: entityId };
          if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
          this._callDomainService("clear_circuit_threshold", data).catch((err: Error) => {
            console.warn("SPAN Panel: monitoring update failed", err);
            this.errorStore?.add({
              key: "service:monitoring",
              level: "error",
              message: t("error.threshold_failed"),
              persistent: false,
            });
          });
        }
      });
    }

    body.appendChild(section);
  }

  private _createThresholdRow(label: string, key: string, value: number, cfg: CircuitModeConfig): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "field-row";

    const labelEl = document.createElement("span");
    labelEl.className = "field-label";
    labelEl.textContent = label;

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "200";
    input.value = String(value);
    input.dataset.role = `threshold-${key}`;

    input.addEventListener("input", () => {
      this._debounce(`threshold-${key}`, INPUT_DEBOUNCE_MS, () => {
        const shadow = this.shadowRoot;
        if (!shadow) return;
        const continuous = shadow.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]');
        const spike = shadow.querySelector<HTMLInputElement>('[data-role="threshold-spike"]');
        const windowM = shadow.querySelector<HTMLInputElement>('[data-role="threshold-window-m"]');
        const cooldownM = shadow.querySelector<HTMLInputElement>('[data-role="threshold-cooldown-m"]');
        const entityId = cfg.entities?.power || cfg.uuid;
        const data: Record<string, unknown> = {
          circuit_id: entityId,
          continuous_threshold_pct: continuous ? Number(continuous.value) : undefined,
          spike_threshold_pct: spike ? Number(spike.value) : undefined,
          window_duration_m: windowM ? Number(windowM.value) : undefined,
          cooldown_duration_m: cooldownM ? Number(cooldownM.value) : undefined,
        };
        if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
        this._callDomainService("set_circuit_threshold", data).catch((err: Error) => {
          console.warn("SPAN Panel: monitoring update failed", err);
          this.errorStore?.add({
            key: "service:monitoring",
            level: "error",
            message: t("error.threshold_failed"),
            persistent: false,
          });
        });
      });
    });

    row.appendChild(labelEl);
    row.appendChild(input);
    return row;
  }

  private _createDurationRow(
    label: string,
    key: string,
    value: number,
    min: number,
    max: number,
    unit: string,
    cfg: CircuitModeConfig,
    readOnly: boolean = false
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "field-row";

    const labelEl = document.createElement("span");
    labelEl.className = "field-label";
    labelEl.textContent = label;

    const inputWrap = document.createElement("div");

    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.dataset.role = `threshold-${key}`;
    if (readOnly) {
      input.disabled = true;
    }

    const unitSpan = document.createElement("span");
    unitSpan.textContent = unit;

    inputWrap.appendChild(input);
    inputWrap.appendChild(unitSpan);

    if (!readOnly) {
      input.addEventListener("input", () => {
        this._debounce(`threshold-${key}`, INPUT_DEBOUNCE_MS, () => {
          const shadow = this.shadowRoot;
          if (!shadow) return;
          const continuous = shadow.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]');
          const spike = shadow.querySelector<HTMLInputElement>('[data-role="threshold-spike"]');
          const windowM = shadow.querySelector<HTMLInputElement>('[data-role="threshold-window-m"]');
          const data: Record<string, unknown> = {
            circuit_id: cfg.uuid,
            continuous_threshold_pct: continuous ? Number(continuous.value) : undefined,
            spike_threshold_pct: spike ? Number(spike.value) : undefined,
            window_duration_m: windowM ? Number(windowM.value) : undefined,
          };
          if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
          this._callDomainService("set_circuit_threshold", data).catch((err: Error) => {
            console.warn("SPAN Panel: monitoring update failed", err);
            this.errorStore?.add({
              key: "service:monitoring",
              level: "error",
              message: t("error.threshold_failed"),
              persistent: false,
            });
          });
        });
      });
    }

    row.appendChild(labelEl);
    row.appendChild(inputWrap);
    return row;
  }

  // ── Live state updates ──────────────────────────────────────────────

  private _updateLiveState(): void {
    if (!this._config || this._config.panelMode) return;
    const cfg = this._config;

    // Sub-device and favorites modes have no live-updating fields
    if (cfg.subDeviceMode || cfg.favoritesMode) return;

    // Update relay toggle
    if (cfg.entities?.switch) {
      const toggle = this.shadowRoot?.querySelector<SpanSwitchElement>('[data-role="relay-toggle"]');
      if (toggle) {
        const currentState = this._hass?.states?.[cfg.entities.switch]?.state;
        if (currentState === "on") {
          toggle.setAttribute("checked", "");
        } else {
          toggle.removeAttribute("checked");
        }
      }
    }

    // Update shedding select
    if (cfg.entities?.select) {
      const selectEl = this.shadowRoot?.querySelector<HTMLSelectElement>('[data-role="shedding-select"]');
      if (selectEl) {
        const currentPriority = this._hass?.states?.[cfg.entities.select]?.state || "";
        selectEl.value = currentPriority;
      }
    }
  }

  // ── Service calls ───────────────────────────────────────────────────

  private _callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    if (!this._hass) return Promise.resolve();
    return Promise.resolve(this._hass.callService(domain, service, data));
  }

  private _callDomainService(service: string, data: Record<string, unknown>): Promise<void> {
    if (!this._hass) return Promise.resolve();
    return this._hass.callWS({
      type: "call_service",
      domain: INTEGRATION_DOMAIN,
      service,
      service_data: data,
    });
  }

  // ── Debounce ────────────────────────────────────────────────────────

  private _debounce(key: string, ms: number, fn: () => void): void {
    if (this._debounceTimers[key]) {
      clearTimeout(this._debounceTimers[key]);
    }
    this._debounceTimers[key] = setTimeout(() => {
      delete this._debounceTimers[key];
      fn();
    }, ms);
  }
}

try {
  if (!customElements.get("span-side-panel")) {
    customElements.define("span-side-panel", SpanSidePanel);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}
