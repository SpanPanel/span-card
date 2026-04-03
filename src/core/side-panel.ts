// src/core/side-panel.ts
import { escapeHtml } from "../helpers/sanitize.js";
import { INTEGRATION_DOMAIN, SHEDDING_PRIORITIES, GRAPH_HORIZONS, DEFAULT_GRAPH_HORIZON, ERROR_DISPLAY_MS, INPUT_DEBOUNCE_MS } from "../constants.js";
import { t } from "../i18n.js";
import type { HomeAssistant, PanelTopology, GraphSettings, CircuitEntities, CircuitGraphOverride, MonitoringPointInfo } from "../types.js";

const PRIORITY_OPTIONS: string[] = Object.keys(SHEDDING_PRIORITIES).filter(k => k !== "unknown" && k !== "always_on");

// ── Interfaces for config shapes passed to open() ────────────────────────

interface GraphHorizonInfo extends CircuitGraphOverride {
  globalHorizon: string;
}

interface PanelModeConfig {
  panelMode: true;
  subDeviceMode?: undefined;
  topology: PanelTopology;
  graphSettings: GraphSettings | null;
}

interface CircuitModeConfig {
  panelMode?: undefined;
  subDeviceMode?: undefined;
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
}

interface SubDeviceModeConfig {
  panelMode?: undefined;
  subDeviceMode: true;
  subDeviceId: string;
  name: string;
  deviceType: string;
  graphHorizonInfo: GraphHorizonInfo;
}

type SidePanelConfig = PanelModeConfig | CircuitModeConfig | SubDeviceModeConfig;

// ── Custom element interface for ha-switch ───────────────────────────────

interface HaSwitchElement extends HTMLElement {
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

