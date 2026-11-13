import { INTEGRATION_DOMAIN, INPUT_DEBOUNCE_MS } from "../constants.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { errorText, serviceErrorMessage } from "../helpers/error-text.js";
import { t, tf } from "../i18n.js";
import {
  copyWarning,
  isMonitored,
  judgedRatingA,
  monitoringRatingView,
  ratingLabelHTML,
  toggleRatingNote,
  type CopyWarning,
} from "../helpers/monitoring-rating.js";
import { focusedIn, isFocusLost } from "../helpers/focus.js";
import { bindLimitField, isLimitField, LIMIT_RANGES, type LimitField, type LimitFieldHandle } from "../helpers/number-field.js";
import { bindOtherBreakerField, reportPackageRatingsFailure, type OtherBreakerFieldHandle } from "../helpers/other-breaker-field.js";
import type { ErrorStore } from "../core/error-store.js";
import type { HomeAssistant, MonitoringPointInfo, MonitoringStatusResponse, CallServiceResponse, PackageRatingsForm, PackageRatingsState } from "../types.js";

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
/** A row's text button: its Reset, and the averaged-legs warning's Turn off monitoring. */
const ROW_BUTTON_STYLE = `
  background:none;border:1px solid var(--divider-color);color:var(--primary-text-color);
  border-radius:4px;padding:3px 6px;cursor:pointer;font-size:0.75em;
`;
/** A copy's ✕, a touch target of at least 24 by 24 px. */
const CLEAR_STYLE = `
  background:none;border:none;color:var(--secondary-text-color);
  min-width:24px;min-height:24px;padding:0 4px;cursor:pointer;font-size:0.85em;vertical-align:middle;
`;
const NOTE_STYLE = `
  margin:0 0 12px;padding:12px 16px;max-width:60em;box-sizing:border-box;
  border-left:3px solid var(--primary-color,#4dd9af);border-radius:4px;
  background:var(--secondary-background-color,#252530);
  font-size:0.85em;line-height:1.45;
`;
/**
 * A row's warning, under its cells. A table too wide for a phone scrolls across,
 * so the warning keeps to the left of the view, as wide as the screen, and wraps.
 */
const WARNING_STYLE = `
  display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;
  position:sticky;left:16px;max-width:min(48em, calc(100vw - 48px));box-sizing:border-box;
  padding:8px;border-left:3px solid var(--warning-color,#ffa600);border-radius:4px;
  background:color-mix(in srgb, var(--warning-color,#ffa600) 12%, transparent);
  font-size:0.8em;line-height:1.4;white-space:normal;
`;
/** The table's columns: the name, the rating, the four thresholds and durations, and the Reset. */
const TABLE_COLUMNS = 7;

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
const ROW_CONTROLS = ["reset-btn", "circuit-toggle", "mains-toggle", "rating-clear", "rating-turn-off"] as const;
type RowControl = (typeof ROW_CONTROLS)[number];

/** The field a circuit's other breaker is typed in, as a redraw names it beside the point's threshold fields. */
const OTHER_BREAKER = "other_breaker";

/** The controls a redraw can put focus back on. */
const KEPT_CONTROLS = ["[id]", ".threshold-input", ".rating-input", ...ROW_CONTROLS.map(name => `.${name}`)].join(", ");

/**
 * Where focus goes in a row once the control that had it is drawn no more, gone
 * with what it acted on, by the control's class.
 */
const FOCUS_AFTER: Partial<Record<RowControl, (entity: string) => string>> = {
  // A Reset goes with the override it cleared: focus goes to the row's first field.
  "reset-btn": entity => fieldKey(entity, "continuous_threshold_pct"),
  // A ✕ goes with the copy it removed: focus goes to the field the copy was in.
  "rating-clear": entity => fieldKey(entity, OTHER_BREAKER),
  // Turn off monitoring goes with its warning once monitoring is off: focus goes to the row's switch, which shows it off.
  "rating-turn-off": entity => rowControlKey("circuit-toggle", entity),
};

/**
 * A control's name across a redraw: its id; the point and field a threshold cell
 * or an other-breaker field is for; or a row control's class and its point.
 */
function controlKey(el: HTMLElement): string | null {
  if (el.id) return `#${el.id}`;
  const { entity, field } = el.dataset;
  if (entity === undefined) return null;
  if (el.classList.contains("threshold-input")) return field !== undefined ? fieldKey(entity, field) : null;
  if (el.classList.contains("rating-input")) return fieldKey(entity, OTHER_BREAKER);
  const control = rowControlOf(el);
  return control ? rowControlKey(control, entity) : null;
}

