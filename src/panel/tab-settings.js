import { INTEGRATION_DOMAIN, GRAPH_HORIZONS, DEFAULT_GRAPH_HORIZON } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";

function horizonOptions(selectedKey) {
  return Object.keys(GRAPH_HORIZONS)
    .map(key => `<option value="${key}" ${key === selectedKey ? "selected" : ""}>${t(`horizon.${key}`) || key}</option>`)
    .join("");
}

const SELECT_STYLE = `
  background:var(--secondary-background-color,#333);
  border:1px solid var(--divider-color);
  color:var(--primary-text-color);
  border-radius:4px;padding:4px 8px;font-size:0.85em;
`;

export class SettingsTab {
  constructor() {
    this._debounceTimers = new Map();
    this._configEntryId = null;
    this._deviceId = null;
  }

  stop() {
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
  }

  async render(container, hass, configEntryId, deviceId) {
    if (configEntryId !== undefined) this._configEntryId = configEntryId;
    if (deviceId !== undefined) this._deviceId = deviceId;

    let graphSettings;
    try {
      const serviceData = {};
      if (this._configEntryId) serviceData.config_entry_id = this._configEntryId;
      const resp = await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_graph_settings",
        service_data: serviceData,
        return_response: true,
      });
      graphSettings = resp?.response || null;
    } catch {
      graphSettings = null;
    }

    let topology = null;
    try {
      if (this._deviceId) {
        topology = await hass.callWS({
          type: `${INTEGRATION_DOMAIN}/panel_topology`,
          device_id: this._deviceId,
        });
      }
    } catch {
      topology = null;
    }

    const globalHorizon = graphSettings?.global_horizon ?? DEFAULT_GRAPH_HORIZON;
    const circuitSettings = graphSettings?.circuits ?? {};

    const circuitEntries = topology ? Object.entries(topology.circuits || {}).sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || "")) : [];

    const circuitRows = circuitEntries
      .map(([uuid, circuit]) => {
        const name = escapeHtml(circuit.name || uuid);
        const circuitData = circuitSettings[uuid] || {};
        const effectiveHorizon = circuitData.horizon ?? globalHorizon;
        const hasOverride = circuitData.has_override === true;
        const safeUuid = escapeHtml(uuid);
        return `
          <tr>
            <td style="padding:6px 8px;">${name}</td>
            <td style="padding:6px 4px;">
              <select class="horizon-select" data-circuit="${safeUuid}" style="${SELECT_STYLE}">
                ${horizonOptions(effectiveHorizon)}
              </select>
            </td>
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-circuit="${safeUuid}"
                       style="background:none;border:1px solid var(--divider-color);color:var(--primary-text-color);border-radius:4px;padding:3px 6px;cursor:pointer;font-size:0.75em;">
                      ${t("monitoring.reset")}
                    </button>`
                  : ""
              }
            </td>
          </tr>
        `;
      })
      .join("");

    const href = this._configEntryId
      ? `/config/integrations/integration/${INTEGRATION_DOMAIN}#config_entry=${this._configEntryId}`
      : `/config/integrations/integration/${INTEGRATION_DOMAIN}`;

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin-top:0;">${t("settings.heading")}</h2>
        <p style="color:var(--secondary-text-color);margin-bottom:16px;">
          ${t("settings.description")}
        </p>
        <a href="${href}" style="color:var(--primary-color);text-decoration:none;">
          ${t("settings.open_link")} &rarr;
        </a>

        <hr style="border:none;border-top:1px solid var(--divider-color);margin:24px 0 16px;">

        <h3 style="margin-top:0;">${t("settings.graph_horizon_heading")}</h3>

        <div style="margin-bottom:24px;padding:16px;background:var(--secondary-background-color,#252530);border-radius:8px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:0.85em;color:var(--secondary-text-color);min-width:130px;">${t("settings.global_default")}</span>
            <select id="global-horizon" style="${SELECT_STYLE}">
              ${horizonOptions(globalHorizon)}
            </select>
          </div>
        </div>

        ${
          circuitEntries.length > 0
            ? `
          <h3 style="margin-top:0;">${t("settings.circuit_graph_scales")}</h3>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid var(--divider-color);">
                <th style="padding:6px 8px;">${t("settings.col.circuit")}</th>
                <th style="padding:6px 8px;">${t("settings.col.scale")}</th>
                <th style="padding:6px 8px;"></th>
              </tr>
            </thead>
            <tbody>
              ${circuitRows}
            </tbody>
          </table>
        `
            : ""
        }
      </div>
    `;

    this._bindGlobalHorizon(container, hass);
    this._bindCircuitHorizons(container, hass);
    this._bindResetButtons(container, hass);
  }

  _serviceData(data) {
    if (this._configEntryId) data.config_entry_id = this._configEntryId;
    return data;
  }

  _bindGlobalHorizon(container, hass) {
    const select = container.querySelector("#global-horizon");
    if (!select) return;
    select.addEventListener("change", async () => {
      await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "set_graph_time_horizon",
        service_data: this._serviceData({ horizon: select.value }),
      });
      container.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
      await this.render(container, hass);
    });
  }

  _bindCircuitHorizons(container, hass) {
    for (const select of container.querySelectorAll(".horizon-select")) {
      select.addEventListener("change", () => {
        const uuid = select.dataset.circuit;
        const key = `circuit-${uuid}`;
        clearTimeout(this._debounceTimers.get(key));
        this._debounceTimers.set(
          key,
          setTimeout(async () => {
            await hass.callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_circuit_graph_horizon",
              service_data: this._serviceData({ circuit_id: uuid, horizon: select.value }),
            });
            container.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
            await this.render(container, hass);
          }, 500)
        );
      });
    }
  }

  _bindResetButtons(container, hass) {
    for (const btn of container.querySelectorAll(".reset-btn")) {
      btn.addEventListener("click", async () => {
        const uuid = btn.dataset.circuit;
        await hass.callWS({
          type: "call_service",
          domain: INTEGRATION_DOMAIN,
          service: "clear_circuit_graph_horizon",
          service_data: this._serviceData({ circuit_id: uuid }),
        });
        container.dispatchEvent(new CustomEvent("graph-settings-changed", { bubbles: true, composed: true }));
        await this.render(container, hass);
      });
    }
  }
}
