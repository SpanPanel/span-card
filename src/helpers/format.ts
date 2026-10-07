import { CHART_METRICS } from "../constants.js";

const powerMetric = CHART_METRICS.power!;

export function formatPowerUnit(watts: number): string {
  return powerMetric.unit(watts);
}

export function formatPowerSigned(watts: number): string {
  const sign = watts < 0 ? "-" : "";
  return sign + powerMetric.format(watts);
}

/** A power value with its unit, as every tile header and total row draws one. */
export function formatPowerHTML(watts: number): string {
  return `<strong>${formatPowerSigned(watts)}</strong> <span class="power-unit">${formatPowerUnit(watts)}</span>`;
}

export function formatKw(watts: number): string {
  return (Math.abs(watts) / 1000).toFixed(1);
}
