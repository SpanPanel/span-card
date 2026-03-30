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
const CELL_INPUT_STYLE = `
  background:var(--secondary-background-color,#333);
  border:1px solid var(--divider-color);
  color:var(--primary-text-color);
  border-radius:3px;padding:3px 6px;width:50px;font-size:0.8em;
  text-align:center;
`;

function thresholdCell(entityId, field, value, unit, type) {
  return `<td style="padding:6px 4px;">
    <input type="number" class="threshold-input" data-entity="${entityId}" data-field="${field}" data-type="${type}"
           value="${value ?? ""}" min="1" max="${field === "window_duration_m" ? 180 : 200}"
           style="${CELL_INPUT_STYLE}"><span style="font-size:0.75em;color:var(--secondary-text-color);">${unit}</span>
  </td>`;
}

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

    const circuitEntries = Object.entries(circuits).sort(([, a], [, b]) => (a.name || "").localeCompare(b.name || ""));
    const mainsEntries = Object.entries(mains);
    const allPoints = [...circuitEntries, ...mainsEntries];
    const allEnabled = allPoints.length > 0 && allPoints.every(([, c]) => c.monitoring_enabled !== false);
    const someEnabled = allPoints.some(([, c]) => c.monitoring_enabled !== false);

    const circuitRows = circuitEntries
      .map(([entityId, info]) => {
        const name = escapeHtml(info.name || entityId);
        const enabled = info.monitoring_enabled !== false;
        const hasOverride = info.has_override === true;
        const dimStyle = enabled ? "" : "opacity:0.4;";
        const eid = escapeHtml(entityId);
        return `
          <tr style="${dimStyle}">
            <td style="padding:6px 8px;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" class="circuit-toggle" data-entity="${eid}"
                       ${enabled ? "checked" : ""}
                       style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                <span>${name}</span>
              </label>
            </td>
            ${thresholdCell(eid, "continuous_threshold_pct", info.continuous_threshold_pct, "%", "circuit")}
            ${thresholdCell(eid, "spike_threshold_pct", info.spike_threshold_pct, "%", "circuit")}
            ${thresholdCell(eid, "window_duration_m", info.window_duration_m, "m", "circuit")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="circuit"
                       style="background:none;border:1px solid var(--divider-color);color:var(--primary-text-color);border-radius:4px;padding:3px 6px;cursor:pointer;font-size:0.75em;">
                    Reset
                  </button>`
                  : ""
              }
            </td>
          </tr>
        `;
      })
      .join("");

    const mainsRows = Object.entries(mains)
      .map(([entityId, info]) => {
        const name = escapeHtml(info.name || entityId);
        const enabled = info.monitoring_enabled !== false;
        const hasOverride = info.has_override === true;
        const dimStyle = enabled ? "" : "opacity:0.4;";
        const eid = escapeHtml(entityId);
        return `
          <tr style="${dimStyle}">
            <td style="padding:6px 8px;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" class="mains-toggle" data-entity="${eid}"
                       ${enabled ? "checked" : ""}
                       style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                <span>${name}</span>
              </label>
            </td>
            ${thresholdCell(eid, "continuous_threshold_pct", info.continuous_threshold_pct, "%", "mains")}
            ${thresholdCell(eid, "spike_threshold_pct", info.spike_threshold_pct, "%", "mains")}
            ${thresholdCell(eid, "window_duration_m", info.window_duration_m, "m", "mains")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="mains"
                       style="background:none;border:1px solid var(--divider-color);color:var(--primary-text-color);border-radius:4px;padding:3px 6px;cursor:pointer;font-size:0.75em;">
                    Reset
                  </button>`
                  : ""
              }
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

        <h3>Monitored Points</h3>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--divider-color);">
              <th style="padding:6px 8px;">Name</th>
              <th style="padding:6px 8px;">Continuous</th>
              <th style="padding:6px 8px;">Spike</th>
              <th style="padding:6px 8px;">Window</th>
              <th style="padding:6px 8px;"></th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid var(--divider-color,#333);">
              <td style="padding:6px 8px;" colspan="5">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input type="checkbox" id="toggle-all-circuits"
                         ${allEnabled ? "checked" : ""}
                         style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                  <span style="font-weight:600;font-size:0.85em;color:var(--secondary-text-color);">All / None</span>
                </label>
              </td>
            </tr>
            ${mainsRows}
            ${circuitRows}
          </tbody>
        </table>
      </div>
    `;

    // Set indeterminate state on toggle-all checkbox
    const toggleAllCb = container.querySelector("#toggle-all-circuits");
    if (toggleAllCb && !allEnabled && someEnabled) {
      toggleAllCb.indeterminate = true;
    }

    this._bindGlobalControls(container, hass);
    this._bindToggleAll(container, hass, circuits, mains);
    this._bindCircuitToggles(container, hass);
    this._bindMainsToggles(container, hass);
    this._bindThresholdInputs(container, hass);
    this._bindResetButtons(container, hass);
  }

  _callSetGlobal(hass, data) {
    return hass.callWS({
      type: "call_service",
      domain: INTEGRATION_DOMAIN,
      service: "set_global_monitoring",
      service_data: data,
    });
  }

  _bindGlobalControls(container, hass) {
    const enabledCheckbox = container.querySelector("#monitoring-enabled");
    const fieldsDiv = container.querySelector("#global-fields");
    const statusEl = container.querySelector("#global-status");

    const saveGlobal = () => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        const data = {
          continuous_threshold_pct: parseInt(container.querySelector("#g-continuous").value, 10),
          spike_threshold_pct: parseInt(container.querySelector("#g-spike").value, 10),
          window_duration_m: parseInt(container.querySelector("#g-window").value, 10),
          cooldown_duration_m: parseInt(container.querySelector("#g-cooldown").value, 10),
        };
        try {
          await this._callSetGlobal(hass, data);
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
        const statusEl2 = container.querySelector("#global-status");
        try {
          if (enabled) {
            const data = {
              continuous_threshold_pct: parseInt(container.querySelector("#g-continuous").value, 10),
              spike_threshold_pct: parseInt(container.querySelector("#g-spike").value, 10),
              window_duration_m: parseInt(container.querySelector("#g-window").value, 10),
              cooldown_duration_m: parseInt(container.querySelector("#g-cooldown").value, 10),
            };
            await this._callSetGlobal(hass, data);
          } else {
            await this._callSetGlobal(hass, { enabled: false });
          }
        } catch (err) {
          if (statusEl2) {
            statusEl2.textContent = `Error: ${err.message || "Failed"}`;
            statusEl2.style.color = "var(--error-color, #f44336)";
          }
          return;
        }
        await this.render(container, hass);
      });
    }

    for (const input of container.querySelectorAll("#global-fields input[type=number]")) {
      input.addEventListener("input", saveGlobal);
    }
  }

  _bindToggleAll(container, hass, circuits, mains) {
    const toggleAll = container.querySelector("#toggle-all-circuits");
    if (!toggleAll) return;
    toggleAll.addEventListener("change", async () => {
      const enabled = toggleAll.checked;
      const calls = [
        ...Object.keys(circuits).map(entityId =>
          hass
            .callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_circuit_threshold",
              service_data: { circuit_id: entityId, monitoring_enabled: enabled },
            })
            .catch(() => {})
        ),
        ...Object.keys(mains).map(entityId =>
          hass
            .callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_mains_threshold",
              service_data: { leg: entityId, monitoring_enabled: enabled },
            })
            .catch(() => {})
        ),
      ];
      await Promise.all(calls);
      await this.render(container, hass);
    });
  }

  _bindMainsToggles(container, hass) {
    for (const cb of container.querySelectorAll(".mains-toggle")) {
      cb.addEventListener("change", async () => {
        const entityId = cb.dataset.entity;
        const enabled = cb.checked;
        try {
          // Set both upstream legs together (single 240V breaker)
          await Promise.all([
            hass.callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_mains_threshold",
              service_data: { leg: entityId, monitoring_enabled: enabled },
            }),
          ]);
        } catch {
          cb.checked = !enabled;
          return;
        }
        await this.render(container, hass);
      });
    }
  }

  _bindCircuitToggles(container, hass) {
    for (const cb of container.querySelectorAll(".circuit-toggle")) {
      cb.addEventListener("change", async () => {
        const entityId = cb.dataset.entity;
        const enabled = cb.checked;
        try {
          await hass.callWS({
            type: "call_service",
            domain: INTEGRATION_DOMAIN,
            service: "set_circuit_threshold",
            service_data: { circuit_id: entityId, monitoring_enabled: enabled },
          });
        } catch {
          cb.checked = !enabled;
          return;
        }
        await this.render(container, hass);
      });
    }
  }

  _bindThresholdInputs(container, hass) {
    const timers = new Map();
    for (const input of container.querySelectorAll(".threshold-input")) {
      input.addEventListener("input", () => {
        const key = `${input.dataset.entity}-${input.dataset.field}`;
        clearTimeout(timers.get(key));
        timers.set(
          key,
          setTimeout(async () => {
            const val = parseInt(input.value, 10);
            if (!val || val < 1) return;
            const entityId = input.dataset.entity;
            const field = input.dataset.field;
            const type = input.dataset.type;
            const service = type === "mains" ? "set_mains_threshold" : "set_circuit_threshold";
            const idField = type === "mains" ? "leg" : "circuit_id";
            try {
              await hass.callWS({
                type: "call_service",
                domain: INTEGRATION_DOMAIN,
                service,
                service_data: { [idField]: entityId, [field]: val },
              });
              // Re-render to update Custom badge and Reset button
              await this.render(container, hass);
            } catch {
              input.style.borderColor = "var(--error-color, #f44336)";
            }
          }, 800)
        );
      });
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