function fieldKey(entity: string, field: string): string {
  return `${entity}\u0000${field}`;
}

function rowControlKey(control: RowControl, entity: string): string {
  return `${control}\u0000${entity}`;
}

/** The row control `el` is, by its class; undefined for any other element. */
function rowControlOf(el: HTMLElement): RowControl | undefined {
  return ROW_CONTROLS.find(name => el.classList.contains(name));
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
  const entity = focused.dataset.entity;
  const control = rowControlOf(focused);
  const after = control !== undefined && entity !== undefined ? FOCUS_AFTER[control]?.(entity) : undefined;
  const keys = after !== undefined ? [key, after] : [key];
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

const PACKAGE_RATINGS_FORMS: readonly PackageRatingsForm[] = ["one_space", "two_spaces"];
const PACKAGE_RATINGS_STATES: readonly PackageRatingsState[] = ["applies", "pending", "averaged_legs"];

/** Whether `value` is one of `allowed`, or null, which the integration sends where the field does not apply. */
function isOneOfOrNull<T extends string>(value: unknown, allowed: readonly T[]): value is T | null {
  return value === null || allowed.some(item => item === value);
}

/**
 * A monitored point's entry with the package-ratings form and state narrowed to
 * their types: one outside its type is dropped, as an integration that predates
 * them sends neither. The entry's other fields are taken as sent.
 */
function coercePointInfo(entry: Record<string, unknown>): MonitoringPointInfo {
  const { package_ratings_form: form, package_ratings_state: state, ...rest } = entry;
  const out: MonitoringPointInfo = rest;
  if (isOneOfOrNull(form, PACKAGE_RATINGS_FORMS)) out.package_ratings_form = form;
  if (isOneOfOrNull(state, PACKAGE_RATINGS_STATES)) out.package_ratings_state = state;
  return out;
}

/** A map of monitored points, each entry narrowed (`coercePointInfo`) and one that is not an object dropped; undefined for no map. */
function coercePoints(points: unknown): Record<string, MonitoringPointInfo> | undefined {
  if (!points || typeof points !== "object") return undefined;
  const out: Record<string, MonitoringPointInfo> = {};
  for (const [id, entry] of Object.entries(points as Record<string, unknown>)) {
    if (entry && typeof entry === "object") out[id] = coercePointInfo(entry as Record<string, unknown>);
  }
  return out;
}

/**
 * Lightweight runtime-coerce for the ``get_monitoring_status`` response.
 * The backend returns JSON whose shape is nominally ``MonitoringStatusResponse``
 * but we can't trust the WebSocket payload, so we narrow what we can and
 * return ``null`` if the shape is unusable. Unknown fields at the root are
 * dropped, as are a point entry that is not an object and an entry's
 * package-ratings form or state outside its type.
 */
export function coerceMonitoringStatusResponse(resp: unknown): MonitoringStatusResponse | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const out: MonitoringStatusResponse = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.monitoring_rating_offered === "boolean") out.monitoring_rating_offered = r.monitoring_rating_offered;
  if (r.global_settings && typeof r.global_settings === "object") {
    out.global_settings = r.global_settings as MonitoringStatusResponse["global_settings"];
  }
  const circuits = coercePoints(r.circuits);
  if (circuits) out.circuits = circuits;
  const mains = coercePoints(r.mains);
  if (mains) out.mains = mains;
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

/**
 * A circuit row's copy of its package from the SPAN app, where the row takes
 * one: the circuit the package-ratings services name, the panel's own rating,
 * which is the package's first, and the package stored.
 */
interface RowCopy {
  readonly circuitId: string;
  readonly panelA: number;
  /** The package stored, in the SPAN app's order; null where none is. */
  readonly ratings: readonly number[] | null;
}

/**
 * The copy a circuit row holds, or null where it draws its rating as before.
 * Whether a circuit takes a copy, and in which form, is the integration's to say
 * (`package_ratings_form`), and only on a panel where it offers copies at all;
 * an integration that predates either says neither, and gets no field. A form is
 * named only where the panel rates the circuit, whose rating is the copy's
 * first, and only on an entry naming the circuit by its point: one lacking
 * either has nothing to send.
 */
