import { INTEGRATION_DOMAIN, INPUT_DEBOUNCE_MS } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { errorText, serviceErrorMessage } from "../helpers/error-text.js";
import { t, tf } from "../i18n.js";
import { monitoringRatingView, ratingLabelHTML, toggleRatingNote } from "../helpers/monitoring-rating.js";
import { focusedIn } from "../helpers/focus.js";
import { bindLimitField, isLimitField, LIMIT_RANGES, type LimitField, type LimitFieldHandle } from "../helpers/number-field.js";
import type { ErrorStore } from "../core/error-store.js";
import type { HomeAssistant, MonitoringPointInfo, MonitoringStatusResponse, CallServiceResponse } from "../types.js";

const FIELD_STYLE = `
  display:flex;align-items:center;gap:8px;margin-bottom:8px;
`;
/** The colour a field's border is drawn in, and goes back to once it no longer needs correcting. */
const FIELD_BORDER = "var(--divider-color)";

const INPUT_STYLE = `
  background:var(--secondary-background-color,#333);
  border:1px solid ${FIELD_BORDER};
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
  border:1px solid ${FIELD_BORDER};
  color:var(--primary-text-color);
  border-radius:3px;padding:3px 6px;width:50px;font-size:0.8em;
  text-align:center;
`;
const FEEDBACK_STYLE = `
  font-size:0.75em;color:var(--error-color,#f44336);
  max-width:10em;white-space:normal;line-height:1.3;
`;
const ERROR_BORDER = "var(--error-color,#f44336)";

let feedbackSerial = 0;

/** An id for a field's feedback, unique in the shadow root every panel's tab is drawn in. */
function nextFeedbackId(): string {
  feedbackSerial += 1;
  return `span-monitoring-feedback-${feedbackSerial}`;
}

/** The global settings' threshold and duration fields, by the field each sets. */
const GLOBAL_FIELDS: ReadonlyArray<readonly [LimitField, string]> = [
  ["continuous_threshold_pct", "#g-continuous"],
  ["spike_threshold_pct", "#g-spike"],
  ["window_duration_m", "#g-window"],
  ["cooldown_duration_m", "#g-cooldown"],
];

/**
 * Give a threshold or duration field a place after it that says what it needs
 * correcting, as its description and a polite live region, with its border
 * marked while it does; answers what reports into it.
 */
function fieldFeedback(input: HTMLInputElement): (message: string | null) => void {
  const feedback = document.createElement("div");
  feedback.id = nextFeedbackId();
  feedback.setAttribute("aria-live", "polite");
  feedback.style.cssText = FEEDBACK_STYLE;
  input.setAttribute("aria-describedby", feedback.id);
  input.parentElement?.appendChild(feedback);
  // The colour goes back to the one the field is drawn in, never to what the border reads: Chromium reads a
  // longhand of a shorthand holding var() as "", and setting that would drop the colour.
  return message => {
    feedback.textContent = message ?? "";
    input.style.borderColor = message ? ERROR_BORDER : FIELD_BORDER;
  };
}

/** The row controls the redraw keeps focus on, by class: each is named by the class and its point. */
const ROW_CONTROLS = ["reset-btn", "circuit-toggle", "mains-toggle"] as const;

/** The controls a redraw can put focus back on. */
const KEPT_CONTROLS = ["[id]", ".threshold-input", ...ROW_CONTROLS.map(name => `.${name}`)].join(", ");

/**
 * A control's name across a redraw: its id; the point and field a threshold cell
 * is for; or a row control's class and its point.
 */
function controlKey(el: HTMLElement): string | null {
  if (el.id) return `#${el.id}`;
  const { entity, field } = el.dataset;
  if (entity === undefined) return null;
  if (el.classList.contains("threshold-input")) return field !== undefined ? fieldKey(entity, field) : null;
  const control = ROW_CONTROLS.find(name => el.classList.contains(name));
  return control ? `${control}\u0000${entity}` : null;
}

function fieldKey(entity: string, field: string): string {
  return `${entity}\u0000${field}`;
}

/** The control focused in the tab, and what was typed in it and not yet stored. */
interface KeptFocus {
  /** The control, then where focus goes in its row should the redraw not draw it again. */
  readonly keys: readonly string[];
  readonly draft: string | null;
}

