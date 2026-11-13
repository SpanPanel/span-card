// src/core/side-panel.ts
import { escapeHtml } from "../helpers/sanitize.js";
import { loadListColumns, saveListColumns } from "../helpers/list-columns.js";
import { INTEGRATION_DOMAIN, SHEDDING_PRIORITIES, SELECTABLE_PRIORITY_KEYS, GRAPH_HORIZONS, DEFAULT_GRAPH_HORIZON, INPUT_DEBOUNCE_MS } from "../constants.js";
import { t, tf } from "../i18n.js";
import { judgedAgainstSentence, monitoringRatingView } from "../helpers/monitoring-rating.js";
import { serviceErrorMessage } from "../helpers/error-text.js";
import { occupiedSpaces, slotRatingText, type SlotMember } from "../helpers/shared-meters.js";
import { guardNumberWheel, PackageRatingsEditor, type PackageRatingsHost, type PackageRatingsState } from "./package-ratings-editor.js";
import { addFavorite, removeFavorite } from "./favorites-store.js";
import { sortedCircuitsForSection } from "./favorites-sections.js";
import { subDeviceCharts } from "../helpers/sub-device-power.js";
import { subDeviceFavoriteEntityId } from "../helpers/sub-device-settings.js";
import { relayClosed, selectOperable, shedPriorityKey, switchPresence, type CircuitControlFields } from "./circuit-state.js";
import type { SpanSwitch } from "./span-switch.js";
import type {
  HomeAssistant,
  PanelTopology,
  GraphSettings,
  CircuitEntities,
  CircuitGraphOverride,
  MonitoringGlobalSettings,
  MonitoringPointInfo,
} from "../types.js";
import type { ErrorStore } from "./error-store.js";

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

/** What a rating change redraws in an open circuit side panel: the slot's members, its subtitle text, and the monitoring point it is judged as. */
export interface CircuitRatingView {
  members: readonly SlotMember[];
  capacityA: number | null;
  monitoringInfo: MonitoringPointInfo | null;
  /** The panel's global thresholds, from the status `monitoringInfo` came from; null where not known. */
  monitoringGlobals: MonitoringGlobalSettings | null;
}

export type CircuitModeConfig = CircuitControlFields & {
  panelMode?: undefined;
  subDeviceMode?: undefined;
  favoritesMode?: undefined;
  uuid: string;
  name: string;
  /**
   * Every circuit drawn in the slot this panel opened on, each with the id the services take; a circuit alone is a
   * slot of one. The subtitle reads each one's rating, voltage and spaces from them.
   */
  members: readonly SlotMember[];
  /** For circuits that share a meter, the group's capacity, which they are judged against; null for a circuit alone or where unknown. */
  capacityA: number | null;
  monitoringInfo: MonitoringPointInfo | null;
  showMonitoring?: boolean;
  /** The panel's global thresholds, from the `get_monitoring_status` answer `monitoringInfo` came from; null where not known. */
  monitoringGlobals?: MonitoringGlobalSettings | null;
  /**
   * True where the circuit's panel takes package ratings copied from the SPAN app (topology
   * `monitoring_rating_offered`); anything else, an older integration's silence included, draws no editor.
   */
  monitoringRatingOffered?: boolean;
  graphHorizonInfo: GraphHorizonInfo;
  /** Dashboard-only: render the Favorite section on this side panel. */
  showFavorites?: boolean;
  /** HA device id of the panel that owns this circuit. */
  favoritePanelDeviceId?: string;
  /** Initial favorite state; ``addFavorite``/``removeFavorite`` update live. */
  isFavorite?: boolean;
  /** Route domain service calls to this config entry (favorites view). */
  configEntryId?: string | null;
};

interface SubDeviceModeConfig {
  panelMode?: undefined;
  subDeviceMode: true;
  favoritesMode?: undefined;
  subDeviceId: string;
  name: string;
  deviceType: string;
  /** Sub-device entity registry map from topology, used to pick a routable entity_id for favoriting. */
  entities?: Record<string, { domain: string }>;
  /** Whether the tile draws a chart; a tile with none has no graph horizon to set. */
  hasChart: boolean;
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

export type SidePanelConfig = PanelModeConfig | CircuitModeConfig | SubDeviceModeConfig | FavoritesModeConfig;

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