function rowCopyOf(info: MonitoringPointInfo, offered: boolean): RowCopy | null {
  const { package_ratings_form: form, breaker_rating_a: panelA, point_id: circuitId } = info;
  if (!offered || !form || panelA == null || typeof circuitId !== "string") return null;
  return { circuitId, panelA, ratings: info.package_ratings_a ?? null };
}

/** The other breaker of a row's copy, the package's second rating; null where none is stored. */
function otherOf(copy: RowCopy): number | null {
  return copy.ratings?.[1] ?? null;
}

/**
 * A circuit's Rating cell where it takes a copy (spec §14.6): "20 A +" and the
 * other breaker's field, then "= 40 A" while the copy applies, and a ✕ while
 * one is stored. The field shows the copy, so no ✎ marks it. The field and the
 * ✕ are named by the circuit (`written`, as written; it is escaped here).
 */
function copyCell(eid: string, written: string, info: MonitoringPointInfo, copy: RowCopy): string {
  const judged = info.package_ratings_state === "applies" ? judgedRatingA(info) : null;
  const panel = tf("monitoringRating.panel_plus", { panel: String(copy.panelA) });
  const fieldName = tf("monitoringRating.other_breaker_label", { circuit: written });
  const equals = judged ? `<span>${escapeHtml(tf("monitoringRating.judged_equals", { rating: String(judged) }))}</span>` : "";
  const clear = copy.ratings
    ? `<button type="button" class="rating-clear" data-entity="${eid}"
         aria-label="${escapeHtml(tf("monitoringRating.clear_label", { circuit: written }))}" style="${CLEAR_STYLE}">✕</button>`
    : "";
  return `<td class="rating-cell" style="padding:6px 4px;white-space:nowrap;">
    <span>${escapeHtml(panel)}</span>
    <input type="number" class="rating-input" data-entity="${eid}" data-circuit="${escapeHtml(copy.circuitId)}"
           value="${escapeHtml(otherOf(copy) ?? "")}" min="1" step="1" inputmode="numeric" aria-label="${escapeHtml(fieldName)}"
           style="${CELL_INPUT_STYLE}">
    ${equals}
    ${clear}
  </td>`;
}

/** What a row's warning says (spec §14.6), naming the Reset and the global settings by the labels the tab shows. */
function warningText(warning: CopyWarning): string {
  if (warning === "averaged_legs") return t("monitoringRating.averaged_legs");
  if (warning === "own") return tf("monitoringRating.table_threshold_warning", { reset: t("monitoring.reset") });
  return tf("monitoringRating.table_threshold_warning_global", { settings: t("monitoring.global_settings") });
}

/**
 * The row under a circuit's cells for the warning its copy calls for
 * (`copyWarning`), which is only ever a monitored circuit's, so never dimmed.
 * The averaged-legs one carries a button that turns monitoring off for the
 * circuit, named by it as the row's fields are (`written`, as written; it is
 * escaped here).
 */
function warningRow(eid: string, written: string, warning: CopyWarning): string {
  const label = t("monitoringRating.turn_off_monitoring");
  const action =
    warning === "averaged_legs"
      ? `<button type="button" class="rating-turn-off" data-entity="${eid}"
           aria-label="${escapeHtml(tf("monitoring.point_field", { field: label, name: written }))}" style="${ROW_BUTTON_STYLE}">${escapeHtml(label)}</button>`
      : "";
  return `<tr class="rating-warning-row">
    <td colspan="${TABLE_COLUMNS}" style="padding:0 8px 8px;">
      <div class="rating-warning" role="note" data-kind="${warning}" style="${WARNING_STYLE}"><span>${escapeHtml(warningText(warning))}</span>${action}</div>
    </td>
  </tr>`;
}

/**
 * The note above the table on a panel that takes copies (spec §14.6): why a
 * MAIN 32's tandems raise false alerts, and how to copy their ratings from the
 * SPAN app into the table. It names the column and the Reset by the labels the
 * tab shows.
 */