function keptFocus(container: HTMLElement): KeptFocus | null {
  const focused = focusedIn(container);
  const key = focused ? controlKey(focused) : null;
  if (!focused || key === null) return null;
  // A Reset goes with the override it cleared: focus then goes to the row's first field.
  const entity = focused.dataset.entity;
  const keys = focused.classList.contains("reset-btn") && entity !== undefined ? [key, fieldKey(entity, "continuous_threshold_pct")] : [key];
  const draft = focused instanceof HTMLInputElement && focused.value !== focused.defaultValue ? focused.value : null;
  return { keys, draft };
}

/**
 * Put focus back on the control that had it before a redraw, with what the user
 * had typed there and not yet stored: that typing is still theirs to commit, so
 * the redrawn field takes it as typing. Where the redraw no longer draws that
 * control, focus goes to the next place `kept` names.
 */
function restoreFocus(container: HTMLElement, kept: KeptFocus | null): void {
  if (!kept) return;
  const drawn = [...container.querySelectorAll<HTMLElement>(KEPT_CONTROLS)];
  for (const key of kept.keys) {
    const control = drawn.find(el => controlKey(el) === key);
    if (!control) continue;
    if (kept.draft !== null && control instanceof HTMLInputElement && control.value !== kept.draft) {
      control.value = kept.draft;
      control.dispatchEvent(new Event("input"));
    }
    control.focus();
    return;
  }
}

/**
 * Lightweight runtime-coerce for the ``get_monitoring_status`` response.
 * The backend returns JSON whose shape is nominally ``MonitoringStatusResponse``
 * but we can't trust the WebSocket payload, so we narrow what we can and
 * return ``null`` if the shape is unusable. Unknown fields are dropped.
 */
function coerceMonitoringStatusResponse(resp: unknown): MonitoringStatusResponse | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const out: MonitoringStatusResponse = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (r.global_settings && typeof r.global_settings === "object") {
    out.global_settings = r.global_settings as MonitoringStatusResponse["global_settings"];
  }
  if (r.circuits && typeof r.circuits === "object") {
    out.circuits = r.circuits as Record<string, MonitoringPointInfo>;
  }
  if (r.mains && typeof r.mains === "object") {
    out.mains = r.mains as Record<string, MonitoringPointInfo>;
  }
  return out;
}

/** The label each threshold and duration field goes by, its unit included. */
const FIELD_LABELS: Readonly<Record<LimitField, string>> = {
  continuous_threshold_pct: "monitoring.continuous",
  spike_threshold_pct: "monitoring.spike",
  window_duration_m: "monitoring.window",
  cooldown_duration_m: "monitoring.cooldown",
};

/**
 * A point's threshold or duration field. The column header does not name a field
 * for a screen reader, so the field is named by what it sets and the point's
 * name (`name`, as written; it is escaped here).
 */
function thresholdCell(entityId: string, name: string, field: LimitField, value: number | undefined, unit: string, type: string): string {
  const { min, max } = LIMIT_RANGES[field];
  const label = escapeHtml(tf("monitoring.point_field", { field: t(FIELD_LABELS[field]), name }));
  return `<td style="padding:6px 4px;">
    <input type="number" class="threshold-input" data-entity="${entityId}" data-field="${field}" data-type="${type}"
           value="${value ?? ""}" min="${min}" max="${max}" step="1" aria-label="${label}"
           style="${CELL_INPUT_STYLE}"><span style="font-size:0.75em;color:var(--secondary-text-color);">${unit}</span>
  </td>`;
}

/**
 * The rating a point is judged against, with the user-set mark; "no rating" for a
 * point with none, which the monitor skips. The mains has no monitoring rating, so it is never marked.
 */
function ratingCell(info: MonitoringPointInfo, isMains: boolean): string {
  const view = monitoringRatingView(info);
  const label = ratingLabelHTML({ ...view, userSet: !isMains && view.userSet });
  const content = label || `<span style="color:var(--secondary-text-color);">${escapeHtml(t("monitoringRating.none"))}</span>`;
  return `<td class="rating-cell" style="padding:6px 4px;white-space:nowrap;">${content}</td>`;
}

/** A notification setting saved once the user pauses: its targets or one of its templates. */
type PausedSetting = "notify_targets" | "notification_title_template" | "notification_message_template";

