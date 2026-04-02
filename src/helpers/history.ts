import {
  DEFAULT_HISTORY_DAYS,
  DEFAULT_HISTORY_HOURS,
  DEFAULT_HISTORY_MINUTES,
  GRAPH_HORIZONS,
  DEFAULT_GRAPH_HORIZON,
  MIN_HISTORY_DURATION_MS,
} from "../constants.js";
import type { CardConfig, HistoryPoint, HistoryMap } from "../types.js";

export function getHistoryDurationMs(config: CardConfig): number {
  const hasAny = config.history_days !== undefined || config.history_hours !== undefined || config.history_minutes !== undefined;
  const d = hasAny ? parseInt(String(config.history_days)) || 0 : DEFAULT_HISTORY_DAYS;
  const h = hasAny ? parseInt(String(config.history_hours)) || 0 : DEFAULT_HISTORY_HOURS;
  const m = hasAny ? parseInt(String(config.history_minutes)) || 0 : DEFAULT_HISTORY_MINUTES;
  const total = ((d * 24 + h) * 60 + m) * 60 * 1000;
  return Math.max(total, MIN_HISTORY_DURATION_MS);
}

export function getHorizonDurationMs(horizonKey: string): number {
  const h = GRAPH_HORIZONS[horizonKey];
  return h ? h.ms : GRAPH_HORIZONS[DEFAULT_GRAPH_HORIZON]!.ms;
}

export function getMaxHistoryPoints(durationMs: number): number {
  const seconds = durationMs / 1000;
  if (seconds <= 600) return Math.ceil(seconds);
  return Math.min(5000, Math.ceil(seconds / 5));
}

export function getMinGapMs(durationMs: number): number {
  return Math.max(500, Math.floor(durationMs / 5000));
}

// Record a single sample into a history map, pruning old entries.
// Uses findIndex + splice instead of a shift() loop to prune in a single pass.
export function recordSample(historyMap: HistoryMap, key: string, value: number, now: number, cutoff: number, maxPoints: number): void {
  if (!historyMap.has(key)) historyMap.set(key, []);
  const hist = historyMap.get(key)!;
  hist.push({ time: now, value });

  // Prune entries older than cutoff
  const firstValid = hist.findIndex(p => p.time >= cutoff);
  if (firstValid > 0) {
    hist.splice(0, firstValid);
  } else if (firstValid === -1) {
    hist.length = 0;
  }

  if (hist.length > maxPoints) hist.splice(0, hist.length - maxPoints);
}

// Merge, deduplicate (by minGapMs), and trim a list of history points.
export function deduplicateAndTrim(points: HistoryPoint[], maxPoints: number, minGapMs: number = 500): HistoryPoint[] {
  if (points.length === 0) return points;
  points.sort((a, b) => a.time - b.time);
  const deduped: HistoryPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.time - deduped[deduped.length - 1]!.time >= minGapMs) {
      deduped.push(points[i]!);
    }
  }
  if (deduped.length > maxPoints) deduped.splice(0, deduped.length - maxPoints);
  return deduped;
}
