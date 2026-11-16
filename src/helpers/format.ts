import { CHART_METRICS } from "../constants.js";
import { readNumber } from "./read-number.js";
import type { HassEntity } from "../types.js";

const powerMetric = CHART_METRICS.power!;
const currentMetric = CHART_METRICS.current!;

/** What a reading the panel has not published shows as: never 0. */
export const UNKNOWN_READING = "--";

const UNKNOWN_READING_HTML = `<strong>${UNKNOWN_READING}</strong>`;

export function formatPowerUnit(watts: number): string {
  return powerMetric.unit(watts);
}

export function formatPowerSigned(watts: number): string {
  const sign = watts < 0 ? "-" : "";
  return sign + powerMetric.format(watts);
}

/** A power value with its unit, as every tile header and total row draws one. */
export function formatPowerHTML(watts: number | null): string {
  if (watts === null) return UNKNOWN_READING_HTML;
  return `<strong>${formatPowerSigned(watts)}</strong> <span class="power-unit">${formatPowerUnit(watts)}</span>`;
}

/** A circuit's power with its unit, as its breaker slot and list row draw it. */
export function formatCircuitPowerHTML(watts: number | null): string {
  if (watts === null) return UNKNOWN_READING_HTML;
  return `<strong>${formatPowerSigned(watts)}</strong><span class="power-unit">${formatPowerUnit(watts)}</span>`;
}

/** A circuit's current with its unit, as its breaker slot and list row draw it. */
export function formatCircuitCurrentHTML(amps: number | null): string {
  if (amps === null) return UNKNOWN_READING_HTML;
  return `<strong>${currentMetric.format(amps)}</strong><span class="power-unit">A</span>`;
}

/** An energy reading, Wh shown as kWh, or the unknown mark when there is none. */
export function formatEnergyReading(state: HassEntity | undefined): string {
  const value = readNumber(state);
  if (value === null) return UNKNOWN_READING;
  const unit = state?.attributes.unit_of_measurement;
  if (unit === "Wh") return `${(value / 1000).toFixed(1)} kWh`;
  if (unit === "kWh") return `${value.toFixed(1)} kWh`;
  return typeof unit === "string" && unit ? `${value} ${unit}` : String(value);
}

export function formatKw(watts: number): string {
  return (Math.abs(watts) / 1000).toFixed(1);
}
