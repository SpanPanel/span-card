import { isAlertActive } from "./monitoring-status.js";
import type { Circuit, MonitoringPointInfo } from "../types.js";

/**
 * Build the set of state-visualization classes that apply to a circuit's
 * rendered slot. Shared by the breaker grid and the list view's
 * chart-only expanded slot so both render the same border/background
 * signaling.
 */
export function getCircuitStateClasses(_circuit: Circuit, monitoringInfo: MonitoringPointInfo | null, isOn: boolean, isProducer: boolean): string {
  const classes: string[] = [];
  if (!isOn) classes.push("circuit-off");
  if (isProducer) classes.push("circuit-producer");
  if (isAlertActive(monitoringInfo)) classes.push("circuit-alert");
  return classes.join(" ");
}
