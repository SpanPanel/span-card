import { INTEGRATION_DOMAIN } from "../constants.js";
import { t } from "../i18n.js";
import type { ErrorStore } from "./error-store.js";
import type { HomeAssistant } from "../types.js";

/**
 * Whether the user may change a panel's monitoring. The integration lets only a
 * Home Assistant administrator change it, refusing anyone else each of its
 * monitoring services that changes something, while reading it stays open to
 * all; a user the frontend does not say is an administrator is taken as not one.
 */
export function canEditMonitoring(hass: HomeAssistant | null | undefined): boolean {
  return hass?.user?.is_admin === true;
}

/** That only an administrator can change monitoring, as a refusal's message says it. */
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

/**
 * Whether Home Assistant refused a service call as Unauthorized. Raised by the
 * service, it reaches the frontend as a `home_assistant_error` whose message is
 * the exception's name; raised by the websocket command, it has a code of its own.
 */
function isUnauthorized(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? err.code : undefined;
  return code === "unauthorized" || (code === "home_assistant_error" && "message" in err && err.message === "Unauthorized");
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
 * sent, where the user may not change monitoring (`canEditMonitoring`), and is
 * otherwise sent within the call, as calling the service directly sends it.
 */
export function monitoringWrites(hass: HomeAssistant): MonitoringWrites {
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
async function sendChange(hass: HomeAssistant, service: string, data: MonitoringServiceData): Promise<void> {
  if (!canEditMonitoring(hass)) throw new MonitoringChangeRefused();
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
