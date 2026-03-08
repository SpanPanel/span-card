/**
 * SPAN Panel Card — Custom Lovelace card for Home Assistant
 *
 * Renders a physical representation of a SPAN electrical panel,
 * showing circuits laid out by their actual tab positions.
 *
 * Config:
 *   type: custom:span-panel-card
 *   device_id: <HA device registry ID for the SPAN Panel>
 */

const CARD_VERSION = "0.1.0";

// ─── Tabs attribute parser ───────────────────────────────────────────────────

function parseTabs(tabsAttr) {
  // "tabs [15]"   → [15]
  // "tabs [5:6]"  → [5, 6]
  if (!tabsAttr || !tabsAttr.startsWith("tabs [")) return null;
  const content = tabsAttr.slice(6, -1); // strip "tabs [" and "]"
  if (content.includes(":")) {
    const parts = content.split(":").map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return parts;
  } else {
    const n = Number(content);
    if (Number.isFinite(n)) return [n];
  }
  return null;
}

function tabToRow(tab) {
  return Math.ceil(tab / 2);
}

function tabToCol(tab) {
  // Odd = left (0), even = right (1)
  return tab % 2 === 0 ? 1 : 0;
}

// ─── Card Element ────────────────────────────────────────────────────────────

class SpanPanelCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._discovered = false;
    this._discovering = false;

    // Discovery results
    this._panelDevice = null;
    this._circuitMap = new Map(); // tab → circuit info
    this._panelSize = 32;
    this._panelEntities = []; // non-circuit panel entities
    this._subDevices = []; // EVSE / BESS

    // Render throttle
    this._lastRenderHash = "";
  }

  setConfig(config) {
    if (!config.device_id) {
      throw new Error("Please configure a device_id for the SPAN Panel card");
    }
    this._config = config;
    this._discovered = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._discovered && !this._discovering) {
      this._discovering = true;
      this._discoverEntities().then(() => {
        this._discovered = true;
        this._discovering = false;
        this._render();
      });
      return;
    }
    if (this._discovered) {
      this._render();
    }
  }

  getCardSize() {
    return Math.ceil(this._panelSize / 2) + 2;
  }

  static getConfigElement() {
    return document.createElement("span-panel-card-editor");
  }

  static getStubConfig(hass) {
    // Try to find a SPAN device
    for (const entityId of Object.keys(hass.states)) {
      if (entityId.startsWith("sensor.span_panel_")) {
        const stateObj = hass.states[entityId];
        if (stateObj.attributes.tabs) {
          return { device_id: "" };
        }
      }
    }
    return { device_id: "" };
  }

  // ─── Discovery ───────────────────────────────────────────────────────────

  async _discoverEntities() {
    const hass = this._hass;
    if (!hass) return;

    const deviceId = this._config.device_id;

    // Fetch device and entity registries
    const [devices, entities] = await Promise.all([
      hass.callWS({ type: "config/device_registry/list" }),
      hass.callWS({ type: "config/entity_registry/list" }),
    ]);

    // Find panel device
    this._panelDevice = devices.find((d) => d.id === deviceId) || null;
    if (!this._panelDevice) return;

    // All entities on this device
    const deviceEntities = entities.filter((e) => e.device_id === deviceId);

    // Find sub-devices (EVSE / BESS)
    const subDevices = devices.filter((d) => d.via_device_id === deviceId);
    this._subDevices = subDevices.map((d) => ({
      device: d,
      entities: entities.filter((e) => e.device_id === d.id),
    }));

    // Include sub-device entities in our working set
    const subDeviceIds = new Set(subDevices.map((d) => d.id));
    const allEntities = entities.filter(
      (e) => e.device_id === deviceId || subDeviceIds.has(e.device_id)
    );

    // Build circuit map from power sensors that have tabs
    this._circuitMap.clear();
    this._panelEntities = [];

    // Group entities by extracting circuit identifier from unique_id
    // Power sensors have unique_ids like: span_{serial}_{circuitUuid}_instantPowerW
    const circuitGroups = new Map(); // circuitUuid → { entities }

    for (const ent of allEntities) {
      const state = hass.states[ent.entity_id];
      if (!state) continue;

      // Check if this is a circuit power sensor (has tabs attribute)
      if (ent.platform === "span_panel" && state.attributes && state.attributes.tabs) {
        const tabs = parseTabs(state.attributes.tabs);
        if (!tabs) continue;

        // Extract circuit UUID from unique_id
        // Pattern: span_{serial}_{circuitUuid}_{sensorKey}
        const uidParts = ent.unique_id.split("_");
        // The circuit UUID is between the serial and the sensor key
        // Find it by looking for the part that's a UUID-like string
        let circuitUuid = null;
        for (let i = 2; i < uidParts.length - 1; i++) {
          const part = uidParts[i];
          // Circuit IDs are typically 32-char hex (UUID without dashes)
          if (part.length >= 16 && /^[a-f0-9]+$/i.test(part)) {
            circuitUuid = part;
            break;
          }
        }

        if (!circuitGroups.has(ent.entity_id)) {
          const circuit = {
            name: state.attributes.friendly_name || ent.entity_id,
            tabs: tabs,
            is240v: tabs.length === 2,
            voltage: state.attributes.voltage || (tabs.length === 2 ? 240 : 120),
            deviceType: state.attributes.device_type || "circuit",
            powerEntityId: ent.entity_id,
            breakerRatingEntityId: null,
            currentEntityId: null,
            switchEntityId: null,
            selectEntityId: null,
            circuitUuid: circuitUuid,
          };

          // Strip the sensor suffix from the friendly name
          let displayName = circuit.name;
          const suffixes = [" Power", " Consumed Energy", " Produced Energy"];
          for (const suffix of suffixes) {
            if (displayName.endsWith(suffix)) {
              displayName = displayName.slice(0, -suffix.length);
              break;
            }
          }
          // Strip device name prefix (e.g., "Span Panel ")
          if (this._panelDevice) {
            const devName = this._panelDevice.name_by_user || this._panelDevice.name || "";
            if (displayName.startsWith(devName + " ")) {
              displayName = displayName.slice(devName.length + 1);
            }
          }
          circuit.displayName = displayName;

          // Place in grid by primary tab
          const primaryTab = Math.min(...tabs);
          this._circuitMap.set(primaryTab, circuit);

          // Mark second tab of 240V as occupied
          if (tabs.length === 2) {
            this._circuitMap.set(Math.max(...tabs), { spannedBy: primaryTab });
          }
        }
      }
    }

    // Now find companion entities (breaker rating, switch, select) by entity_id pattern
    for (const [_tab, circuit] of this._circuitMap) {
      if (circuit.spannedBy) continue;

      // Derive base entity slug from power sensor entity_id
      // e.g., sensor.span_panel_kitchen_outlets_power → span_panel_kitchen_outlets
      const powerEid = circuit.powerEntityId;
      const base = powerEid.replace(/^sensor\./, "").replace(/_power$/, "");

      // Look for companions
      for (const ent of allEntities) {
        if (ent.entity_id === `sensor.${base}_breaker_rating`) {
          circuit.breakerRatingEntityId = ent.entity_id;
        } else if (ent.entity_id === `sensor.${base}_current`) {
          circuit.currentEntityId = ent.entity_id;
        } else if (ent.entity_id === `switch.${base}_breaker`) {
          circuit.switchEntityId = ent.entity_id;
        } else if (ent.entity_id === `select.${base}_circuit_priority`) {
          circuit.selectEntityId = ent.entity_id;
        }
      }
    }

    // Determine panel size
    const statusEntity = deviceEntities.find((e) =>
      e.entity_id.includes("software_version") || e.entity_id.includes("status")
    );
    if (statusEntity) {
      const state = hass.states[statusEntity.entity_id];
      if (state && state.attributes && state.attributes.panel_size) {
        this._panelSize = state.attributes.panel_size;
      }
    }
    // Fallback: infer from highest tab
    if (!this._panelSize || this._panelSize < 2) {
      let maxTab = 0;
      for (const [tab] of this._circuitMap) {
        if (tab > maxTab) maxTab = tab;
      }
      this._panelSize = maxTab <= 32 ? 32 : 42;
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    const hass = this._hass;
    if (!hass || !this._panelDevice) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 16px;">
            ${!this._panelDevice ? "Panel device not found. Check device_id in card config." : "Loading..."}
          </div>
        </ha-card>
      `;
      return;
    }

    const totalRows = Math.ceil(this._panelSize / 2);
    const panelName =
      this._panelDevice.name_by_user || this._panelDevice.name || "SPAN Panel";

    // Extract serial from identifiers
    let serial = "";
    if (this._panelDevice.identifiers) {
      for (const pair of this._panelDevice.identifiers) {
        if (pair[0] === "span_panel") serial = pair[1];
      }
    }
    const firmware = this._panelDevice.sw_version || "";

    // Calculate total panel power
    let totalPower = 0;
    for (const [_tab, circuit] of this._circuitMap) {
      if (circuit.spannedBy) continue;
      const state = hass.states[circuit.powerEntityId];
      if (state) totalPower += Math.abs(parseFloat(state.state) || 0);
    }

    // Build grid rows
    let gridHTML = "";
    for (let row = 1; row <= totalRows; row++) {
      const leftTab = row * 2 - 1;
      const rightTab = row * 2;
      const leftCircuit = this._circuitMap.get(leftTab);
      const rightCircuit = this._circuitMap.get(rightTab);

      // 240V spanning both columns
      if (leftCircuit && !leftCircuit.spannedBy && leftCircuit.is240v) {
        gridHTML += this._renderCircuitSlot(leftCircuit, leftTab, true);
        continue;
      }

      // Left slot
      if (leftCircuit && leftCircuit.spannedBy) {
        // Skip — occupied by a 240V from another row (shouldn't happen with proper layout)
      } else if (leftCircuit) {
        gridHTML += this._renderCircuitSlot(leftCircuit, leftTab, false);
      } else {
        gridHTML += this._renderEmptySlot(leftTab);
      }

      // Right slot
      if (rightCircuit && rightCircuit.spannedBy) {
        // Skip — occupied by 240V partner
      } else if (rightCircuit) {
        gridHTML += this._renderCircuitSlot(rightCircuit, rightTab, false);
      } else {
        gridHTML += this._renderEmptySlot(rightTab);
      }
    }

    // Sub-devices
    let subDevHTML = "";
    for (const sub of this._subDevices) {
      const dev = sub.device;
      const isEvse =
        (dev.identifiers || []).some((p) =>
          (p[1] || "").toLowerCase().includes("evse")
        ) || (dev.model || "").toLowerCase().includes("drive");
      const isBess =
        (dev.identifiers || []).some((p) =>
          (p[1] || "").toLowerCase().includes("bess")
        ) || (dev.model || "").toLowerCase().includes("battery");

      const label = isEvse ? "EV Charger" : isBess ? "Battery" : "Sub-device";
      let entitiesHTML = "";
      for (const ent of sub.entities) {
        const state = hass.states[ent.entity_id];
        if (!state) continue;
        const name = state.attributes.friendly_name || ent.entity_id;
        // Strip device name prefix
        const devName = dev.name_by_user || dev.name || "";
        const shortName = name.startsWith(devName + " ")
          ? name.slice(devName.length + 1)
          : name;
        entitiesHTML += `
          <div class="sub-entity">
            <span class="sub-entity-name">${shortName}</span>
            <span class="sub-entity-value">${state.state}${state.attributes.unit_of_measurement ? " " + state.attributes.unit_of_measurement : ""}</span>
          </div>
        `;
      }

      subDevHTML += `
        <div class="sub-device">
          <div class="sub-device-header">
            <span class="sub-device-label">${label}</span>
            <span class="sub-device-name">${dev.name_by_user || dev.name || ""}</span>
          </div>
          ${entitiesHTML}
        </div>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>${SpanPanelCard._styles()}</style>
      <ha-card>
        <div class="panel-header">
          <div class="panel-title">${panelName}</div>
          <div class="panel-meta">
            <span class="meta-item">Serial: ${serial}</span>
            <span class="meta-item">FW: ${firmware}</span>
          </div>
          <div class="panel-power">
            <span class="power-label">Total</span>
            <span class="power-value">${this._formatPower(totalPower)}</span>
          </div>
        </div>
        <div class="panel-grid" style="grid-template-rows: repeat(${totalRows}, auto);">
          ${gridHTML}
        </div>
        ${subDevHTML ? `<div class="sub-devices">${subDevHTML}</div>` : ""}
      </ha-card>
    `;
  }

  _renderCircuitSlot(circuit, tab, is240v) {
    const hass = this._hass;
    const state = hass.states[circuit.powerEntityId];
    const powerW = state ? parseFloat(state.state) || 0 : 0;
    const relayState = state?.attributes?.relay_state || "UNKNOWN";
    const isOn = relayState === "CLOSED";

    let breakerAmps = 0;
    if (circuit.breakerRatingEntityId) {
      const brState = hass.states[circuit.breakerRatingEntityId];
      if (brState) breakerAmps = parseFloat(brState.state) || 0;
    }

    // Power utilization as percentage of breaker capacity
    const voltage = circuit.voltage || (is240v ? 240 : 120);
    const maxWatts = breakerAmps * voltage;
    const utilPct = maxWatts > 0 ? Math.min(100, (Math.abs(powerW) / maxWatts) * 100) : 0;

    const row = tabToRow(tab);
    const col = is240v ? "1 / -1" : tabToCol(tab) === 0 ? "1" : "2";

    const utilColor =
      utilPct > 80 ? "var(--span-color-high, #f44336)" :
      utilPct > 50 ? "var(--span-color-mid, #ff9800)" :
      "var(--span-color-low, #4caf50)";

    const deviceIcon =
      circuit.deviceType === "pv" ? "⚡" :
      circuit.deviceType === "evse" ? "🔌" : "";

    return `
      <div class="circuit-slot ${isOn ? "" : "circuit-off"} ${is240v ? "circuit-240v" : ""}"
           style="grid-row: ${row}; grid-column: ${col};">
        <div class="circuit-header">
          <span class="tab-badge">${breakerAmps ? breakerAmps + "A" : tab}</span>
          <span class="circuit-name">${deviceIcon}${circuit.displayName}</span>
          <span class="circuit-power">${this._formatPower(Math.abs(powerW))}</span>
          <span class="relay-indicator ${isOn ? "relay-on" : "relay-off"}">${isOn ? "On" : "Off"}</span>
        </div>
        <div class="circuit-bar-container">
          <div class="circuit-bar" style="width: ${utilPct}%; background: ${utilColor};"></div>
        </div>
      </div>
    `;
  }

  _renderEmptySlot(tab) {
    const row = tabToRow(tab);
    const col = tabToCol(tab) === 0 ? "1" : "2";
    return `
      <div class="circuit-slot circuit-empty" style="grid-row: ${row}; grid-column: ${col};">
        <span class="tab-number">${tab}</span>
      </div>
    `;
  }

  _formatPower(watts) {
    if (watts >= 1000) return (watts / 1000).toFixed(1) + " kW";
    return Math.round(watts) + " W";
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

  static _styles() {
    return `
      :host {
        --span-bg: var(--card-background-color, #1c1c1c);
        --span-slot-bg: var(--secondary-background-color, #2a2a2a);
        --span-text: var(--primary-text-color, #e0e0e0);
        --span-text-secondary: var(--secondary-text-color, #999);
        --span-color-low: #4caf50;
        --span-color-mid: #ff9800;
        --span-color-high: #f44336;
        --span-accent: #00bcd4;
      }

      ha-card {
        padding: 16px;
        background: var(--span-bg);
        color: var(--span-text);
      }

      .panel-header {
        margin-bottom: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--divider-color, #333);
      }

      .panel-title {
        font-size: 1.4em;
        font-weight: 600;
        margin-bottom: 4px;
      }

      .panel-meta {
        display: flex;
        gap: 16px;
        font-size: 0.85em;
        color: var(--span-text-secondary);
        margin-bottom: 8px;
      }

      .panel-power {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }

      .power-label {
        font-size: 0.85em;
        color: var(--span-text-secondary);
      }

      .power-value {
        font-size: 1.3em;
        font-weight: 600;
        color: var(--span-accent);
      }

      .panel-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      .circuit-slot {
        background: var(--span-slot-bg);
        border-radius: 8px;
        padding: 8px 10px;
        min-height: 48px;
        transition: opacity 0.2s;
      }

      .circuit-off {
        opacity: 0.5;
      }

      .circuit-empty {
        opacity: 0.2;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
      }

      .circuit-240v {
        grid-column: 1 / -1 !important;
        border-left: 3px solid var(--span-accent);
      }

      .tab-number {
        font-size: 0.75em;
        color: var(--span-text-secondary);
      }

      .circuit-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }

      .tab-badge {
        background: var(--span-accent);
        color: #000;
        font-size: 0.7em;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 4px;
        white-space: nowrap;
      }

      .circuit-name {
        flex: 1;
        font-size: 0.9em;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .circuit-power {
        font-size: 0.85em;
        font-weight: 600;
        white-space: nowrap;
      }

      .relay-indicator {
        font-size: 0.7em;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 10px;
        white-space: nowrap;
      }

      .relay-on {
        background: var(--span-color-low);
        color: #000;
      }

      .relay-off {
        background: var(--span-color-high);
        color: #fff;
      }

      .circuit-bar-container {
        height: 4px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 2px;
        overflow: hidden;
      }

      .circuit-bar {
        height: 100%;
        border-radius: 2px;
        transition: width 0.3s ease;
      }

      .sub-devices {
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid var(--divider-color, #333);
      }

      .sub-device {
        margin-bottom: 12px;
      }

      .sub-device-header {
        display: flex;
        gap: 8px;
        align-items: baseline;
        margin-bottom: 6px;
      }

      .sub-device-label {
        font-size: 0.75em;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--span-accent);
      }

      .sub-device-name {
        font-size: 0.85em;
        color: var(--span-text-secondary);
      }

      .sub-entity {
        display: flex;
        justify-content: space-between;
        padding: 2px 0;
        font-size: 0.85em;
      }

      .sub-entity-name {
        color: var(--span-text-secondary);
      }

      .sub-entity-value {
        font-weight: 500;
      }
    `;
  }
}

// ─── Config Editor ─────────────────────────────────────────────────────────

class SpanPanelCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this._hass) return;

    this.innerHTML = `
      <div style="padding: 16px;">
        <ha-device-picker
          .hass=${this._hass}
          .value="${this._config.device_id || ""}"
          .includeDeviceClasses=${[]}
          label="SPAN Panel Device"
        ></ha-device-picker>
        <p style="font-size: 0.85em; color: var(--secondary-text-color); margin-top: 8px;">
          Select your SPAN Panel device. The card will auto-discover all circuits and lay them out by panel position.
        </p>
      </div>
    `;

    const picker = this.querySelector("ha-device-picker");
    if (picker) {
      // Set properties that can't be set via attributes
      picker.hass = this._hass;
      picker.value = this._config.device_id || "";
      picker.addEventListener("value-changed", (ev) => {
        this._config = { ...this._config, device_id: ev.detail.value };
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config } })
        );
      });
    }
  }
}

// ─── Registration ──────────────────────────────────────────────────────────

customElements.define("span-panel-card", SpanPanelCard);
customElements.define("span-panel-card-editor", SpanPanelCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "span-panel-card",
  name: "SPAN Panel",
  description: "Physical panel layout showing circuits by tab position",
  preview: true,
});

console.info(
  `%c SPAN-PANEL-CARD %c v${CARD_VERSION} `,
  "background: #00bcd4; color: #000; font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;",
  "background: #333; color: #fff; padding: 2px 6px; border-radius: 0 4px 4px 0;"
);
