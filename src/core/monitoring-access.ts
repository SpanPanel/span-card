import { INTEGRATION_DOMAIN } from "../constants.js";
import { isUnauthorized } from "../helpers/error-text.js";
import { t } from "../i18n.js";
import type { ErrorStore } from "./error-store.js";
import type { HomeAssistant } from "../types.js";

/**
 * Whether the user may change a panel's monitoring. The integration lets only a
 * Home Assistant administrator change it, refusing anyone else each of its
 * monitoring services that changes something, while reading it stays open to
 * all; a user the frontend does not say is an administrator is taken as not one.
 * Every view that changes monitoring asks this, and shows anyone else what
 * monitoring is set to, read-only (`lockMonitoringControls`).
 */
export function canEditMonitoring(hass: HomeAssistant | null | undefined): boolean {
  return hass?.user?.is_admin === true;
}

/** Why a read-only view of monitoring changes nothing: its note, each locked control's title, and a refusal's message. */
function adminOnlyText(): string {
  return t("monitoring.admin_only");
}

/**
 * A monitoring change refused for want of administrator rights: by the card,
 * which sends nothing for a user who may not make it, or by the integration,
 * which answers Unauthorized, as for a user whose rights changed after the view
 * was drawn. Its message says so in the user's language, so each view's own
 * report of a failed change shows it.
 */
export class MonitoringChangeRefused extends Error {
  constructor() {
    super(adminOnlyText());
    this.name = "MonitoringChangeRefused";
  }
}

/** A monitoring service's data: what the change sets, and the config entry of the panel it is for where one is named. */
export type MonitoringServiceData = Record<string, unknown>;

/**
 * The integration's monitoring services that change something, one method
 * each. Every monitoring change the card makes is sent through one of them
 * (`monitoringWrites`), so none is sent for a user who may not make it. Each
 * resolves once the integration has stored the change, and rejects with its
 * refusal, one for want of administrator rights as a `MonitoringChangeRefused`.
 */
export interface MonitoringWrites {
  setGlobalMonitoring(data: MonitoringServiceData): Promise<void>;
  testNotification(data: MonitoringServiceData): Promise<void>;
  setCircuitThreshold(data: MonitoringServiceData): Promise<void>;
  clearCircuitThreshold(data: MonitoringServiceData): Promise<void>;
  setMainsThreshold(data: MonitoringServiceData): Promise<void>;
  clearMainsThreshold(data: MonitoringServiceData): Promise<void>;
  setCircuitPackageRatings(data: MonitoringServiceData): Promise<void>;
  clearCircuitPackageRatings(data: MonitoringServiceData): Promise<void>;
}

/**
 * The monitoring changes `hass`'s user can send. Each is refused, with nothing
 * sent, where the user may not change monitoring (`canEditMonitoring`), as
 * where there is no Home Assistant yet to send it to, and is otherwise sent
 * within the call, as calling the service directly sends it.
 */
export function monitoringWrites(hass: HomeAssistant | null): MonitoringWrites {
  const change =
    (service: string) =>
    (data: MonitoringServiceData): Promise<void> =>
      sendChange(hass, service, data);
  return {
    setGlobalMonitoring: change("set_global_monitoring"),
    testNotification: change("test_notification"),
    setCircuitThreshold: change("set_circuit_threshold"),
    clearCircuitThreshold: change("clear_circuit_threshold"),
    setMainsThreshold: change("set_mains_threshold"),
    clearMainsThreshold: change("clear_mains_threshold"),
    setCircuitPackageRatings: change("set_circuit_package_ratings"),
    clearCircuitPackageRatings: change("clear_circuit_package_ratings"),
  };
}

/** Send the integration's `service` with `data` where the user may change monitoring; an Unauthorized answer is a `MonitoringChangeRefused`. */
async function sendChange(hass: HomeAssistant | null, service: string, data: MonitoringServiceData): Promise<void> {
  if (!hass || !canEditMonitoring(hass)) throw new MonitoringChangeRefused();
  try {
    await hass.callWS({ type: "call_service", domain: INTEGRATION_DOMAIN, service, service_data: data });
  } catch (err: unknown) {
    throw isUnauthorized(err) ? new MonitoringChangeRefused() : err;
  }
}

/**
 * What to say of a monitoring change that failed: that only an administrator
 * can make it, where it was refused for that (`MonitoringChangeRefused`); else `fallback`.
 */
export function monitoringFailureText(err: unknown, fallback: string): string {
  return err instanceof MonitoringChangeRefused ? err.message : fallback;
}

/**
 * Show in `errors` that a monitoring change failed, as a view reports one it has
 * no place of its own to report: that the change could not be saved, or that
 * only an administrator can make it (`monitoringFailureText`). `change` names it
 * in the console's warning.
 */
export function reportMonitoringFailure(errors: ErrorStore | null, err: unknown, change: string): void {
  console.warn(`SPAN Panel: ${change} failed`, err);
  errors?.add({ key: "service:monitoring", level: "error", message: monitoringFailureText(err, t("error.threshold_failed")), persistent: false });
}

/** Every control a view draws: its fields, choices and buttons, and the card's switches. */
const CONTROLS = "input, select, textarea, button, span-switch";

/** The input types whose value is read as text: locked, one is made read-only, so what it holds can still be read and selected. */
const READABLE_INPUTS: ReadonlySet<string> = new Set(["number", "text"]);

/** The opacity a locked native control is drawn at, the one the side panel draws a disabled field at. */
const LOCKED_OPACITY = "0.5";

/**
 * Whether `control`, or what holds it, is drawn dimmed already, as a point's
 * controls are while its monitoring is off, or the global fields while
 * monitoring is: dimmed again, it would fade to near nothing.
 */
function drawnDimmed(control: HTMLElement): boolean {
  for (let el: HTMLElement | null = control; el; el = el.parentElement) {
    if (el.style.opacity !== "" && Number(el.style.opacity) < 1) return true;
  }
  return false;
}

/**
 * Lock every control in `root` that changes monitoring, for a user who may not
 * change it (`canEditMonitoring`), so the view shows what monitoring is set to
 * and changes nothing. A field holding text or a number is made read-only, so
 * what it holds can still be read, selected and scrolled through; any other
 * control is disabled. Each is titled with why. A native control is dimmed
 * once, where nothing already dims it (`drawnDimmed`), with the cursor saying
 * it is not to be used; a switch dims itself. A control `except` matches, one
 * that changes nothing, such as a rating mark showing its note, is left as it
 * is. Locking a control again changes nothing, so a view can lock again what it
 * has redrawn.
 */
export function lockMonitoringControls(root: ParentNode, except?: string): void {
  const title = adminOnlyText();
  for (const control of root.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (except !== undefined && control.matches(except)) continue;
    if ((control instanceof HTMLInputElement && READABLE_INPUTS.has(control.type)) || control instanceof HTMLTextAreaElement) control.readOnly = true;
    else control.setAttribute("disabled", "");
    control.title = title;
    if (control.localName === "span-switch") continue;
    if (!drawnDimmed(control)) control.style.opacity = LOCKED_OPACITY;
    control.style.cursor = "not-allowed";
  }
}

/** The note a read-only view of monitoring shows above what it locks, saying why nothing there can be changed. */
export function readOnlyNote(): HTMLParagraphElement {
  const note = document.createElement("p");
  note.dataset.role = "monitoring-read-only";
  note.setAttribute("role", "note");
  note.style.cssText = "margin:8px 0 12px;font-size:0.85em;color:var(--secondary-text-color);";
  note.textContent = adminOnlyText();
  return note;
}
