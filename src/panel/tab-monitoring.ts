import { INTEGRATION_DOMAIN, INPUT_DEBOUNCE_MS, THRESHOLD_DEBOUNCE_MS } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import type { ErrorStore } from "../core/error-store.js";
import type { HomeAssistant, MonitoringPointInfo, MonitoringStatusResponse, CallServiceResponse } from "../types.js";

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

function thresholdCell(entityId: string, field: string, value: number | undefined, unit: string, type: string): string {
  return `<td style="padding:6px 4px;">
    <input type="number" class="threshold-input" data-entity="${entityId}" data-field="${field}" data-type="${type}"
           value="${value ?? ""}" min="1" max="${field === "window_duration_m" || field === "cooldown_duration_m" ? 180 : 200}"
           style="${CELL_INPUT_STYLE}"><span style="font-size:0.75em;color:var(--secondary-text-color);">${unit}</span>
  </td>`;
}

export class MonitoringTab {
  errorStore: ErrorStore | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null;
  private _configEntryId: string | null;
  private _notifyCloseHandler: ((e: MouseEvent) => void) | null;
  private _headerHTML: string;

  constructor() {
    this._debounceTimer = null;
    this._configEntryId = null;
    this._notifyCloseHandler = null;
    this._headerHTML = "";
  }

