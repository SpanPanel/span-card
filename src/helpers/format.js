import { CHART_METRICS } from "../constants.js";

const powerMetric = CHART_METRICS.power;

export function formatPower(watts) {
  return powerMetric.format(watts);
}

export function formatPowerUnit(watts) {
  return powerMetric.unit(watts);
}

export function formatPowerSigned(watts) {
  const sign = watts < 0 ? "-" : "";
  return sign + powerMetric.format(watts);
}

export function formatKw(watts) {
  return (Math.abs(watts) / 1000).toFixed(1);
}
