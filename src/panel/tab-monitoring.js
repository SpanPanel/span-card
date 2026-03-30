import { INTEGRATION_DOMAIN } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";

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
const WIDE_LABEL_STYLE = `
  min-width:160px;font-size:0.85em;color:var(--secondary-text-color);
`;
const TEXT_INPUT_STYLE = `
  background:var(--secondary-background-color,#333);
  border:1px solid var(--divider-color);
  color:var(--primary-text-color);
  border-radius:4px;padding:6px 10px;flex:1;font-size:0.85em;
  font-family:monospace;
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
    this._configEntryId = null;
  }

  async render(container, hass, configEntryId) {
    if (configEntryId !== undefined) this._configEntryId = configEntryId;
    if (this._notifyCloseHandler) {
      document.removeEventListener("click", this._notifyCloseHandler);
      this._notifyCloseHandler = null;
    }
    let status;
    try {
      const serviceData = {};
      if (this._configEntryId) serviceData.config_entry_id = this._configEntryId;
      const resp = await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_monitoring_status",
        service_data: serviceData,
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

    // Discover notify targets from three sources, deduplicated:
    // 1. Mobile app services derived from person entity device_trackers
    // 2. Entity-based notify targets (notify.*) from hass.states
    // 3. Legacy service-based targets from hass.services.notify
    const targetSet = new Set();

    // Derive mobile app notify services from person entities + device_trackers
    for (const [eid, stateObj] of Object.entries(hass.states || {})) {
      if (!eid.startsWith("person.")) continue;
      const trackers = stateObj.attributes?.device_trackers || [];
      for (const tracker of trackers) {
        const deviceName = tracker.split(".")[1];
        if (deviceName) targetSet.add(`notify.mobile_app_${deviceName}`);
      }
    }

    // Add notify.* entities from hass.states
    for (const eid of Object.keys(hass.states || {})) {
      if (eid.startsWith("notify.")) targetSet.add(eid);
    }

    // Add legacy service-based targets from hass.services.notify
    for (const svc of Object.keys(hass.services?.notify || {})) {
      targetSet.add(`notify.${svc}`);
    }

    const allNotifyTargets = [...targetSet].sort();

    const rawTargets = globalSettings.notify_targets || "notify.notify";
    const selectedTargets = (typeof rawTargets === "string" ? rawTargets.split(",") : rawTargets).map(s => s.trim()).filter(Boolean);
    const titleTemplate = globalSettings.notification_title_template || "SPAN: {name} {alert_type}";
    const messageTemplate = globalSettings.notification_message_template || "{name} at {current_a}A ({utilization_pct}% of {breaker_rating_a}A rating)";
    const persistentNotifications = globalSettings.enable_persistent_notifications !== false;
    const eventBus = globalSettings.enable_event_bus !== false;
    const currentPriority = globalSettings.notification_priority || "default";

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
            ${thresholdCell(eid, "cooldown_duration_m", info.cooldown_duration_m, "m", "circuit")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="circuit"
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
            ${thresholdCell(eid, "cooldown_duration_m", info.cooldown_duration_m, "m", "mains")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="mains"
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

    container.innerHTML = `
      <div style="padding:16px;">
        <h2 style="margin-top:0;">${t("monitoring.heading")}</h2>

        <div style="margin-bottom:24px;padding:16px;background:var(--secondary-background-color,#252530);border-radius:8px;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
            <h3 style="margin:0;">${t("monitoring.global_settings")}</h3>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" id="monitoring-enabled" ${isEnabled ? "checked" : ""}
                     style="width:16px;height:16px;accent-color:var(--primary-color,#4dd9af);">
              <span style="font-size:0.85em;color:var(--secondary-text-color);">${t("monitoring.enabled")}</span>
            </label>
          </div>

          <div id="global-fields" style="${isEnabled ? "" : "opacity:0.4;pointer-events:none;"}">
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.continuous")}</span>
              <input type="number" id="g-continuous" min="1" max="200"
                     value="${globalSettings.continuous_threshold_pct ?? 80}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.spike")}</span>
              <input type="number" id="g-spike" min="1" max="200"
                     value="${globalSettings.spike_threshold_pct ?? 100}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.window")}</span>
              <input type="number" id="g-window" min="1" max="180"
                     value="${globalSettings.window_duration_m ?? 5}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.cooldown")}</span>
              <input type="number" id="g-cooldown" min="1" max="180"
                     value="${globalSettings.cooldown_duration_m ?? 15}"
                     style="${INPUT_STYLE}">
            </div>

            <hr style="border:none;border-top:1px solid var(--divider-color);margin:16px 0 12px;">
            <h4 style="margin:0 0 12px;font-size:0.9em;color:var(--primary-text-color);">${t("notification.heading")}</h4>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.targets")}</span>
              <div id="notify-target-select" style="position:relative;flex:1;">
                <button id="notify-target-btn" type="button" style="
                  background:var(--secondary-background-color,#333);
                  border:1px solid var(--divider-color);
                  color:var(--primary-text-color);
                  border-radius:4px;padding:6px 10px;width:100%;font-size:0.85em;
                  text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
                  <span id="notify-target-label">${selectedTargets.length ? selectedTargets.map(s => escapeHtml(s)).join(", ") : t("notification.none_selected")}</span>
                  <span style="font-size:0.7em;margin-left:8px;">&#9660;</span>
                </button>
                <div id="notify-target-dropdown" style="
                  display:none;position:absolute;top:100%;left:0;right:0;z-index:10;
                  background:var(--card-background-color,var(--secondary-background-color,#333));
                  border:1px solid var(--divider-color);border-radius:4px;
                  max-height:200px;overflow-y:auto;margin-top:2px;
                  box-shadow:0 4px 12px rgba(0,0,0,0.3);">
                  ${
                    allNotifyTargets.length === 0
                      ? `<div style="padding:8px 12px;font-size:0.8em;color:var(--secondary-text-color);">${t("notification.no_targets")}</div>`
                      : allNotifyTargets
                          .map(target => {
                            const checked = selectedTargets.includes(target);
                            const stateObj = hass.states[target];
                            const friendly = stateObj?.attributes?.friendly_name;
                            const displayName = friendly ? `${escapeHtml(friendly)} (${escapeHtml(target)})` : escapeHtml(target);
                            return `<label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:0.85em;"
                                       class="notify-option">
                          <input type="checkbox" class="notify-target-cb" value="${escapeHtml(target)}"
                                 ${checked ? "checked" : ""}
                                 style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                          <span>${displayName}</span>
                        </label>`;
                          })
                          .join("")
                  }
                </div>
              </div>
            </div>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.persistent")}</span>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="g-persistent-notifications" ${persistentNotifications ? "checked" : ""}
                       style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                <span style="font-size:0.8em;color:var(--secondary-text-color);">${t("notification.persistent_hint")}</span>
              </label>
            </div>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.event_bus")}</span>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="g-event-bus" ${eventBus ? "checked" : ""}
                       style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                <span style="font-size:0.8em;color:var(--secondary-text-color);">${t("notification.event_bus_hint")}</span>
              </label>
            </div>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.priority")}</span>
              <select id="g-priority" style="
                background:var(--secondary-background-color,#333);
                border:1px solid var(--divider-color);
                color:var(--primary-text-color);
                border-radius:4px;padding:6px 10px;font-size:0.85em;">
                ${["default", "passive", "active", "time-sensitive", "critical"]
                  .map(p => `<option value="${p}" ${currentPriority === p ? "selected" : ""}>${t(`notification.priority.${p.replace("-", "_")}`)}</option>`)
                  .join("")}
              </select>
              <span style="font-size:0.75em;color:var(--secondary-text-color);margin-left:4px;">
                ${
                  currentPriority === "critical"
                    ? t("notification.hint.critical")
                    : currentPriority === "time-sensitive"
                      ? t("notification.hint.time_sensitive")
                      : currentPriority === "passive"
                        ? t("notification.hint.passive")
                        : currentPriority === "active"
                          ? t("notification.hint.active")
                          : ""
                }
              </span>
            </div>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.title_template")}</span>
              <input type="text" id="g-title-template"
                     value="${escapeHtml(titleTemplate)}"
                     placeholder="SPAN: {name} {alert_type}"
                     style="${TEXT_INPUT_STYLE}">
            </div>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.message_template")}</span>
              <input type="text" id="g-message-template"
                     value="${escapeHtml(messageTemplate)}"
                     placeholder="{name} at {current_a}A ({utilization_pct}% of {breaker_rating_a}A)"
                     style="${TEXT_INPUT_STYLE}">
            </div>

            <div style="font-size:0.75em;color:var(--secondary-text-color);margin-top:4px;line-height:1.4;">
              ${t("notification.placeholders")} <code>{name}</code> <code>{entity_id}</code> <code>{alert_type}</code>
              <code>{current_a}</code> <code>{breaker_rating_a}</code> <code>{threshold_pct}</code>
              <code>{utilization_pct}</code> <code>{window_m}</code>
            </div>
          </div>

          <div id="global-status" style="font-size:0.8em;color:var(--secondary-text-color);margin-top:8px;min-height:1.2em;"></div>
        </div>

        <h3>${t("monitoring.monitored_points")}</h3>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--divider-color);">
              <th style="padding:6px 8px;">${t("monitoring.col.name")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.continuous")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.spike")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.window")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.cooldown")}</th>
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
                  <span style="font-weight:600;font-size:0.85em;color:var(--secondary-text-color);">${t("monitoring.all_none")}</span>
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
    this._bindNotifyTargetSelect(container, hass);
    this._bindNotificationSettings(container, hass);
    this._bindToggleAll(container, hass, circuits, mains);
    this._bindCircuitToggles(container, hass);
    this._bindMainsToggles(container, hass);
    this._bindThresholdInputs(container, hass);
    this._bindResetButtons(container, hass);
  }

  _serviceData(data) {
    if (this._configEntryId) data.config_entry_id = this._configEntryId;
    return data;
  }

  _callSetGlobal(hass, data) {
    return hass.callWS({
      type: "call_service",
      domain: INTEGRATION_DOMAIN,
      service: "set_global_monitoring",
      service_data: this._serviceData({ ...data }),
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
          await this.render(container, hass);
        } catch (err) {
          statusEl.textContent = `${t("error.prefix")} ${err.message || t("error.failed_save")}`;
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
            statusEl2.textContent = `${t("error.prefix")} ${err.message || t("error.failed")}`;
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

  _bindNotifyTargetSelect(container, hass) {
    const btn = container.querySelector("#notify-target-btn");
    const dropdown = container.querySelector("#notify-target-dropdown");
    const label = container.querySelector("#notify-target-label");
    if (!btn || !dropdown) return;

    btn.addEventListener("click", e => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== "none";
      dropdown.style.display = isOpen ? "none" : "block";
    });

    // Close dropdown when clicking outside
    const closeHandler = e => {
      const selectEl = container.querySelector("#notify-target-select");
      if (selectEl && !selectEl.contains(e.target)) {
        dropdown.style.display = "none";
      }
    };
    document.addEventListener("click", closeHandler);
    // Store ref for cleanup on next render (dropdown rebuilt each render)
    this._notifyCloseHandler = closeHandler;

    // Handle checkbox changes
    for (const cb of container.querySelectorAll(".notify-target-cb")) {
      cb.addEventListener("change", () => {
        const checked = [...container.querySelectorAll(".notify-target-cb:checked")];
        const targets = checked.map(c => c.value);
        label.textContent = targets.length ? targets.join(", ") : t("notification.none_selected");

        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(async () => {
          try {
            await this._callSetGlobal(hass, { notify_targets: targets.join(", ") });
          } catch {
            // will show on next render
          }
        }, 500);
      });
    }
  }

  _bindNotificationSettings(container, hass) {
    const persistentCb = container.querySelector("#g-persistent-notifications");
    const eventBusCb = container.querySelector("#g-event-bus");
    const prioritySelect = container.querySelector("#g-priority");
    const titleInput = container.querySelector("#g-title-template");
    const messageInput = container.querySelector("#g-message-template");

    const saveField = (field, value) => {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        try {
          await this._callSetGlobal(hass, { [field]: value });
        } catch {
          // will show on next render
        }
      }, 500);
    };

    if (persistentCb) {
      persistentCb.addEventListener("change", () => {
        saveField("enable_persistent_notifications", persistentCb.checked);
      });
    }
    if (eventBusCb) {
      eventBusCb.addEventListener("change", () => {
        saveField("enable_event_bus", eventBusCb.checked);
      });
    }
    if (prioritySelect) {
      prioritySelect.addEventListener("change", async () => {
        try {
          await this._callSetGlobal(hass, { notification_priority: prioritySelect.value });
          await this.render(container, hass);
        } catch {
          // will show on next render
        }
      });
    }
    if (titleInput) {
      titleInput.addEventListener("input", () => {
        saveField("notification_title_template", titleInput.value);
      });
    }
    if (messageInput) {
      messageInput.addEventListener("input", () => {
        saveField("notification_message_template", messageInput.value);
      });
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
              service_data: this._serviceData({ circuit_id: entityId, monitoring_enabled: enabled }),
            })
            .catch(() => {})
        ),
        ...Object.keys(mains).map(entityId =>
          hass
            .callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_mains_threshold",
              service_data: this._serviceData({ leg: entityId, monitoring_enabled: enabled }),
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
              service_data: this._serviceData({ leg: entityId, monitoring_enabled: enabled }),
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
            service_data: this._serviceData({ circuit_id: entityId, monitoring_enabled: enabled }),
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
                service_data: this._serviceData({ [idField]: entityId, [field]: val }),
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
        const param = this._serviceData(type === "mains" ? { leg: entityId } : { circuit_id: entityId });
        await hass.callService(INTEGRATION_DOMAIN, service, param);
        await this.render(container, hass);
      });
    }
  }
}
