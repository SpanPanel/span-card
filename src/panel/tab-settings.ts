import { INTEGRATION_DOMAIN, GRAPH_HORIZONS, DEFAULT_GRAPH_HORIZON, INPUT_DEBOUNCE_MS } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import type { HomeAssistant, PanelTopology, GraphSettings, CircuitGraphOverride, CallServiceResponse } from "../types.js";

/**
 * Narrow an unvalidated ``get_graph_settings`` response into a
 * ``GraphSettings`` we can trust. Unknown fields are dropped; bad shape
 * returns null so callers fall back to defaults instead of silently
 * reading undefined properties.
 */
function coerceGraphSettingsResponse(resp: unknown): GraphSettings | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const out: GraphSettings = {};
  if (typeof r.global_horizon === "string") out.global_horizon = r.global_horizon;
  if (r.circuits && typeof r.circuits === "object") {
    out.circuits = r.circuits as Record<string, CircuitGraphOverride>;
  }
  if (r.sub_devices && typeof r.sub_devices === "object") {
    out.sub_devices = r.sub_devices as Record<string, CircuitGraphOverride>;
  }
  return out;
}

function horizonOptions(selectedKey: string): string {
  return Object.keys(GRAPH_HORIZONS)
    .map(key => {
      const labelKey = `horizon.${key}`;
      const translated = t(labelKey);
      return `<option value="${key}" ${key === selectedKey ? "selected" : ""}>${translated !== labelKey ? translated : key}</option>`;
    })
    .join("");
}

const SELECT_STYLE = `
  background:var(--secondary-background-color,#333);
  border:1px solid var(--divider-color);
  color:var(--primary-text-color);
  border-radius:4px;padding:4px 8px;font-size:0.85em;
`;

export class SettingsTab {
  private _debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  private _configEntryId: string | null;
  private _deviceId: string | null;

  constructor() {
    this._debounceTimers = new Map();
    this._configEntryId = null;
    this._deviceId = null;
  }

  stop(): void {
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
  }

  async render(container: HTMLElement, hass: HomeAssistant, configEntryId?: string, deviceId?: string): Promise<void> {
    if (configEntryId !== undefined) this._configEntryId = configEntryId;
    if (deviceId !== undefined) this._deviceId = deviceId;

    let graphSettings: GraphSettings | null;
    try {
      const serviceData: Record<string, unknown> = {};
      if (this._configEntryId) serviceData.config_entry_id = this._configEntryId;
      const resp = await hass.callWS<CallServiceResponse>({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_graph_settings",
        service_data: serviceData,
        return_response: true,
      });
      graphSettings = coerceGraphSettingsResponse(resp?.response);
    } catch (err) {
      console.warn("SPAN Panel: graph settings fetch failed", err);
      graphSettings = null;
    }

    let topology: PanelTopology | null = null;
    try {
      if (this._deviceId) {
        topology = await hass.callWS<PanelTopology>({
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
        const circuitData = circuitSettings[uuid];
        const effectiveHorizon = circuitData?.horizon ?? globalHorizon;
        const hasOverride = circuitData?.has_override === true;
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

  private _serviceData(data: Record<string, unknown>): Record<string, unknown> {
    if (this._configEntryId) data.config_entry_id = this._configEntryId;
    return data;
  }

  private _bindGlobalHorizon(container: HTMLElement, hass: HomeAssistant): void {
    const select = container.querySelector<HTMLSelectElement>("#global-horizon");
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

  private _bindCircuitHorizons(container: HTMLElement, hass: HomeAssistant): void {
    for (const select of container.querySelectorAll<HTMLSelectElement>(".horizon-select")) {
      select.addEventListener("change", () => {
        const uuid = select.dataset.circuit;
        if (!uuid) return;
        const key = `circuit-${uuid}`;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);
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
          }, INPUT_DEBOUNCE_MS)
        );
      });
    }
  }

  private _bindResetButtons(container: HTMLElement, hass: HomeAssistant): void {
    for (const btn of container.querySelectorAll<HTMLElement>(".reset-btn")) {
      btn.addEventListener("click", async () => {
        const uuid = btn.dataset.circuit;
        if (!uuid) return;
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