/**
 * A save that waits for the user to pause, as a run of target choices or a
 * typed template does. Each setting has its own, so a change to one never
 * cancels another's; a later change to the same setting replaces what waits.
 * A flush sends what waits at once rather than dropping it.
 */
class PendingSave {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _send: (() => Promise<void>) | null = null;

  /** Send `send` once `ms` pass with no other change to this setting. */
  schedule(send: () => Promise<void>, ms: number): void {
    this._clear();
    this._send = send;
    this._timer = setTimeout(() => {
      // A save that fails has said so where it failed.
      this.flush().catch(() => undefined);
    }, ms);
  }

  /** Send what waits now, if anything: resolves once it is stored, rejects where it could not be. */
  flush(): Promise<void> {
    const send = this._send;
    this._clear();
    return send ? send() : Promise.resolve();
  }

  private _clear(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._send = null;
  }
}

export class MonitoringTab {
  errorStore: ErrorStore | null = null;
  private readonly _pendingSaves = new Map<PausedSetting, PendingSave>();
  private _configEntryId: string | null;
  private _notifyCloseHandler: ((e: MouseEvent) => void) | null;
  private _headerHTML: string;
  /** Moves on each stop, so what a save started before the user left the tab draws nothing after. */
  private _epoch = 0;
  /** Counts reads of the table, so an earlier read answering late cannot draw over a later one. */
  private _renderSeq = 0;

  constructor() {
    this._configEntryId = null;
    this._notifyCloseHandler = null;
    this._headerHTML = "";
  }

  stop(): void {
    this._epoch += 1;
    if (this._notifyCloseHandler) {
      document.removeEventListener("click", this._notifyCloseHandler as EventListener);
      this._notifyCloseHandler = null;
    }
    // What the user changed and is waiting to be saved is sent, not dropped, as they leave.
    this._flushPendingSaves().catch(() => undefined);
  }