function ratingNoteHTML(): string {
  const paragraph = (text: string): string => `<p style="margin:8px 0 0;">${escapeHtml(text)}</p>`;
  const steps = [
    t("monitoringRating.note_step_find"),
    tf("monitoringRating.note_step_enter", { column: t("monitoring.rating") }),
    t("monitoringRating.note_step_single"),
  ]
    .map(step => `<li>${escapeHtml(step)}</li>`)
    .join("");
  return `<div class="rating-note" role="note" style="${NOTE_STYLE}">
    <h4 style="margin:0;font-size:1em;">${escapeHtml(t("monitoringRating.note_title"))}</h4>
    ${paragraph(t("monitoringRating.note_problem"))}
    ${paragraph(t("monitoringRating.note_steps"))}
    <ol style="margin:4px 0 0;padding-left:1.5em;">${steps}</ol>
    ${paragraph(t("monitoringRating.note_judged"))}
    ${paragraph(tf("monitoringRating.note_thresholds", { reset: t("monitoring.reset") }))}
    ${paragraph(t("monitoringRating.note_two_spaces"))}
  </div>`;
}

/**
 * Make `button` carry out `act` on a click. While it is on its way the button
 * is marked busy, not disabled, so it keeps focus, and a second click sends
 * nothing; where it fails (`act` resolves false), the button is usable again.
 * One that succeeds stays busy until the redraw that follows replaces it.
 */
function bindBusyButton(button: HTMLElement, act: () => Promise<boolean>): void {
  button.addEventListener("click", async () => {
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    button.style.opacity = "0.6";
    if (await act()) return;
    button.removeAttribute("aria-disabled");
    button.style.opacity = "";
  });
}

/** The notify targets button's text: the targets chosen, the event bus by its name, or that none is. */
function targetsText(targets: readonly string[]): string {
  return targets.length
    ? targets.map(target => (target === "event_bus" ? t("notification.event_bus_target") : target)).join(", ")
    : t("notification.none_selected");
}

/** The notify targets button's accessible name: its label, then the targets it shows. */
function targetsName(text: string): string {
  return tf("notification.targets_button", { targets: text });
}

/** The longest a redraw waits on a press whose release never arrives. */
const PRESS_WAIT_MS = 3000;

/**
 * Watches pointer presses in a tab's container, so a redraw can wait for one to
 * end. Pressing a control takes focus from a field being typed in, which saves
 * it, and the tab is read again; drawn while the press is down, the control
 * pressed is replaced, and the click the release would make never lands.
 */
class PressWatch {
  private static readonly _watches = new WeakMap<HTMLElement, PressWatch>();
  private _pressed = false;
  private _waiting: Array<() => void> = [];

  /** The watch on `container`, started on first use. */
  static of(container: HTMLElement): PressWatch {
    let watch = PressWatch._watches.get(container);
    if (!watch) {
      watch = new PressWatch(container);
      PressWatch._watches.set(container, watch);
    }
    return watch;
  }

  private constructor(container: HTMLElement) {
    container.addEventListener("pointerdown", () => this._press(), true);
  }

  /** Resolves once no press is down, after the click its release makes has been handled. */
  settled(): Promise<void> {
    return this._pressed ? new Promise(resolve => this._waiting.push(resolve)) : Promise.resolve();
  }

