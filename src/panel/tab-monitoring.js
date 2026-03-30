import { INTEGRATION_DOMAIN } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";

const FIELD_STYLE = `
  display:flex;align-items:center;gap:8px;margin-bottom:8px;
`;
const INPUT_STYLE = `
  background:var(--secondary-background-color,#333);
  border:1px solid var(--divider-color);
  color:var(--primary-text-color);
  border-radius:4px;padding:6px 10px;width:80px;font-size:0.85em;
`;
const LABEL_STYLE = `
  min-width:130px;font-size:0.85em;color:var(--secondary-text-color);
`;

export class MonitoringTab {
  constructor() {
    this._debounceTimer = null;
  }

  async render(container, hass) {
    let status;
    try {
      const resp = await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_monitoring_status",
        service_data: {},
        return_response: true,
      });
      status = resp?.response || null;
    } catch {
      status = null;
    }

    const globalSettings = status?.global_settings || {};
    const isEnabled = status?.enabled === true;
    const circuits = status?.circuits || {};
    const mains = status?.mains || {};
    const allEntries = [...Object.entries(circuits), ...Object.entries(mains)];

    const monitoredRows = allEntries
      .map(([entityId, info]) => {
        const name = escapeHtml(info.name || entityId);
        const continuous = info.continuous_threshold_pct;
        const spike = info.spike_threshold_pct;
        const window = info.window_duration_m;
        const isMains = Object.prototype.hasOwnProperty.call(mains, entityId);
        return `
          <tr>
            <td style="padding:8px;">${name}</td>
            <td style="padding:8px;">${continuous ?? "--"}%</td>
            <td style="padding:8px;">${spike ?? "--"}%</td>
            <td style="padding:8px;">${window ?? "--"}m</td>
            <td style="padding:8px;">
              <button class="reset-btn" data-entity="${escapeHtml(entityId)}"
                      data-type="${isMains ? "mains" : "circuit"}"
                      style="background:none;border:1px solid var(--divider-color);color:var(--primary-text-color);border-radius:4px;padding:4px 8px;cursor:pointer;font-size:0.8em;"
                      title="Reset to global default thresholds">
                Reset to Default
              </button>
            </td>
          </tr>
        `;
      })
      .join("");

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin-top:0;">Monitoring</h2>

        <div style="margin-bottom:24px;padding:16px;background:var(--secondary-background-color,#252530);border-radius:8px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <h3 style="margin:0;">Global Settings</h3>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="monitoring-enabled" ${isEnabled ? "checked" : ""}
                     style="width:16px;height:16px;accent-color:var(--primary-color,#4dd9af);">
              <span style="font-size:0.85em;color:var(--secondary-text-color);">Enabled</span>
            </label>
          </div>

          <div id="global-fields" style="${isEnabled ? "" : "opacity:0.4;pointer-events:none;"}">
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">Continuous (%)</span>
              <input type="number" id="g-continuous" min="1" max="200"
                     value="${globalSettings.continuous_threshold_pct ?? 80}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">Spike (%)</span>
              <input type="number" id="g-spike" min="1" max="200"
                     value="${globalSettings.spike_threshold_pct ?? 100}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">Window (min)</span>
              <input type="number" id="g-window" min="1" max="180"
                     value="${globalSettings.window_duration_m ?? 5}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">Cooldown (min)</span>
              <input type="number" id="g-cooldown" min="1" max="180"
                     value="${globalSettings.cooldown_duration_m ?? 15}"
                     style="${INPUT_STYLE}">
            </div>
          </div>

          <div id="global-status" style="font-size:0.8em;color:var(--secondary-text-color);margin-top:8px;min-height:1.2em;"></div>
        </div>

        <h3>Per-Circuit Overrides</h3>
        <p style="color:var(--secondary-text-color);margin-bottom:16px;font-size:0.85em;">
          Use <em>Reset to Default</em> to clear a custom override and restore the circuit to global defaults.
        </p>
        ${
          allEntries.length > 0
            ? `
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid var(--divider-color);">
                <th style="padding:8px;">Name</th>
                <th style="padding:8px;">Continuous</th>
                <th style="padding:8px;">Spike</th>
                <th style="padding:8px;">Window</th>
                <th style="padding:8px;"></th>
              </tr>
            </thead>
            <tbody>${monitoredRows}</tbody>
          </table>
        `
            : `
          <p style="color:var(--secondary-text-color);">
            All circuits using global defaults. No per-circuit overrides are configured.
          </p>
        `
        }
      </div>
    `;

    this._bindGlobalControls(container, hass);
    this._bindResetButtons(container, hass);
  }

  _bindGlobalControls(container, hass) {
    const enabledCheckbox = container.querySelector("#monitoring-enabled");
    const fieldsDiv = container.querySelector("#global-fields");
    const statusEl = container.querySelector("#global-status");

    const saveGlobal = async () => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        const data = {
          continuous_threshold_pct: parseInt(container.querySelector("#g-continuous").value, 10),
          spike_threshold_pct: parseInt(container.querySelector("#g-spike").value, 10),
          window_duration_m: parseInt(container.querySelector("#g-window").value, 10),
          cooldown_duration_m: parseInt(container.querySelector("#g-cooldown").value, 10),
        };
        try {
          await hass.callService(INTEGRATION_DOMAIN, "set_global_monitoring", data);
          statusEl.textContent = "Saved";
          statusEl.style.color = "var(--success-color, #4caf50)";
          setTimeout(() => {
            statusEl.textContent = "";
          }, 2000);
        } catch (err) {
          statusEl.textContent = `Error: ${err.message || "Failed to save"}`;
          statusEl.style.color = "var(--error-color, #f44336)";
        }
      }, 500);
    };

    if (enabledCheckbox) {
      enabledCheckbox.addEventListener("change", async () => {
        const enabled = enabledCheckbox.checked;
        fieldsDiv.style.opacity = enabled ? "" : "0.4";
        fieldsDiv.style.pointerEvents = enabled ? "" : "none";
        if (enabled) {
          await saveGlobal();
          await this.render(container, hass);
        }
      });
    }

    for (const input of container.querySelectorAll("#global-fields input[type=number]")) {
      input.addEventListener("input", saveGlobal);
    }
  }

  _bindResetButtons(container, hass) {
    for (const btn of container.querySelectorAll(".reset-btn")) {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.entity;
        const type = btn.dataset.type;
        const service = type === "mains" ? "clear_mains_threshold" : "clear_circuit_threshold";
        const param = type === "mains" ? { leg: entityId } : { circuit_id: entityId };
        await hass.callService(INTEGRATION_DOMAIN, service, param);
        await this.render(container, hass);
      });
    }
  }
}
