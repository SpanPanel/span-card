import type { HassEntity } from "../types.js";

/**
 * A reading, or null when the entity has none. `unknown` and `unavailable` are not
 * zero: rendering them as 0 W, or adding them to a sum as 0, states a measurement
 * nobody took.
 */
export function readNumber(state: HassEntity | null | undefined): number | null {
  if (!state) return null;
  const value = Number.parseFloat(state.state);
  return Number.isFinite(value) ? value : null;
}

/** A sum of readings: the measured terms' total, and whether an unknown term was left out of it. */
export interface ReadingSum {
  /** Null when no term was measured: a sum of nothing measured is unknown, not 0. */
  total: number | null;
  partial: boolean;
}

/** Add the measured terms and skip the unknown ones, saying when one was skipped. */
export function sumReadings(values: Iterable<number | null>): ReadingSum {
  let total: number | null = null;
  let skipped = false;
  for (const value of values) {
    if (value === null) skipped = true;
    else total = total === null ? value : total + value;
  }
  return { total, partial: skipped && total !== null };
}