  .rating-section {
    margin-bottom: 8px;
  }
  .rating-row {
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 6px 8px;
  }
  .rating-row [data-role="rating-panel-rating"] {
    flex-basis: 100%;
  }
  .rating-feedback {
    font-size: 13px;
    color: var(--error-color, #db4437);
  }
  .rating-warning {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin-top: 6px;
    padding: 8px;
    border-left: 3px solid var(--warning-color, #ffa600);
    border-radius: 4px;
    background: color-mix(in srgb, var(--warning-color, #ffa600) 12%, transparent);
    font-size: 13px;
  }

  .text-btn {
    background: none;
    border: 1px solid var(--divider-color, #e0e0e0);
    color: var(--primary-text-color, #212121);
    border-radius: 4px;
    padding: 4px 8px;
    font: inherit;
    font-size: 13px;
    line-height: 1.3;
    cursor: pointer;
  }
  .text-btn:hover:not(:disabled):not([aria-disabled="true"]) {
    background: var(--secondary-background-color, #f5f5f5);
  }
  .text-btn:focus-visible {
    outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: 1px;
  }
  .text-btn:disabled,
  .text-btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: default;
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

class SpanSidePanel extends HTMLElement implements PackageRatingsHost {
  errorStore: ErrorStore | null = null;
  private _hass: HomeAssistant | null;
  private _config: SidePanelConfig | null;
  private readonly _ratingsEditor: PackageRatingsEditor;
  private _debounceTimers: Record<string, ReturnType<typeof setTimeout>>;
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._debounceTimers = {};
    this._ratingsEditor = new PackageRatingsEditor(this);
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

  /** The circuit this side panel is open on, with the config entry its services target; null when closed or in another mode. */
  get openCircuit(): { uuid: string; configEntryId: string | null } | null {
    const cfg = this._config;
    if (!cfg || !this.hasAttribute("open") || cfg.panelMode || cfg.subDeviceMode || cfg.favoritesMode) return null;
    return { uuid: cfg.uuid, configEntryId: cfg.configEntryId ?? null };
  }

  /**
   * Redraw what a rating change touches in the open circuit panel, from the
   * integration's answer: the subtitle, the "judged against" line, and the package
   * ratings editor in the Monitoring section, which patches itself in place, so a
   * focused control keeps focus and a field being typed in keeps what was typed.
   * Nothing else is rebuilt, so a threshold the user is typing keeps its value.
   */
  refreshRating(view: CircuitRatingView): void {
    const cfg = this._config;
    const shadow = this.shadowRoot;
    if (!cfg || !shadow || !this.hasAttribute("open") || cfg.panelMode || cfg.subDeviceMode || cfg.favoritesMode) return;

    const next: CircuitModeConfig = {
      ...cfg,
      members: view.members,
      capacityA: view.capacityA,
      monitoringInfo: view.monitoringInfo,
      monitoringGlobals: view.monitoringGlobals,
    };
    this._config = next;

    const subtitle = shadow.querySelector(".subtitle");
    if (subtitle) subtitle.textContent = this._circuitSubtitle(next);

    const judged = shadow.querySelector('[data-role="judged-against"]');
    if (judged) {
      const text = this._judgedAgainstText(next.monitoringInfo);
      // Set only on a change, so the live region announces a change and nothing else.
      if (judged.textContent !== text) judged.textContent = text;
      this._ratingsEditor.sync(judged);
    }
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
        // A sub-device with no chart has no horizon to set. Its row stays only
        // to carry its favorite heart, and is left out where there is none.
        const hasChart = subDeviceCharts(sub).length > 0;
        const heart =
          cfg.showFavorites && cfg.favoritePanelDeviceId
            ? this._buildSubDeviceFavoriteHeart(sub.entities, cfg.favoriteSubDeviceIds?.has(devId) ?? false)
            : null;
        if (!hasChart && !heart) continue;

        const row = document.createElement("div");
        row.className = "field-row";

        const nameLabel = document.createElement("span");
        nameLabel.className = "field-label";
        nameLabel.textContent = sub.name || devId;
        nameLabel.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;";
        row.appendChild(nameLabel);

        if (heart) row.appendChild(heart);

        if (!hasChart) {
          subDevSection.appendChild(row);
          continue;
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

      // The label is the section's first child; any more are rows.
      if (subDevSection.children.length > 1) body.appendChild(subDevSection);
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
    const header = this._createHeader(escapeHtml(cfg.name), this._circuitSubtitle(cfg));
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

  /**
   * The header line for the slot the panel opened on, as plain text: each breaker's rating as the grid labels it, a
   * shared meter's capacity, the members' voltages and every space they occupy. A part with nothing known is left out.
   */
  private _circuitSubtitle(cfg: CircuitModeConfig): string {
    const circuits = cfg.members.map(member => member.circuit);
    const voltages = [...new Set(circuits.flatMap(circuit => (circuit.voltage ? [circuit.voltage] : [])))].sort((a, b) => a - b);
    const parts = [
      slotRatingText(circuits),
      circuits.length > 1 && cfg.capacityA ? tf("sidepanel.capacity", { amps: String(cfg.capacityA) }) : "",
      voltages.length > 0 ? `${voltages.join("/")}V` : "",
      `Tabs [${occupiedSpaces(circuits).join(",")}]`,
    ];
    return parts.filter(Boolean).join(" \u00b7 ");
  }

  private _favoriteEntityId(entities: CircuitEntities | undefined): string | null {
    return entities?.current ?? entities?.power ?? null;
  }

  /**
   * Build a heart toggle for a sub-device row in panel-mode Graph
   * Settings. Returns ``null`` when the sub-device has no entities to
   * resolve (favorites services need an entity_id).
   */
  private _buildSubDeviceFavoriteHeart(entities: Record<string, { domain: string }> | undefined, isFavorite: boolean): HTMLButtonElement | null {
    const entityId = subDeviceFavoriteEntityId(entities);
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
   * placing a span-switch directly under the breaker relay switch.
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
    if (cfg.hasChart) {
      this._renderSubDeviceHorizonSection(body, cfg);
    }
  }

  private _renderSubDeviceFavoriteSection(body: HTMLDivElement, cfg: SubDeviceModeConfig): void {
    const entityId = subDeviceFavoriteEntityId(cfg.entities);
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
    if (!this._hass || switchPresence(cfg, this._hass) === "none") return;

    const section = document.createElement("div");
    section.className = "section";
    section.innerHTML = `<div class="section-label">${escapeHtml(t("sidepanel.relay"))}</div>`;

    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = t("sidepanel.breaker");

    const toggle = document.createElement("span-switch");
    toggle.dataset.role = "relay-toggle";
    const entityId = cfg.entities.switch;
    this._applyRelayToggle(toggle, cfg);

    toggle.addEventListener("change", () => {
      if (!this._hass || switchPresence(cfg, this._hass) !== "operable") return;
      // The switch has already flipped `checked`; its attribute reflects only on
      // Lit's next update, so it still reads the old state here.
      const isOn = toggle.checked;
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

    for (const key of SELECTABLE_PRIORITY_KEYS) {
      const priority = SHEDDING_PRIORITIES[key];
      if (!priority) continue;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = t(`shedding.select.${key}`) || priority.label();
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
    // Once attached: happy-dom re-runs selectedness when the select is connected,
    // which would choose the first option over an unknown priority.
    this._applySheddingSelect(selectEl, cfg);
  }

  // ── Package ratings editor (inside the Monitoring section) ──────────

  /** What the package ratings editor draws from: the open circuit's slot and monitoring; null in any other mode. */
  get ratingsState(): PackageRatingsState | null {
    const cfg = this._config;
    if (!cfg || cfg.panelMode || cfg.subDeviceMode || cfg.favoritesMode || !cfg.showMonitoring) return null;
    return {
      members: cfg.members ?? [],
      monitoringInfo: cfg.monitoringInfo,
      monitoringGlobals: cfg.monitoringGlobals ?? null,
      offered: cfg.monitoringRatingOffered === true,
    };
  }

  setPackageRatings(uuid: string, ratings: readonly number[]): Promise<void> {
    return this._callDomainService("set_circuit_package_ratings", this._ratingsPayload(uuid, { package_ratings_a: [...ratings] }));
  }

  clearPackageRatings(uuid: string): Promise<void> {
    return this._callDomainService("clear_circuit_package_ratings", this._ratingsPayload(uuid, {}));
  }

  /** A refusal shows the integration's message in the user's language (`serviceErrorMessage`), else the generic one. */
  reportRatingsFailure(err: unknown): void {
    console.warn("SPAN Panel: package ratings update failed", err);
    void serviceErrorMessage(this._hass, err, INTEGRATION_DOMAIN, t("error.package_ratings_failed")).then(message => {
      this.errorStore?.add({ key: "service:package-ratings", level: "error", message, persistent: false });
    });
  }

  /**
   * Choose the global thresholds for the open circuit, as the Global choice does:
   * the choice and the hidden fields show it at once, and they are put back if
   * clearing the override fails. Resolves whether it succeeded; on success the
   * circuit's monitoring reads as having no override, so the editor's warning
   * follows without waiting for a refresh.
   */
  async useGlobalThresholds(): Promise<boolean> {
    const cfg = this._config;
    const shadow = this.shadowRoot;
    if (!cfg || !shadow || cfg.panelMode || cfg.subDeviceMode || cfg.favoritesMode) return false;
    const global = shadow.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="global"]');
    const custom = shadow.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="custom"]');
    const fields = shadow.querySelector<HTMLElement>('[data-role="threshold-fields"]');
    if (global) global.checked = true;
    if (fields) fields.style.display = "none";
    const data: Record<string, unknown> = { circuit_id: cfg.entities?.power || cfg.uuid };
    if (cfg.configEntryId) data.config_entry_id = cfg.configEntryId;
    try {
      await this._callDomainService("clear_circuit_threshold", data);
    } catch (err: unknown) {
      console.warn("SPAN Panel: monitoring update failed", err);
      this.errorStore?.add({ key: "service:monitoring", level: "error", message: t("error.threshold_failed"), persistent: false });
      if (this._config === cfg) {
        if (custom) custom.checked = true;
        if (fields) fields.style.display = "block";
      }
      return false;
    }
    // The circuit now takes the global thresholds, where they are known.
    const globals = this._config === cfg ? (cfg.monitoringGlobals ?? null) : null;
    this._thresholdsChanged(cfg.uuid, {
      has_override: false,
      continuous_threshold_pct: globals?.continuous_threshold_pct,
      spike_threshold_pct: globals?.spike_threshold_pct,
    });
    return true;
  }

  /** Focus the Global/Custom choice that follows the editor, the one now chosen. */
  focusAfterRatingsEditor(): void {
    const shadow = this.shadowRoot;
    const radio =
      shadow?.querySelector<HTMLInputElement>('input[name="monitoring-mode"]:checked') ??
      shadow?.querySelector<HTMLInputElement>('input[name="monitoring-mode"]');
    radio?.focus();
  }

  private _ratingsPayload(uuid: string, data: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = { circuit_id: uuid, ...data };
    const cfg = this._config;
    const entryId = cfg && !cfg.panelMode && !cfg.subDeviceMode && !cfg.favoritesMode ? cfg.configEntryId : null;
    if (entryId) payload.config_entry_id = entryId;
    return payload;
  }

  /**
   * Fold a threshold change the integration accepted for circuit `uuid` into the
   * open circuit's monitoring, so what reads it, the editor's warning, follows at
   * once rather than at the next refresh. Ignored where the panel has since closed
   * or moved to another circuit.
   */
  private _thresholdsChanged(uuid: string, change: Partial<MonitoringPointInfo>): void {
    const cfg = this._config;
    if (!cfg || cfg.panelMode || cfg.subDeviceMode || cfg.favoritesMode || cfg.uuid !== uuid || !this.hasAttribute("open")) return;
    this._config = { ...cfg, monitoringInfo: { ...(cfg.monitoringInfo ?? {}), ...change } };
    const judged = this.shadowRoot?.querySelector('[data-role="judged-against"]');
    if (judged) this._ratingsEditor.sync(judged);
  }

  // ── Graph horizon section ──────────────────────────────────────────

  private _renderGraphHorizonSection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    const section = document.createElement("div");
    section.className = "section";
    section.dataset.role = "horizon-section";

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

  /** "Judged against 40 A: 20-20 from your SPAN app (the panel publishes 20 A)", or "Judged against: no rating" when the point has none. */
  private _judgedAgainstText(info: MonitoringPointInfo | null): string {
    return judgedAgainstSentence(monitoringRatingView(info));
  }

  private _renderMonitoringSection(body: HTMLDivElement, cfg: CircuitModeConfig): void {
    const section = document.createElement("div");
    section.className = "section";

    const headerRow = document.createElement("div");
    headerRow.className = "monitoring-header";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = t("sidepanel.monitoring");
    sectionLabel.style.margin = "0";

    const enableToggle = document.createElement("span-switch");
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

    // The rating the monitor judges this point against; textContent, so the text needs no escaping.
    // A polite live region: a copy applying or going is announced as the line changes.
    const judged = document.createElement("div");
    judged.className = "field-label";
    judged.dataset.role = "judged-against";
    judged.setAttribute("aria-live", "polite");
    judged.style.marginBottom = "8px";
    judged.textContent = this._judgedAgainstText(info);
    detailsWrap.appendChild(judged);

    // The package ratings editor: above Global/Custom, shown in both modes, hidden with the details.
    this._ratingsEditor.mount(judged);

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

    // Event: radio change. Choosing Global is the threshold reset, which puts the choice back if it fails.
    const radios = radioGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    for (const radio of radios) {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        if (radio.value === "custom") thresholdsWrap.style.display = "block";
        else void this.useGlobalThresholds();
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
    guardNumberWheel(input);

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
        this._saveThresholds(cfg.uuid, data);
      });
    });

    row.appendChild(labelEl);
    row.appendChild(input);
    return row;
  }

  /**
   * Save the circuit's custom thresholds. Once the integration accepts them, the
   * open circuit's monitoring reads them, so what depends on them, the package
   * ratings editor's warning, follows without waiting for a refresh.
   */
  private _saveThresholds(uuid: string, data: Record<string, unknown>): void {
    this._callDomainService("set_circuit_threshold", data).then(
      () => {
        const change: Partial<MonitoringPointInfo> = { has_override: true };
        if (typeof data.continuous_threshold_pct === "number") change.continuous_threshold_pct = data.continuous_threshold_pct;
        if (typeof data.spike_threshold_pct === "number") change.spike_threshold_pct = data.spike_threshold_pct;
        this._thresholdsChanged(uuid, change);
      },
      (err: unknown) => {
        console.warn("SPAN Panel: monitoring update failed", err);
        this.errorStore?.add({
          key: "service:monitoring",
          level: "error",
          message: t("error.threshold_failed"),
          persistent: false,
        });
      }
    );
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
    guardNumberWheel(input);
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
          this._saveThresholds(cfg.uuid, data);
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
      const toggle = this.shadowRoot?.querySelector<SpanSwitch>('[data-role="relay-toggle"]');
      if (toggle) this._applyRelayToggle(toggle, cfg);
    }

    // Update shedding select
    if (cfg.entities?.select) {
      const selectEl = this.shadowRoot?.querySelector<HTMLSelectElement>('[data-role="shedding-select"]');
      if (selectEl) this._applySheddingSelect(selectEl, cfg);
    }
  }

  /** The relay switch shows the relay state; it is disabled while Home Assistant reports it unavailable. */
  private _applyRelayToggle(toggle: SpanSwitch, cfg: CircuitModeConfig): void {
    if (!this._hass) return;
    toggle.disabled = switchPresence(cfg, this._hass) !== "operable";
    if (relayClosed(cfg, this._hass)) toggle.setAttribute("checked", "");
    else toggle.removeAttribute("checked");
  }

  /** The select shows the last known priority, or none chosen when it is unknown, and is disabled unless operable. */
  private _applySheddingSelect(selectEl: HTMLSelectElement, cfg: CircuitModeConfig): void {
    if (!this._hass) return;
    const key = shedPriorityKey(cfg, this._hass);
    if (SELECTABLE_PRIORITY_KEYS.includes(key)) selectEl.value = key;
    else selectEl.selectedIndex = -1;
    selectEl.disabled = !selectOperable(cfg, this._hass);
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
