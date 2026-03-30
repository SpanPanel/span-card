// src/core/side-panel.js
import { escapeHtml } from "../helpers/sanitize.js";
import { INTEGRATION_DOMAIN, SHEDDING_PRIORITIES } from "../constants.js";

const DEBOUNCE_MS = 500;

const PRIORITY_OPTIONS = Object.keys(SHEDDING_PRIORITIES).filter(k => k !== "unknown");

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
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._debounceTimers = {};
  }

  set hass(val) {
    this._hass = val;
    if (this.hasAttribute("open") && this._config) {
      this._updateLiveState();
    }
  }

  get hass() {
    return this._hass;
  }

  open(config) {
    this._config = config;
    this._render();
    // Force reflow before adding attribute so the transition animates
    void this.offsetHeight;
    this.setAttribute("open", "");
  }

  close() {
    this.removeAttribute("open");
    this._config = null;
    this.dispatchEvent(new CustomEvent("side-panel-closed", { bubbles: true, composed: true }));
  }

  // ── Rendering ─────────────────────────────────────────────────────────

  _render() {
    const cfg = this._config;
    if (!cfg) return;

    const shadow = this.shadowRoot;
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
    } else {
      this._renderCircuitMode(panel, cfg);
    }
  }

  _renderPanelMode(panel) {
    const header = this._createHeader("Panel Monitoring", "Global defaults for all circuits");
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "panel-body";

    const info = document.createElement("div");
    info.className = "panel-mode-info";
    info.innerHTML = `
      <p>Global monitoring thresholds apply to all circuits that don't have custom overrides.
         Use the integration's options flow to change global settings.</p>
      <p>Individual circuit thresholds can be configured by clicking the gear icon on a circuit row
         and switching to <strong>Custom</strong> mode.</p>
    `;
    body.appendChild(info);

    const link = document.createElement("button");
    link.textContent = "Configure Global Thresholds";
    Object.assign(link.style, {
      display: "inline-block",
      marginTop: "8px",
      padding: "8px 16px",
      background: "var(--primary-color, #4dd9af)",
      color: "var(--text-primary-color, #000)",
      borderRadius: "4px",
      border: "none",
      cursor: "pointer",
      fontSize: "0.85em",
      fontWeight: "500",
    });
    link.addEventListener("click", () => {
      this.close();
      this.dispatchEvent(new CustomEvent("navigate-tab", { detail: "monitoring", bubbles: true, composed: true }));
    });
    body.appendChild(link);

    panel.appendChild(body);
  }

  _renderCircuitMode(panel, cfg) {
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
    this._renderMonitoringSection(body, cfg);
  }

  _createHeader(title, subtitle) {
    const header = document.createElement("div");
    header.className = "panel-header";

    const titleWrap = document.createElement("div");
    titleWrap.innerHTML = `<div class="title">${title}</div>` + (subtitle ? `<div class="subtitle">${subtitle}</div>` : "");

    const closeBtn = document.createElement("button");
    closeBtn.className = "close-btn";
    closeBtn.innerHTML = "\u2715";
    closeBtn.addEventListener("click", () => this.close());

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    return header;
  }

  // ── Relay section ───────────────────────────────────────────────────

  _renderRelaySection(body, cfg) {
    if (cfg.is_user_controllable === false || !cfg.entities?.switch) return;

    const section = document.createElement("div");
    section.className = "section";
    section.innerHTML = `<div class="section-label">Relay</div>`;

    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = "Breaker";

    const toggle = document.createElement("ha-switch");
    toggle.dataset.role = "relay-toggle";
    const entityId = cfg.entities.switch;
    const currentState = this._hass?.states?.[entityId]?.state;
    if (currentState === "on") {
      toggle.setAttribute("checked", "");
    }

    toggle.addEventListener("change", () => {
      const isOn = toggle.hasAttribute("checked") || toggle.checked;
      this._callService("switch", isOn ? "turn_on" : "turn_off", { entity_id: entityId }).catch(err =>
        this._showError(`Relay toggle failed: ${err.message ?? err}`)
      );
    });

    row.appendChild(label);
    row.appendChild(toggle);
    section.appendChild(row);
    body.appendChild(section);
  }

  // ── Shedding section ────────────────────────────────────────────────

  _renderSheddingSection(body, cfg) {
    if (!cfg.entities?.select) return;

    const section = document.createElement("div");
    section.className = "section";
    section.innerHTML = `<div class="section-label">Shedding Priority</div>`;

    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = "Priority";

    const selectEl = document.createElement("select");
    selectEl.dataset.role = "shedding-select";
    const entityId = cfg.entities.select;
    const currentPriority = this._hass?.states?.[entityId]?.state || "";

    for (const key of PRIORITY_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = SHEDDING_PRIORITIES[key].label;
      if (key === currentPriority) opt.selected = true;
      selectEl.appendChild(opt);
    }

    selectEl.addEventListener("change", () => {
      this._callService("select", "select_option", {
        entity_id: entityId,
        option: selectEl.value,
      }).catch(err => this._showError(`Shedding update failed: ${err.message ?? err}`));
    });

    row.appendChild(label);
    row.appendChild(selectEl);
    section.appendChild(row);
    body.appendChild(section);
  }

  // ── Monitoring section ──────────────────────────────────────────────

  _renderMonitoringSection(body, cfg) {
    const section = document.createElement("div");
    section.className = "section";

    const headerRow = document.createElement("div");
    headerRow.className = "monitoring-header";

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "section-label";
    sectionLabel.textContent = "Monitoring";
    sectionLabel.style.margin = "0";

    const enableToggle = document.createElement("ha-switch");
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

    const hasCustom = info?.continuous_threshold_pct !== undefined;

    // Global / Custom radio
    const radioGroup = document.createElement("div");
    radioGroup.className = "radio-group";
    radioGroup.innerHTML = `
      <label><input type="radio" name="monitoring-mode" value="global" ${!hasCustom ? "checked" : ""} /> Global</label>
      <label><input type="radio" name="monitoring-mode" value="custom" ${hasCustom ? "checked" : ""} /> Custom</label>
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

    thresholdsWrap.appendChild(this._createThresholdRow("Continuous %", "continuous", continuousVal, cfg));
    thresholdsWrap.appendChild(this._createThresholdRow("Spike %", "spike", spikeVal, cfg));
    thresholdsWrap.appendChild(this._createDurationRow("Window duration", "window-m", windowVal, 1, 180, "m", cfg));
    thresholdsWrap.appendChild(this._createDurationRow("Cooldown", "cooldown-m", cooldownVal, 1, 180, "m", cfg));
    detailsWrap.appendChild(thresholdsWrap);

    // Event: monitoring enable toggle
    enableToggle.addEventListener("change", () => {
      const checked = enableToggle.checked;
      detailsWrap.style.display = checked ? "block" : "none";
      const entityId = cfg.entities?.power || cfg.uuid;
      this._callDomainService("set_circuit_threshold", {
        circuit_id: entityId,
        monitoring_enabled: checked,
      }).catch(err => this._showError(`Monitoring toggle failed: ${err.message ?? err}`));
    });

    // Event: radio change
    const radios = radioGroup.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      radio.addEventListener("change", () => {
        const isCustom = radio.value === "custom" && radio.checked;
        thresholdsWrap.style.display = isCustom ? "block" : "none";
        if (!isCustom && radio.checked) {
          const entityId = cfg.entities?.power || cfg.uuid;
          this._callDomainService("clear_circuit_threshold", { circuit_id: entityId }).catch(err =>
            this._showError(`Clear monitoring failed: ${err.message ?? err}`)
          );
        }
      });
    }

    body.appendChild(section);
  }

  _createThresholdRow(label, key, value, cfg) {
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
      this._debounce(`threshold-${key}`, DEBOUNCE_MS, () => {
        const continuous = this.shadowRoot.querySelector('[data-role="threshold-continuous"]');
        const spike = this.shadowRoot.querySelector('[data-role="threshold-spike"]');
        const windowM = this.shadowRoot.querySelector('[data-role="threshold-window-m"]');
        const cooldownM = this.shadowRoot.querySelector('[data-role="threshold-cooldown-m"]');
        const entityId = cfg.entities?.power || cfg.uuid;
        this._callDomainService("set_circuit_threshold", {
          circuit_id: entityId,
          continuous_threshold_pct: continuous ? Number(continuous.value) : undefined,
          spike_threshold_pct: spike ? Number(spike.value) : undefined,
          window_duration_m: windowM ? Number(windowM.value) : undefined,
          cooldown_duration_m: cooldownM ? Number(cooldownM.value) : undefined,
        }).catch(err => this._showError(`Save threshold failed: ${err.message ?? err}`));
      });
    });

    row.appendChild(labelEl);
    row.appendChild(input);
    return row;
  }

  _createDurationRow(label, key, value, min, max, unit, cfg, readOnly = false) {
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
        this._debounce(`threshold-${key}`, DEBOUNCE_MS, () => {
          const continuous = this.shadowRoot.querySelector('[data-role="threshold-continuous"]');
          const spike = this.shadowRoot.querySelector('[data-role="threshold-spike"]');
          const windowM = this.shadowRoot.querySelector('[data-role="threshold-window-m"]');
          this._callDomainService("set_circuit_threshold", {
            circuit_id: cfg.uuid,
            continuous_threshold_pct: continuous ? Number(continuous.value) : undefined,
            spike_threshold_pct: spike ? Number(spike.value) : undefined,
            window_duration_m: windowM ? Number(windowM.value) : undefined,
          }).catch(err => this._showError(`Save threshold failed: ${err.message ?? err}`));
        });
      });
    }

    row.appendChild(labelEl);
    row.appendChild(inputWrap);
    return row;
  }

  // ── Live state updates ──────────────────────────────────────────────

  _updateLiveState() {
    if (!this._config || this._config.panelMode) return;
    const cfg = this._config;

    // Update relay toggle
    if (cfg.entities?.switch) {
      const toggle = this.shadowRoot.querySelector('[data-role="relay-toggle"]');
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
      const selectEl = this.shadowRoot.querySelector('[data-role="shedding-select"]');
      if (selectEl) {
        const currentPriority = this._hass?.states?.[cfg.entities.select]?.state || "";
        selectEl.value = currentPriority;
      }
    }
  }

  // ── Service calls ───────────────────────────────────────────────────

  _callService(domain, service, data) {
    if (!this._hass) return Promise.resolve();
    return Promise.resolve(this._hass.callService(domain, service, data));
  }

  _callDomainService(service, data) {
    return this._callService(INTEGRATION_DOMAIN, service, data);
  }

  // ── Error display ───────────────────────────────────────────────────

  _showError(message) {
    const el = this.shadowRoot.getElementById("error-msg");
    if (el) {
      el.textContent = message;
      el.style.display = "block";
      setTimeout(() => {
        el.style.display = "none";
      }, 5000);
    }
  }

  // ── Debounce ────────────────────────────────────────────────────────

  _debounce(key, ms, fn) {
    if (this._debounceTimers[key]) {
      clearTimeout(this._debounceTimers[key]);
    }
    this._debounceTimers[key] = setTimeout(() => {
      delete this._debounceTimers[key];
      fn();
    }, ms);
  }
}

customElements.define("span-side-panel", SpanSidePanel);
