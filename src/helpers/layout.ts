import type { DualTabLayout, PanelTopology } from "../types.js";

/**
 * Whether a size or position the topology reports can be laid out. A panel that
 * does not know its size reports 0, and anything that is not a whole number above
 * zero is no size at all.
 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The first and last breaker positions the grid draws, inclusive. */
export interface PositionRange {
  readonly first: number;
  readonly last: number;
}

/**
 * The breaker positions the grid draws: the range the panel reports, else 1 to
 * `panelSize`, widened to every tab a circuit occupies so that no circuit is
 * dropped. Null when nothing places a breaker.
 */
export function positionRange(topology: PanelTopology | null, panelSize: number): PositionRange | null {
  if (!topology) return null;
  let first: number | null = null;
  let last: number | null = null;
  const { first_position: reportedFirst, last_position: reportedLast } = topology;
  if (isPositiveInteger(reportedFirst) && isPositiveInteger(reportedLast) && reportedFirst <= reportedLast) {
    first = reportedFirst;
    last = reportedLast;
  } else if (isPositiveInteger(panelSize)) {
    first = 1;
    last = panelSize;
  }
  for (const circuit of Object.values(topology.circuits)) {
    for (const tab of circuit?.tabs ?? []) {
      if (!isPositiveInteger(tab)) continue;
      first = first === null ? tab : Math.min(first, tab);
      last = last === null ? tab : Math.max(last, tab);
    }
  }
  return first === null || last === null ? null : { first, last };
}

/** The grid rows a range spans: two positions to a row, odd on the left. */
export function positionRowCount(positions: PositionRange): number {
  return tabToRow(positions.last) - tabToRow(positions.first) + 1;
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
