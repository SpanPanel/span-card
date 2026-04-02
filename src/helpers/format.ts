import { CHART_METRICS } from "../constants.js";

const powerMetric = CHART_METRICS.power!;

export function formatPowerUnit(watts: number): string {
  return powerMetric.unit(watts);
}

export function formatPowerSigned(watts: number): string {
  const sign = watts < 0 ? "-" : "";
  return sign + powerMetric.format(watts);
}

export function formatKw(watts: number): string {
  return (Math.abs(watts) / 1000).toFixed(1);
}