  stop(): void {
    if (this._notifyCloseHandler) {
      document.removeEventListener("click", this._notifyCloseHandler as EventListener);
      this._notifyCloseHandler = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  async render(container: HTMLElement, hass: HomeAssistant, configEntryId?: string, headerHTML: string = ""): Promise<void> {
    if (configEntryId !== undefined) this._configEntryId = configEntryId;
    this._headerHTML = headerHTML;
    if (this._notifyCloseHandler) {
      document.removeEventListener("click", this._notifyCloseHandler as EventListener);
      this._notifyCloseHandler = null;
    }
    let status: MonitoringStatusResponse | null;
    try {
      const serviceData: Record<string, unknown> = {};
      if (this._configEntryId) serviceData.config_entry_id = this._configEntryId;
      const resp = await hass.callWS<CallServiceResponse>({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_monitoring_status",
        service_data: serviceData,
        return_response: true,
      });
      status = (resp?.response as MonitoringStatusResponse) || null;
    } catch {
      status = null;
    }

    const globalSettings = status?.global_settings ?? {};
    const isEnabled = status?.enabled === true;
    const circuits = status?.circuits ?? {};
    const mains = status?.mains ?? {};

    // Discover notify targets from entity state and service registry
    const targetSet = new Set<string>();
    for (const eid of Object.keys(hass.states || {})) {
      if (eid.startsWith("notify.")) targetSet.add(eid);
    }
    // Include service-based targets not yet migrated to entities,
    // excluding the broadcast "notify" and the "send_message" action
    const excludedServices = new Set(["notify", "send_message"]);
    for (const svc of Object.keys(hass.services?.notify || {})) {
      if (!excludedServices.has(svc)) targetSet.add(`notify.${svc}`);
    }
    // Event bus is a virtual target — always available
    targetSet.add("event_bus");
    const allNotifyTargets = [...targetSet].sort();

    const rawTargets = globalSettings.notify_targets ?? "";
    const selectedTargets = (typeof rawTargets === "string" ? rawTargets.split(",") : rawTargets).map((s: string) => s.trim()).filter(Boolean);
    const allTargetsSelected = allNotifyTargets.length > 0 && allNotifyTargets.every(tgt => selectedTargets.includes(tgt));
    const titleTemplate = globalSettings.notification_title_template ?? "SPAN: {name} {alert_type}";
    const messageTemplate = globalSettings.notification_message_template ?? "{name} at {current_a}A ({utilization_pct}% of {breaker_rating_a}A rating)";
    const currentPriority = globalSettings.notification_priority ?? "default";

    const circuitEntries = Object.entries(circuits).sort(([, a], [, b]) => (a.name ?? "").localeCompare(b.name ?? ""));
    const mainsEntries = Object.entries(mains);
    const allPoints: [string, MonitoringPointInfo][] = [...circuitEntries, ...mainsEntries];
    const allEnabled = allPoints.length > 0 && allPoints.every(([, c]) => c.monitoring_enabled !== false);
    const someEnabled = allPoints.some(([, c]) => c.monitoring_enabled !== false);

    const circuitRows = circuitEntries
      .map(([entityId, info]) => {
        const name = escapeHtml(info.name ?? entityId);
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
        const name = escapeHtml(info.name ?? entityId);
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
      ${this._headerHTML}
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
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-right:12px;">
                <input type="checkbox" id="notify-all-targets" ${allTargetsSelected ? "checked" : ""}
                       style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                <span style="font-size:0.8em;color:var(--secondary-text-color);">${t("notification.all_targets")}</span>
              </label>
              <div id="notify-target-select" style="position:relative;flex:1;">
                <button id="notify-target-btn" type="button" style="
                  background:var(--secondary-background-color,#333);
                  border:1px solid var(--divider-color);
                  color:var(--primary-text-color);
                  border-radius:4px;padding:6px 10px;width:100%;font-size:0.85em;
                  text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;
                  ${allTargetsSelected ? "opacity:0.4;pointer-events:none;" : ""}">
                  <span id="notify-target-label">${selectedTargets.length ? selectedTargets.map((s: string) => (s === "event_bus" ? t("notification.event_bus_target") : escapeHtml(s))).join(", ") : t("notification.none_selected")}</span>
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
                            const isEventBus = target === "event_bus";
                            const stateObj = isEventBus ? null : hass.states[target];
                            const friendly = stateObj?.attributes?.friendly_name as string | undefined;
                            const displayLabel = isEventBus
                              ? t("notification.event_bus_target")
                              : friendly
                                ? `${escapeHtml(friendly)} (${escapeHtml(target)})`
                                : escapeHtml(target);
                            return `<label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:0.85em;"
                                       class="notify-option">
                              <input type="checkbox" class="notify-target-cb" value="${escapeHtml(target)}"
                                     ${checked ? "checked" : ""}
                                     style="width:14px;height:14px;accent-color:var(--primary-color,#4dd9af);">
                              <span>${displayLabel}</span>
                            </label>`;
                          })
                          .join("")
                  }
                </div>
              </div>
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
                     placeholder="{name} at {current_a}A ({utilization_pct}% of {breaker_rating_a}A) at {local_time}"
                     style="${TEXT_INPUT_STYLE}">
            </div>

            <div style="font-size:0.75em;color:var(--secondary-text-color);margin-top:4px;line-height:1.4;">
              ${t("notification.placeholders")} <code>{name}</code> <code>{entity_id}</code> <code>{alert_type}</code>
              <code>{current_a}</code> <code>{breaker_rating_a}</code> <code>{threshold_pct}</code>
              <code>{utilization_pct}</code> <code>{window_m}</code> <code>{local_time}</code>
            </div>
            <div style="font-size:0.75em;color:var(--secondary-text-color);margin-top:6px;line-height:1.4;">
              ${t("notification.event_bus_help")} <code>span_panel_current_alert</code>
              ${t("notification.event_bus_payload")} <code>alert_source</code> <code>alert_id</code>
              <code>alert_name</code> <code>alert_type</code> <code>current_a</code>
              <code>breaker_rating_a</code> <code>threshold_pct</code> <code>utilization_pct</code>
              <code>panel_serial</code> <code>window_duration_s</code> <code>local_time</code>
            </div>

            <div style="display:flex;align-items:center;gap:10px;margin-top:12px;">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.test_label")}</span>
              <button id="test-notification-btn" type="button" style="
                background:var(--primary-color,#4dd9af);color:#000;border:none;
                border-radius:4px;padding:6px 16px;font-size:0.85em;cursor:pointer;
                font-weight:500;">
                ${t("notification.test_button")}
              </button>
              <span id="test-notification-status" style="font-size:0.8em;color:var(--secondary-text-color);"></span>
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
    const toggleAllCb = container.querySelector<HTMLInputElement>("#toggle-all-circuits");
    if (toggleAllCb && !allEnabled && someEnabled) {
      toggleAllCb.indeterminate = true;
    }

    // Set indeterminate state on all-targets toggle
    const allTargetsInit = container.querySelector<HTMLInputElement>("#notify-all-targets");
    if (allTargetsInit && allNotifyTargets.length > 0) {
      const someSelected = selectedTargets.length > 0;
      if (!allTargetsSelected && someSelected) {
        allTargetsInit.indeterminate = true;
      }
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

  private _serviceData(data: Record<string, unknown>): Record<string, unknown> {
    if (this._configEntryId) data.config_entry_id = this._configEntryId;
    return data;
  }

  private _callSetGlobal(hass: HomeAssistant, data: Record<string, unknown>): Promise<unknown> {
    return hass.callWS({
      type: "call_service",
      domain: INTEGRATION_DOMAIN,
      service: "set_global_monitoring",
      service_data: this._serviceData({ ...data }),
    });
  }

  private _bindGlobalControls(container: HTMLElement, hass: HomeAssistant): void {
    const enabledCheckbox = container.querySelector<HTMLInputElement>("#monitoring-enabled");
    const fieldsDiv = container.querySelector<HTMLElement>("#global-fields");
    const statusEl = container.querySelector<HTMLElement>("#global-status");

    const saveGlobal = (): void => {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        const data: Record<string, number> = {
          continuous_threshold_pct: parseInt(container.querySelector<HTMLInputElement>("#g-continuous")!.value, 10),
          spike_threshold_pct: parseInt(container.querySelector<HTMLInputElement>("#g-spike")!.value, 10),
          window_duration_m: parseInt(container.querySelector<HTMLInputElement>("#g-window")!.value, 10),
          cooldown_duration_m: parseInt(container.querySelector<HTMLInputElement>("#g-cooldown")!.value, 10),
        };
        try {
          await this._callSetGlobal(hass, data);
          await this.render(container, hass);
        } catch (err: unknown) {
          if (statusEl) {
            const message = err instanceof Error ? err.message : t("error.failed_save");
            statusEl.textContent = `${t("error.prefix")} ${message}`;
            statusEl.style.color = "var(--error-color, #f44336)";
          }
        }
      }, INPUT_DEBOUNCE_MS);
    };

    if (enabledCheckbox) {
      enabledCheckbox.addEventListener("change", async () => {
        const enabled = enabledCheckbox.checked;
        if (fieldsDiv) {
          fieldsDiv.style.opacity = enabled ? "" : "0.4";
          fieldsDiv.style.pointerEvents = enabled ? "" : "none";
        }
        const statusEl2 = container.querySelector<HTMLElement>("#global-status");
        try {
          if (enabled) {
            const data: Record<string, number> = {
              continuous_threshold_pct: parseInt(container.querySelector<HTMLInputElement>("#g-continuous")!.value, 10),
              spike_threshold_pct: parseInt(container.querySelector<HTMLInputElement>("#g-spike")!.value, 10),
              window_duration_m: parseInt(container.querySelector<HTMLInputElement>("#g-window")!.value, 10),
              cooldown_duration_m: parseInt(container.querySelector<HTMLInputElement>("#g-cooldown")!.value, 10),
            };
            await this._callSetGlobal(hass, data);
          } else {
            await this._callSetGlobal(hass, { enabled: false });
          }
        } catch (err: unknown) {
          if (statusEl2) {
            const message = err instanceof Error ? err.message : t("error.failed");
            statusEl2.textContent = `${t("error.prefix")} ${message}`;
            statusEl2.style.color = "var(--error-color, #f44336)";
          }
          return;
        }
        await this.render(container, hass);
      });
    }

    for (const input of container.querySelectorAll<HTMLInputElement>("#global-fields input[type=number]")) {
      input.addEventListener("input", saveGlobal);
    }
  }

  private _bindNotifyTargetSelect(container: HTMLElement, hass: HomeAssistant): void {
    const btn = container.querySelector<HTMLButtonElement>("#notify-target-btn");
    const dropdown = container.querySelector<HTMLElement>("#notify-target-dropdown");
    const label = container.querySelector<HTMLElement>("#notify-target-label");
    if (!btn || !dropdown) return;

    btn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== "none";
      dropdown.style.display = isOpen ? "none" : "block";
    });

    // Close dropdown when clicking outside
    const closeHandler = (e: MouseEvent): void => {
      const selectEl = container.querySelector("#notify-target-select");
      if (selectEl && !selectEl.contains(e.target as Node)) {
        dropdown.style.display = "none";
      }
    };
    document.addEventListener("click", closeHandler as EventListener);
    // Store ref for cleanup on next render (dropdown rebuilt each render)
    this._notifyCloseHandler = closeHandler;

    const saveTargets = (): void => {
      const checked = [...container.querySelectorAll<HTMLInputElement>(".notify-target-cb:checked")];
      const targets = checked.map(c => c.value);
      if (label) {
        const displayTargets = targets.map(v => (v === "event_bus" ? t("notification.event_bus_target") : v));
        label.textContent = displayTargets.length ? displayTargets.join(", ") : t("notification.none_selected");
      }
      // Sync the "All Targets" checkbox state
      const allCb = container.querySelector<HTMLInputElement>("#notify-all-targets");
      if (allCb) {
        const allCbs = [...container.querySelectorAll<HTMLInputElement>(".notify-target-cb")];
        allCb.checked = allCbs.length > 0 && allCbs.every(c => c.checked);
        allCb.indeterminate = !allCb.checked && allCbs.some(c => c.checked);
      }
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        try {
          await this._callSetGlobal(hass, { notify_targets: targets.join(", ") });
        } catch (err) {
          console.warn("SPAN Panel: notification targets save failed", err);
          this.errorStore?.add({
            key: "service:monitoring",
            level: "error",
            message: t("error.threshold_failed"),
            persistent: false,
          });
        }
      }, INPUT_DEBOUNCE_MS);
    };