  .monitoring-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-mode-info {
    font-size: 14px;
    color: var(--primary-text-color, #212121);
    line-height: 1.6;
  }
  .panel-mode-info p {
    margin: 0 0 12px 0;
  }

  .error-msg {
    color: var(--error-color, #f44336);
    font-size: 0.8em;
    padding: 8px;
    margin: 8px 0;
    background: rgba(244, 67, 54, 0.1);
    border-radius: 4px;
  }
`;

// ── Component ─────────────────────────────────────────────────────────────

class SpanSidePanel extends HTMLElement {
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

  open(config: SidePanelConfig): void {
    this._config = config;
    this._render();
    // Force reflow before adding attribute so the transition animates
    void this.offsetHeight;
    this.setAttribute("open", "");
  }

  close(): void {
    this.removeAttribute("open");
    this._config = null;
    this.dispatchEvent(new CustomEvent("side-panel-closed", { bubbles: true, composed: true }));
  }

  /** The circuit UUID shown by the panel, if a circuit is open. */
  get currentUuid(): string | null {
    const cfg = this._config;
    if (!cfg || cfg.panelMode || cfg.subDeviceMode) return null;
    return cfg.uuid;
  }

  /** The sub-device ID shown by the panel, if a sub-device is open. */
  get currentSubDeviceId(): string | null {
    const cfg = this._config;
    if (!cfg || !cfg.subDeviceMode) return null;
    return cfg.subDeviceId;
  }

  /** Whether the panel is showing the panel-wide settings view. */
  get isPanelMode(): boolean {
    return this._config?.panelMode === true;
  }

  /** Update graph horizon data on an open panel and re-render. */
  updateGraphSettings(graphHorizonInfo: GraphHorizonInfo): void;
  updateGraphSettings(graphSettings: GraphSettings | null): void;
  updateGraphSettings(data: GraphHorizonInfo | GraphSettings | null): void {
    if (!this._config || !this.hasAttribute("open")) return;
    if (this._config.panelMode) {
      this._config = { ...this._config, graphSettings: data as GraphSettings | null };
    } else {
      this._config = { ...this._config, graphHorizonInfo: data as GraphHorizonInfo };
    }
    this._render();
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

    if (cfg.panelMode) {
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

    const errorEl = document.createElement("div");
    errorEl.className = "error-msg";
    errorEl.id = "error-msg";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    const graphSettings = cfg.graphSettings;
    const topology = cfg.topology;
    const globalHorizon = graphSettings?.global_horizon ?? DEFAULT_GRAPH_HORIZON;
    const circuitSettings = graphSettings?.circuits ?? {};

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
      this._callDomainService("set_graph_time_horizon", { horizon: globalSelect.value })
        .then(() => {
          this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
        })
        .catch((err: Error) => this._showError(`${err.message ?? err}`));
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
        const row = document.createElement("div");
        row.className = "field-row";

        const nameLabel = document.createElement("span");
        nameLabel.className = "field-label";
        nameLabel.textContent = circuit.name || uuid;
        nameLabel.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;";
        row.appendChild(nameLabel);

        const circuitData = circuitSettings[uuid] || { horizon: globalHorizon, has_override: false };
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
            this._callDomainService("set_circuit_graph_horizon", {
              circuit_id: uuid,
              horizon: select.value,
            })
              .then(() => {
                this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
              })
              .catch((err: Error) => this._showError(`${err.message ?? err}`));
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
            this._callDomainService("clear_circuit_graph_horizon", { circuit_id: uuid })
              .then(() => {
                select.value = globalHorizon;
                resetBtn.remove();
                this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
              })
              .catch((err: Error) => this._showError(`${err.message ?? err}`));
          });
          row.appendChild(resetBtn);
        }

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
            this._callDomainService("set_subdevice_graph_horizon", {
              subdevice_id: devId,
              horizon: select.value,
            })
              .then(() => {
                this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
              })
              .catch((err: Error) => this._showError(`${err.message ?? err}`));
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
            this._callDomainService("clear_subdevice_graph_horizon", { subdevice_id: devId })
              .then(() => {
                select.value = globalHorizon;
                resetBtn.remove();
                this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
              })
              .catch((err: Error) => this._showError(`${err.message ?? err}`));
          });
          row.appendChild(resetBtn);
        }

        subDevSection.appendChild(row);
      }

      body.appendChild(subDevSection);
    }

    panel.appendChild(body);
  }

  private _renderCircuitMode(panel: HTMLDivElement, cfg: CircuitModeConfig): void {
    const subtitle = `${escapeHtml(String(cfg.breaker_rating_a))}A \u00b7 ${escapeHtml(String(cfg.voltage))}V \u00b7 Tabs [${escapeHtml(String(cfg.tabs))}]`;
    const header = this._createHeader(escapeHtml(cfg.name), subtitle);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";
    panel.appendChild(body);

    const errorEl = document.createElement("div");
    errorEl.className = "error-msg";
    errorEl.id = "error-msg";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    this._renderRelaySection(body, cfg);
    this._renderSheddingSection(body, cfg);
    this._renderGraphHorizonSection(body, cfg);
    if (cfg.showMonitoring) {
      this._renderMonitoringSection(body, cfg);
    }
  }

  private _renderSubDeviceMode(panel: HTMLDivElement, cfg: SubDeviceModeConfig): void {
    const header = this._createHeader(escapeHtml(cfg.name), escapeHtml(cfg.deviceType));
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";
    panel.appendChild(body);

    const errorEl = document.createElement("div");
    errorEl.className = "error-msg";
    errorEl.id = "error-msg";
    errorEl.style.display = "none";
    body.appendChild(errorEl);

    this._renderSubDeviceHorizonSection(body, cfg);
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
        if (key === "global") {
          updateSegmentStates("global");
          this._callDomainService("clear_subdevice_graph_horizon", { subdevice_id: subDeviceId })
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => this._showError(`${t("sidepanel.clear_graph_horizon_failed")} ${err.message ?? err}`));
        } else {
          updateSegmentStates(key);
          this._callDomainService("set_subdevice_graph_horizon", {
            subdevice_id: subDeviceId,
            horizon: key,
          })
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => this._showError(`${t("sidepanel.graph_horizon_failed")} ${err.message ?? err}`));
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

    const toggle = document.createElement("ha-switch") as HaSwitchElement;
    toggle.dataset.role = "relay-toggle";
    const entityId = cfg.entities.switch;
    const currentState = this._hass?.states?.[entityId]?.state;
    if (currentState === "on") {
      toggle.setAttribute("checked", "");
    }

    toggle.addEventListener("change", () => {
      const isOn = toggle.hasAttribute("checked") || toggle.checked;
      this._callService("switch", isOn ? "turn_on" : "turn_off", { entity_id: entityId }).catch((err: Error) =>
        this._showError(`${t("sidepanel.relay_failed")} ${err.message ?? err}`)
      );
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
      this._callService("select", "select_option", {
        entity_id: entityId,
        option: selectEl.value,
      }).catch((err: Error) => this._showError(`${t("sidepanel.shedding_failed")} ${err.message ?? err}`));
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
        if (key === "global") {
          updateSegmentStates("global");
          this._callDomainService("clear_circuit_graph_horizon", { circuit_id: circuitId })
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => this._showError(`${t("sidepanel.clear_graph_horizon_failed")} ${err.message ?? err}`));
        } else {
          updateSegmentStates(key);
          this._callDomainService("set_circuit_graph_horizon", {
            circuit_id: circuitId,
            horizon: key,
          })
            .then(() => {
              this.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            })
            .catch((err: Error) => this._showError(`${t("sidepanel.graph_horizon_failed")} ${err.message ?? err}`));
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

    const enableToggle = document.createElement("ha-switch") as HaSwitchElement;
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
      this._callDomainService("set_circuit_threshold", {
        circuit_id: entityId,
        monitoring_enabled: checked,
      }).catch((err: Error) => this._showError(`${t("sidepanel.monitoring_toggle_failed")} ${err.message ?? err}`));
    });

    // Event: radio change
    const radios = radioGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    for (const radio of radios) {
      radio.addEventListener("change", () => {
        const isCustom = radio.value === "custom" && radio.checked;
        thresholdsWrap.style.display = isCustom ? "block" : "none";
        if (!isCustom && radio.checked) {
          const entityId = cfg.entities?.power || cfg.uuid;
          this._callDomainService("clear_circuit_threshold", { circuit_id: entityId }).catch((err: Error) =>
            this._showError(`${t("sidepanel.clear_monitoring_failed")} ${err.message ?? err}`)
          );
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
        this._callDomainService("set_circuit_threshold", {
          circuit_id: entityId,
          continuous_threshold_pct: continuous ? Number(continuous.value) : undefined,
          spike_threshold_pct: spike ? Number(spike.value) : undefined,
          window_duration_m: windowM ? Number(windowM.value) : undefined,
          cooldown_duration_m: cooldownM ? Number(cooldownM.value) : undefined,
        }).catch((err: Error) => this._showError(`${t("sidepanel.save_threshold_failed")} ${err.message ?? err}`));
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
          this._callDomainService("set_circuit_threshold", {
            circuit_id: cfg.uuid,
            continuous_threshold_pct: continuous ? Number(continuous.value) : undefined,
            spike_threshold_pct: spike ? Number(spike.value) : undefined,
            window_duration_m: windowM ? Number(windowM.value) : undefined,
          }).catch((err: Error) => this._showError(`${t("sidepanel.save_threshold_failed")} ${err.message ?? err}`));
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

    // Sub-device mode has no live-updating fields
    if (cfg.subDeviceMode) return;

    // Update relay toggle
    if (cfg.entities?.switch) {
      const toggle = this.shadowRoot?.querySelector<HaSwitchElement>('[data-role="relay-toggle"]');
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

  // ── Error display ───────────────────────────────────────────────────

  private _showError(message: string): void {
    const el = this.shadowRoot?.getElementById("error-msg");
    if (el) {
      el.textContent = message;
      el.style.display = "block";
      setTimeout(() => {
        el.style.display = "none";
      }, ERROR_DISPLAY_MS);
    }
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
