import type { DualTabLayout } from "../types.js";

/**
 * Whether a size or position the topology reports can be laid out. A panel that
 * does not know its size reports 0, and anything that is not a whole number above
 * zero is no size at all.
 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function tabToRow(tab: number): number {
  return Math.ceil(tab / 2);
}

export function tabToCol(tab: number): number {
  return tab % 2 === 0 ? 1 : 0;
}

export function classifyDualTab(tabs: number[]): DualTabLayout {
  if (tabs.length !== 2) return null;
  const [a, b] = [Math.min(...tabs), Math.max(...tabs)];
  if (tabToRow(a) === tabToRow(b)) return "row-span";
  if (tabToCol(a) === tabToCol(b)) return "col-span";
  return "row-span";
}