    // "All Targets" toggle
    const allTargetsCb = container.querySelector<HTMLInputElement>("#notify-all-targets");
    if (allTargetsCb) {
      allTargetsCb.addEventListener("change", () => {
        for (const cb of container.querySelectorAll<HTMLInputElement>(".notify-target-cb")) {
          cb.checked = allTargetsCb.checked;
        }
        // Enable/disable dropdown
        const btnEl = container.querySelector<HTMLButtonElement>("#notify-target-btn");
        if (btnEl) {
          btnEl.style.opacity = allTargetsCb.checked ? "0.4" : "";
          btnEl.style.pointerEvents = allTargetsCb.checked ? "none" : "";
        }
        if (allTargetsCb.checked) dropdown.style.display = "none";
        saveTargets();
      });
    }

    // Individual target checkboxes
    for (const cb of container.querySelectorAll<HTMLInputElement>(".notify-target-cb")) {
      cb.addEventListener("change", () => {
        saveTargets();
      });
    }
  }

  private _bindNotificationSettings(container: HTMLElement, hass: HomeAssistant): void {
    const prioritySelect = container.querySelector<HTMLSelectElement>("#g-priority");
    const titleInput = container.querySelector<HTMLInputElement>("#g-title-template");
    const messageInput = container.querySelector<HTMLInputElement>("#g-message-template");

    const saveField = (field: string, value: string | boolean): void => {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(async () => {
        try {
          await this._callSetGlobal(hass, { [field]: value });
        } catch (err) {
          console.warn("SPAN Panel: notification settings save failed", err);
          this.errorStore?.add({
            key: "service:monitoring",
            level: "error",
            message: t("error.threshold_failed"),
            persistent: false,
          });
        }
      }, INPUT_DEBOUNCE_MS);
    };

    if (prioritySelect) {
      prioritySelect.addEventListener("change", async () => {
        try {
          await this._callSetGlobal(hass, { notification_priority: prioritySelect.value });
          await this.render(container, hass);
        } catch (err) {
          console.warn("SPAN Panel: notification priority change failed", err);
          this.errorStore?.add({
            key: "service:monitoring",
            level: "error",
            message: t("error.threshold_failed"),
            persistent: false,
          });
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

    const testBtn = container.querySelector<HTMLButtonElement>("#test-notification-btn");
    const testStatus = container.querySelector<HTMLElement>("#test-notification-status");
    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        if (testStatus) {
          testStatus.textContent = t("notification.test_sending");
          testStatus.style.color = "var(--secondary-text-color)";
        }
        try {
          // Flush any pending settings save before testing
          if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
          }
          // Save current notify_targets so the test uses the latest selections
          const checked = [...container.querySelectorAll<HTMLInputElement>(".notify-target-cb:checked")];
          const currentTargets = checked.map(c => c.value).join(", ");
          await this._callSetGlobal(hass, { notify_targets: currentTargets });

          const serviceData: Record<string, unknown> = {};
          if (this._configEntryId) serviceData.config_entry_id = this._configEntryId;
          await hass.callWS({
            type: "call_service",
            domain: INTEGRATION_DOMAIN,
            service: "test_notification",
            service_data: serviceData,
          });
          if (testStatus) {
            testStatus.textContent = t("notification.test_sent");
            testStatus.style.color = "var(--success-color, #4caf50)";
          }
        } catch (err: unknown) {
          if (testStatus) {
            const message = err instanceof Error ? err.message : t("error.failed");
            testStatus.textContent = `${t("error.prefix")} ${message}`;
            testStatus.style.color = "var(--error-color, #f44336)";
          }
        } finally {
          testBtn.disabled = false;
        }
      });
    }
  }

  private _bindToggleAll(
    container: HTMLElement,
    hass: HomeAssistant,
    circuits: Record<string, MonitoringPointInfo>,
    mains: Record<string, MonitoringPointInfo>
  ): void {
    const toggleAll = container.querySelector<HTMLInputElement>("#toggle-all-circuits");
    if (!toggleAll) return;
    toggleAll.addEventListener("change", async () => {
      const enabled = toggleAll.checked;
      const calls: Promise<unknown>[] = [
        ...Object.keys(circuits).map(entityId =>
          hass
            .callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_circuit_threshold",
              service_data: this._serviceData({ circuit_id: entityId, monitoring_enabled: enabled }),
            })
            .catch(err => {
              console.warn("SPAN Panel: circuit monitoring toggle failed", err);
              this.errorStore?.add({
                key: "service:monitoring",
                level: "error",
                message: t("error.threshold_failed"),
                persistent: false,
              });
            })
        ),
        ...Object.keys(mains).map(entityId =>
          hass
            .callWS({
              type: "call_service",
              domain: INTEGRATION_DOMAIN,
              service: "set_mains_threshold",
              service_data: this._serviceData({ leg: entityId, monitoring_enabled: enabled }),
            })
            .catch(err => {
              console.warn("SPAN Panel: mains monitoring toggle failed", err);
              this.errorStore?.add({
                key: "service:monitoring",
                level: "error",
                message: t("error.threshold_failed"),
                persistent: false,
              });
            })
        ),
      ];
      await Promise.all(calls);
      await this.render(container, hass);
    });
  }

  private _bindMainsToggles(container: HTMLElement, hass: HomeAssistant): void {
    for (const cb of container.querySelectorAll<HTMLInputElement>(".mains-toggle")) {
      cb.addEventListener("change", async () => {
        const entityId = cb.dataset.entity;
        const enabled = cb.checked;
        try {
          await hass.callWS({
            type: "call_service",
            domain: INTEGRATION_DOMAIN,
            service: "set_mains_threshold",
            service_data: this._serviceData({ leg: entityId, monitoring_enabled: enabled }),
          });
        } catch (err) {
          console.warn("SPAN Panel: mains threshold toggle failed", err);
          this.errorStore?.add({
            key: "service:monitoring",
            level: "error",
            message: t("error.threshold_failed"),
            persistent: false,
          });
          cb.checked = !enabled;
          return;
        }
        await this.render(container, hass);
      });
    }
  }

  private _bindCircuitToggles(container: HTMLElement, hass: HomeAssistant): void {
    for (const cb of container.querySelectorAll<HTMLInputElement>(".circuit-toggle")) {
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
        } catch (err) {
          console.warn("SPAN Panel: circuit threshold toggle failed", err);
          this.errorStore?.add({
            key: "service:monitoring",
            level: "error",
            message: t("error.threshold_failed"),
            persistent: false,
          });
          cb.checked = !enabled;
          return;
        }
        await this.render(container, hass);
      });
    }
  }

  private _bindThresholdInputs(container: HTMLElement, hass: HomeAssistant): void {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    for (const input of container.querySelectorAll<HTMLInputElement>(".threshold-input")) {
      input.addEventListener("input", () => {
        const key = `${input.dataset.entity}-${input.dataset.field}`;
        const existing = timers.get(key);
        if (existing) clearTimeout(existing);
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
                service_data: this._serviceData({ [idField]: entityId, [field!]: val }),
              });
              // Re-render to update Custom badge and Reset button
              await this.render(container, hass);
            } catch (err) {
              console.warn("SPAN Panel: threshold input save failed", err);
              this.errorStore?.add({
                key: "service:monitoring",
                level: "error",
                message: t("error.threshold_failed"),
                persistent: false,
              });
              input.style.borderColor = "var(--error-color, #f44336)";
            }
          }, THRESHOLD_DEBOUNCE_MS)
        );
      });
    }
  }

  private _bindResetButtons(container: HTMLElement, hass: HomeAssistant): void {
    for (const btn of container.querySelectorAll<HTMLElement>(".reset-btn")) {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.entity;
        if (!entityId) return;
        const type = btn.dataset.type;
        const service = type === "mains" ? "clear_mains_threshold" : "clear_circuit_threshold";
        const param = this._serviceData(type === "mains" ? { leg: entityId } : { circuit_id: entityId });
        await hass.callService(INTEGRATION_DOMAIN, service, param);
        await this.render(container, hass);
      });
    }
  }
}