  private _press(): void {
    this._pressed = true;
    const cap = setTimeout(() => release(), PRESS_WAIT_MS);
    const release = (): void => {
      clearTimeout(cap);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      // The click a release makes is dispatched with it: the redraw waits for it to be handled.
      setTimeout(() => this._release(), 0);
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  }

  private _release(): void {
    this._pressed = false;
    for (const go of this._waiting.splice(0)) go();
  }
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
    // A press under way lands on the control pressed before that control is drawn again.
    await PressWatch.of(container).settled();
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
    const allEnabled = allPoints.length > 0 && allPoints.every(([, c]) => isMonitored(c));
    const someEnabled = allPoints.some(([, c]) => isMonitored(c));

    // The copy each circuit row holds of its package from the SPAN app, by entity id, for the rows that take one.
    const offered = status?.monitoring_rating_offered === true;
    const copies = new Map<string, RowCopy>();
    for (const [entityId, info] of circuitEntries) {
      const copy = rowCopyOf(info, offered);
      if (copy) copies.set(entityId, copy);
    }

    const circuitRows = circuitEntries
      .map(([entityId, info]) => {
        const written = info.name ?? entityId;
        const name = escapeHtml(written);
        const enabled = isMonitored(info);
        const hasOverride = info.has_override === true;
        const dimStyle = enabled ? "" : "opacity:0.4;";
        const eid = escapeHtml(entityId);
        const copy = copies.get(entityId) ?? null;
        const warning = copy ? copyWarning(info, info) : null;
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
            ${copy ? copyCell(eid, written, info, copy) : ratingCell(info, false)}
            ${thresholdCell(eid, written, "continuous_threshold_pct", info.continuous_threshold_pct, "%", "circuit")}
            ${thresholdCell(eid, written, "spike_threshold_pct", info.spike_threshold_pct, "%", "circuit")}
            ${thresholdCell(eid, written, "window_duration_m", info.window_duration_m, "m", "circuit")}
            ${thresholdCell(eid, written, "cooldown_duration_m", info.cooldown_duration_m, "m", "circuit")}
            <td style="padding:6px 4px;">
              ${
                hasOverride
                  ? `<button class="reset-btn" data-entity="${eid}" data-type="circuit"
                       aria-label="${escapeHtml(tf("monitoring.reset_point", { name: written }))}"
                       style="${ROW_BUTTON_STYLE}">
                    ${t("monitoring.reset")}
                  </button>`
                  : ""
              }
            </td>
          </tr>
          ${warning ? warningRow(eid, written, warning) : ""}
        `;
      })
      .join("");

    const mainsRows = Object.entries(mains)
      .map(([entityId, info]) => {
        const written = info.name ?? entityId;
        const name = escapeHtml(written);
        const enabled = isMonitored(info);
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
                       style="${ROW_BUTTON_STYLE}">
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
                <button id="notify-target-btn" type="button" aria-label="${escapeHtml(targetsName(targetsText(selectedTargets)))}" style="
                  background:var(--secondary-background-color,#333);
                  border:1px solid var(--divider-color);
                  color:var(--primary-text-color);
                  border-radius:4px;padding:6px 10px;width:100%;font-size:0.85em;
                  text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;
                  ${allTargetsSelected ? "opacity:0.4;pointer-events:none;" : ""}">
                  <span id="notify-target-label">${escapeHtml(targetsText(selectedTargets))}</span>
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
        ${offered ? ratingNoteHTML() : ""}
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
    this._bindPackageRatings(container, hass, copies);
    this._bindTurnOffButtons(container, hass);
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

  /** Call the integration's `service` with `data` for the panel this tab shows (`_serviceData`). */
  private _callService(hass: HomeAssistant, service: string, data: Record<string, unknown>): Promise<unknown> {
    return hass.callWS({
      type: "call_service",
      domain: INTEGRATION_DOMAIN,
      service,
      service_data: this._serviceData({ ...data }),
    });
  }

  private _callSetGlobal(hass: HomeAssistant, data: Record<string, unknown>): Promise<unknown> {
    return this._callService(hass, "set_global_monitoring", data);
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
      const text = targetsText(targets);
      if (label) label.textContent = text;
      btn.setAttribute("aria-label", targetsName(text));
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

  /** A circuit's switch turns monitoring on or off for it (`_setCircuitMonitoring`), and goes back where that fails. */
  private _bindCircuitToggles(container: HTMLElement, hass: HomeAssistant): void {
    for (const cb of container.querySelectorAll<HTMLInputElement>(".circuit-toggle")) {
      const entityId = cb.dataset.entity;
      if (entityId === undefined) continue;
      cb.addEventListener("change", async () => {
        const enabled = cb.checked;
        if (!(await this._setCircuitMonitoring(container, hass, entityId, enabled))) cb.checked = !enabled;
      });
    }
  }

  /** The averaged-legs warning's button turns monitoring off for its circuit, as the row's switch does. */
  private _bindTurnOffButtons(container: HTMLElement, hass: HomeAssistant): void {
    for (const btn of container.querySelectorAll<HTMLElement>(".rating-turn-off")) {
      const entityId = btn.dataset.entity;
      if (entityId === undefined) continue;
      bindBusyButton(btn, () => this._setCircuitMonitoring(container, hass, entityId, false));
    }
  }

  /**
   * Turn monitoring on or off for circuit `entityId`, the one call the row's
   * switch and the averaged-legs warning's button both send, then read the tab
   * again. Resolves whether it was stored; a failure is said, and nothing redrawn.
   */
  private async _setCircuitMonitoring(container: HTMLElement, hass: HomeAssistant, entityId: string, enabled: boolean): Promise<boolean> {
    const epoch = this._epoch;
    try {
      await this._callService(hass, "set_circuit_threshold", { circuit_id: entityId, monitoring_enabled: enabled });
    } catch (err) {
      console.warn("SPAN Panel: circuit threshold toggle failed", err);
      this.errorStore?.add({
        key: "service:monitoring",
        level: "error",
        message: t("error.threshold_failed"),
        persistent: false,
      });
      return false;
    }
    await this._redraw(container, hass, epoch);
    return true;
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

  /**
   * Each circuit's other-breaker field stores the package as the side panel's
   * does, only as the user entered it (`bindOtherBreakerField`), saying beside
   * it what it needs correcting; its ✕ removes the copy, what the field held
   * going with it. Either reads the table again once stored: the integration
   * says what the copy does, which only its answer shows.
   */
  private _bindPackageRatings(container: HTMLElement, hass: HomeAssistant, copies: ReadonlyMap<string, RowCopy>): void {
    for (const input of container.querySelectorAll<HTMLInputElement>(".rating-input")) {
      const entityId = input.dataset.entity;
      const copy = entityId !== undefined ? copies.get(entityId) : undefined;
      if (!copy) continue;
      const field = bindOtherBreakerField(input, {
        report: fieldFeedback(input),
        stored: () => otherOf(copy),
        save: amps => void this._savePackageRatings(container, hass, input, field, copy, amps),
      });
      const clear = input.closest("td")?.querySelector<HTMLElement>(".rating-clear");
      if (!clear) continue;
      bindBusyButton(clear, () => {
        field.revert();
        return this._clearPackageRatings(container, hass, copy);
      });
    }
  }

  /**
   * Store `copy`'s package with `amps` as its other breaker, then read the tab
   * again. A refusal says why, and `field` shows the copy in force again unless
   * the user has typed or saved there since (`answerRefusal`); where focus was
   * lost meanwhile, it goes to the field, to correct it. Anywhere else, focus is
   * the user's.
   */
  private async _savePackageRatings(
    container: HTMLElement,
    hass: HomeAssistant,
    input: HTMLInputElement,
    field: OtherBreakerFieldHandle,
    copy: RowCopy,
    amps: number
  ): Promise<void> {
    const epoch = this._epoch;
    try {
      await this._callService(hass, "set_circuit_package_ratings", { circuit_id: copy.circuitId, package_ratings_a: [copy.panelA, amps] });
    } catch (err: unknown) {
      reportPackageRatingsFailure(hass, this.errorStore, err);
      if (field.answerRefusal(amps) && input.isConnected && isFocusLost()) input.focus();
      return;
    }
    await this._redraw(container, hass, epoch);
  }

  /** Remove `copy`, then read the tab again. Resolves whether it was removed; a refusal says why, and nothing is redrawn. */
  private async _clearPackageRatings(container: HTMLElement, hass: HomeAssistant, copy: RowCopy): Promise<boolean> {
    const epoch = this._epoch;
    try {
      await this._callService(hass, "clear_circuit_package_ratings", { circuit_id: copy.circuitId });
    } catch (err: unknown) {
      reportPackageRatingsFailure(hass, this.errorStore, err);
      return false;
    }
    await this._redraw(container, hass, epoch);
    return true;
  }

  /** A rating mark's note shows on a tap or a key press, where its tooltip cannot be hovered. */
  private _bindRatingMarks(container: HTMLElement): void {
    for (const mark of container.querySelectorAll<HTMLElement>(".rating-user-set")) {
      mark.addEventListener("click", () => toggleRatingNote(mark));
    }
  }

  /**
   * A point's Reset clears its override, busy while it is on its way
   * (`bindBusyButton`); where it fails, the row is left as it was, the button is
   * usable again, and the integration's reason is shown.
   */
  private _bindResetButtons(container: HTMLElement, hass: HomeAssistant): void {
    for (const btn of container.querySelectorAll<HTMLElement>(".reset-btn")) {
      const entityId = btn.dataset.entity;
      if (!entityId) continue;
      const isMains = btn.dataset.type === "mains";
      bindBusyButton(btn, async () => {
        const epoch = this._epoch;
        const service = isMains ? "clear_mains_threshold" : "clear_circuit_threshold";
        const param = this._serviceData(isMains ? { leg: entityId } : { circuit_id: entityId });
        try {
          await hass.callService(INTEGRATION_DOMAIN, service, param);
        } catch (err: unknown) {
          console.warn("SPAN Panel: threshold reset failed", err);
          void serviceErrorMessage(hass, err, INTEGRATION_DOMAIN, t("error.threshold_failed")).then(message => {
            this.errorStore?.add({ key: "service:monitoring", level: "error", message, persistent: false });
          });
          return false;
        }
        await this._redraw(container, hass, epoch);
        return true;
      });
    }
  }
}