  async render(container: HTMLElement, hass: HomeAssistant, configEntryId?: string, headerHTML: string = ""): Promise<void> {
    // Focus, and what was typed, is kept across a redraw of the same panel's settings, never carried to another's.
    const samePanel = configEntryId === undefined || configEntryId === this._configEntryId;
    if (configEntryId !== undefined) this._configEntryId = configEntryId;
    this._headerHTML = headerHTML;
    if (this._notifyCloseHandler) {
      document.removeEventListener("click", this._notifyCloseHandler as EventListener);
      this._notifyCloseHandler = null;
    }
    const epoch = this._epoch;
    const seq = ++this._renderSeq;
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
      status = coerceMonitoringStatusResponse(resp?.response);
    } catch (err) {
      console.warn("SPAN Panel: monitoring status fetch failed", err);
      status = null;
    }
    if (epoch !== this._epoch || seq !== this._renderSeq) return;

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
        const written = info.name ?? entityId;
        const name = escapeHtml(written);
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
            ${ratingCell(info, false)}
            ${thresholdCell(eid, written, "continuous_threshold_pct", info.continuous_threshold_pct, "%", "circuit")}
            ${thresholdCell(eid, written, "spike_threshold_pct", info.spike_threshold_pct, "%", "circuit")}
            ${thresholdCell(eid, written, "window_duration_m", info.window_duration_m, "m", "circuit")}
            ${thresholdCell(eid, written, "cooldown_duration_m", info.cooldown_duration_m, "m", "circuit")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="circuit"
                       aria-label="${escapeHtml(tf("monitoring.reset_point", { name: written }))}"
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
        const written = info.name ?? entityId;
        const name = escapeHtml(written);
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
            ${ratingCell(info, true)}
            ${thresholdCell(eid, written, "continuous_threshold_pct", info.continuous_threshold_pct, "%", "mains")}
            ${thresholdCell(eid, written, "spike_threshold_pct", info.spike_threshold_pct, "%", "mains")}
            ${thresholdCell(eid, written, "window_duration_m", info.window_duration_m, "m", "mains")}
            ${thresholdCell(eid, written, "cooldown_duration_m", info.cooldown_duration_m, "m", "mains")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="mains"
                       aria-label="${escapeHtml(tf("monitoring.reset_point", { name: written }))}"
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

    const kept = samePanel ? keptFocus(container) : null;
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
              <input type="number" id="g-continuous" aria-label="${escapeHtml(t("monitoring.continuous"))}" min="${LIMIT_RANGES.continuous_threshold_pct.min}" max="${LIMIT_RANGES.continuous_threshold_pct.max}" step="1"
                     value="${globalSettings.continuous_threshold_pct ?? 80}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.spike")}</span>
              <input type="number" id="g-spike" aria-label="${escapeHtml(t("monitoring.spike"))}" min="${LIMIT_RANGES.spike_threshold_pct.min}" max="${LIMIT_RANGES.spike_threshold_pct.max}" step="1"
                     value="${globalSettings.spike_threshold_pct ?? 100}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.window")}</span>
              <input type="number" id="g-window" aria-label="${escapeHtml(t("monitoring.window"))}" min="${LIMIT_RANGES.window_duration_m.min}" max="${LIMIT_RANGES.window_duration_m.max}" step="1"
                     value="${globalSettings.window_duration_m ?? 5}"
                     style="${INPUT_STYLE}">
            </div>
            <div style="${FIELD_STYLE}">
              <span style="${LABEL_STYLE}">${t("monitoring.cooldown")}</span>
              <input type="number" id="g-cooldown" aria-label="${escapeHtml(t("monitoring.cooldown"))}" min="${LIMIT_RANGES.cooldown_duration_m.min}" max="${LIMIT_RANGES.cooldown_duration_m.max}" step="1"
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
              <select id="g-priority" aria-label="${escapeHtml(t("notification.priority"))}" style="
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
              <input type="text" id="g-title-template" aria-label="${escapeHtml(t("notification.title_template"))}"
                     value="${escapeHtml(titleTemplate)}"
                     placeholder="SPAN: {name} {alert_type}"
                     style="${TEXT_INPUT_STYLE}">
            </div>

            <div style="${FIELD_STYLE}">
              <span style="${WIDE_LABEL_STYLE}">${t("notification.message_template")}</span>
              <input type="text" id="g-message-template" aria-label="${escapeHtml(t("notification.message_template"))}"
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
              <th style="padding:6px 8px;">${t("monitoring.rating")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.continuous")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.spike")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.window")}</th>
              <th style="padding:6px 8px;">${t("monitoring.col.cooldown")}</th>
              <th style="padding:6px 8px;"></th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid var(--divider-color,#333);">
              <td style="padding:6px 8px;" colspan="6">
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
    this._bindRatingMarks(container);
    restoreFocus(container, kept);
  }

  /**
   * Read and draw the tab again, unless the user has left it since `epoch`, when
   * a save began: the container is another tab's by then. Every redraw after a
   * save comes through here.
   */
  private async _redraw(container: HTMLElement, hass: HomeAssistant, epoch: number): Promise<void> {
    if (epoch === this._epoch) await this.render(container, hass);
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

  /**
   * Save notification setting `setting` as `value` once the user pauses. The
   * panel it is for is taken now, so a save still waiting as the tab is drawn
   * for another panel goes to the one it was made for.
   */
  private _saveOnPause(hass: HomeAssistant, setting: PausedSetting, value: string): void {
    const serviceData = this._serviceData({ [setting]: value });
    const send = async (): Promise<void> => {
      try {
        await hass.callWS({ type: "call_service", domain: INTEGRATION_DOMAIN, service: "set_global_monitoring", service_data: serviceData });
      } catch (err: unknown) {
        console.warn(`SPAN Panel: ${setting} save failed`, err);
        this.errorStore?.add({ key: "service:monitoring", level: "error", message: t("error.threshold_failed"), persistent: false });
        throw err;
      }
    };
    let pending = this._pendingSaves.get(setting);
    if (!pending) {
      pending = new PendingSave();
      this._pendingSaves.set(setting, pending);
    }
    pending.schedule(send, INPUT_DEBOUNCE_MS);
  }

  /** Send every notification setting waiting to be saved; rejects where one could not be. */
  private async _flushPendingSaves(): Promise<void> {
    await Promise.all([...this._pendingSaves.values()].map(pending => pending.flush()));
  }

  private _bindGlobalControls(container: HTMLElement, hass: HomeAssistant): void {
    const enabledCheckbox = container.querySelector<HTMLInputElement>("#monitoring-enabled");
    const fieldsDiv = container.querySelector<HTMLElement>("#global-fields");
    const statusEl = container.querySelector<HTMLElement>("#global-status");

    const reportFailure = (target: HTMLElement | null, err: unknown, fallback: string): void => {
      if (!target) return;
      // `null` is a form that failed validation: there is no rejection to report.
      const message = err === null ? fallback : errorText(err);
      target.textContent = `${t("error.prefix")} ${message}`;
      target.style.color = "var(--error-color, #f44336)";
    };

    // The tab is read again after a save, since every point on the global thresholds shows them.
    const saveGlobal = async (data: Record<string, number>): Promise<void> => {
      const epoch = this._epoch;
      try {
        await this._callSetGlobal(hass, data);
      } catch (err: unknown) {
        reportFailure(statusEl, err, t("error.failed_save"));
        return;
      }
      await this._redraw(container, hass, epoch);
    };

    // Each field saves as the table's fields do, only as the user entered it, and only itself.
    const bound = new Map<LimitField, LimitFieldHandle>();
    for (const [field, selector] of GLOBAL_FIELDS) {
      const input = container.querySelector<HTMLInputElement>(selector);
      if (!input) continue;
      bound.set(field, bindLimitField(input, field, { report: fieldFeedback(input), save: amount => void saveGlobal({ [field]: amount }) }));
    }

    /**
     * The four global fields as they stand, each checked as a commit checks it;
     * null where one is not a whole number in its range, each such field marked.
     */
    const readGlobalFields = (): Record<string, number> | null => {
      const out: Record<string, number> = {};
      let valid = true;
      for (const [field] of GLOBAL_FIELDS) {
        const amount = bound.get(field)?.check() ?? null;
        if (amount === null) valid = false;
        else out[field] = amount;
      }
      return valid ? out : null;
    };

    /** Show the global fields as monitoring on or off: dimmed while off. */
    const showFields = (on: boolean): void => {
      if (!fieldsDiv) return;
      fieldsDiv.style.opacity = on ? "" : "0.4";
      fieldsDiv.style.pointerEvents = on ? "" : "none";
    };

    if (enabledCheckbox) {
      // Turning monitoring on sends the four global fields as they stand, so it is
      // refused where one is not a whole number in its range; refused, or refused
      // by the integration, the switch and the fields are put back as they were.
      enabledCheckbox.addEventListener("change", async () => {
        const epoch = this._epoch;
        const enabled = enabledCheckbox.checked;
        const putBack = (): void => {
          enabledCheckbox.checked = !enabled;
          showFields(!enabled);
        };
        showFields(enabled);
        try {
          if (enabled) {
            const data = readGlobalFields();
            if (!data) {
              putBack();
              reportFailure(statusEl, null, t("monitoring.enable_invalid"));
              return;
            }
            await this._callSetGlobal(hass, data);
          } else {
            await this._callSetGlobal(hass, { enabled: false });
          }
        } catch (err: unknown) {
          putBack();
          reportFailure(statusEl, err, t("error.failed"));
          return;
        }
        await this._redraw(container, hass, epoch);
      });
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
      this._saveOnPause(hass, "notify_targets", targets.join(", "));
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

    if (prioritySelect) {
      prioritySelect.addEventListener("change", async () => {
        const epoch = this._epoch;
        try {
          await this._callSetGlobal(hass, { notification_priority: prioritySelect.value });
          await this._redraw(container, hass, epoch);
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
        this._saveOnPause(hass, "notification_title_template", titleInput.value);
      });
    }
    if (messageInput) {
      messageInput.addEventListener("input", () => {
        this._saveOnPause(hass, "notification_message_template", messageInput.value);
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
          // The test uses what is stored, so what waits to be saved is sent first, with the target
          // choices as they stand, in place of any still waiting; one that fails stops the test.
          const checked = [...container.querySelectorAll<HTMLInputElement>(".notify-target-cb:checked")];
          this._saveOnPause(hass, "notify_targets", checked.map(c => c.value).join(", "));
          await this._flushPendingSaves();

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
            const message = errorText(err);
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
      const epoch = this._epoch;
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
      await this._redraw(container, hass, epoch);
    });
  }

  private _bindMainsToggles(container: HTMLElement, hass: HomeAssistant): void {
    for (const cb of container.querySelectorAll<HTMLInputElement>(".mains-toggle")) {
      cb.addEventListener("change", async () => {
        const epoch = this._epoch;
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
        await this._redraw(container, hass, epoch);
      });
    }
  }

  private _bindCircuitToggles(container: HTMLElement, hass: HomeAssistant): void {
    for (const cb of container.querySelectorAll<HTMLInputElement>(".circuit-toggle")) {
      cb.addEventListener("change", async () => {
        const epoch = this._epoch;
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
        await this._redraw(container, hass, epoch);
      });
    }
  }

  /**
   * The table's threshold and duration fields save as the side panel's do, only
   * as the user entered them (`bindLimitField`), each saying under it what it
   * needs correcting. A save reads the table again rather than patching its row:
   * the integration drops an override that matches the global settings, and a
   * shared meter's members share one, so only its answer says what each row holds.
   */
  private _bindThresholdInputs(container: HTMLElement, hass: HomeAssistant): void {
    for (const input of container.querySelectorAll<HTMLInputElement>(".threshold-input")) {
      const field = input.dataset.field;
      const entityId = input.dataset.entity;
      if (!isLimitField(field) || entityId === undefined) continue;
      const isMains = input.dataset.type === "mains";
      bindLimitField(input, field, {
        report: fieldFeedback(input),
        save: amount => {
          const service = isMains ? "set_mains_threshold" : "set_circuit_threshold";
          const data = isMains ? { leg: entityId, [field]: amount } : { circuit_id: entityId, [field]: amount };
          void this._saveThreshold(container, hass, input, service, data);
        },
      });
    }
  }

  private async _saveThreshold(
    container: HTMLElement,
    hass: HomeAssistant,
    input: HTMLInputElement,
    service: string,
    data: Record<string, unknown>
  ): Promise<void> {
    const epoch = this._epoch;
    try {
      await hass.callWS({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service,
        service_data: this._serviceData(data),
      });
    } catch (err) {
      console.warn("SPAN Panel: threshold input save failed", err);
      this.errorStore?.add({
        key: "service:monitoring",
        level: "error",
        message: t("error.threshold_failed"),
        persistent: false,
      });
      input.style.borderColor = ERROR_BORDER;
      return;
    }
    await this._redraw(container, hass, epoch);
  }

  /** A rating mark's note shows on a tap or a key press, where its tooltip cannot be hovered. */
  private _bindRatingMarks(container: HTMLElement): void {
    for (const mark of container.querySelectorAll<HTMLElement>(".rating-user-set")) {
      mark.addEventListener("click", () => toggleRatingNote(mark));
    }
  }

  /**
   * A point's Reset clears its override. While the reset is on its way the button
   * is marked busy, not disabled, so it keeps focus, and a second click sends
   * nothing; where it fails, the row is left as it was, the button is usable
   * again, and the integration's reason is shown.
   */
  private _bindResetButtons(container: HTMLElement, hass: HomeAssistant): void {
    for (const btn of container.querySelectorAll<HTMLElement>(".reset-btn")) {
      btn.addEventListener("click", async () => {
        const entityId = btn.dataset.entity;
        if (!entityId || btn.getAttribute("aria-disabled") === "true") return;
        const epoch = this._epoch;
        const type = btn.dataset.type;
        const service = type === "mains" ? "clear_mains_threshold" : "clear_circuit_threshold";
        const param = this._serviceData(type === "mains" ? { leg: entityId } : { circuit_id: entityId });
        btn.setAttribute("aria-disabled", "true");
        btn.style.opacity = "0.6";
        try {
          await hass.callService(INTEGRATION_DOMAIN, service, param);
        } catch (err: unknown) {
          console.warn("SPAN Panel: threshold reset failed", err);
          btn.removeAttribute("aria-disabled");
          btn.style.opacity = "";
          const message = await serviceErrorMessage(hass, err, INTEGRATION_DOMAIN, t("error.threshold_failed"));
          this.errorStore?.add({ key: "service:monitoring", level: "error", message, persistent: false });
          return;
        }
        await this._redraw(container, hass, epoch);
      });
    }
  }
}
