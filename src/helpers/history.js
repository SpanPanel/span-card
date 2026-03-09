import { DEFAULT_HISTORY_DAYS, DEFAULT_HISTORY_HOURS, DEFAULT_HISTORY_MINUTES } from "../constants.js";

export function getHistoryDurationMs(config) {
  const d = parseInt(config.history_days) || DEFAULT_HISTORY_DAYS;
  const h = parseInt(config.history_hours) || DEFAULT_HISTORY_HOURS;
  const hasExplicit = config.history_days !== undefined || config.history_hours !== undefined;
  const m = parseInt(config.history_minutes) || (hasExplicit && config.history_minutes === undefined ? 0 : DEFAULT_HISTORY_MINUTES);
  const total = ((d * 24 + h) * 60 + m) * 60 * 1000;
  return Math.max(total, 60000);
}

export function getMaxHistoryPoints(durationMs) {
  const seconds = durationMs / 1000;
  if (seconds <= 600) return Math.ceil(seconds);
  return Math.min(1200, Math.ceil(seconds / 5));
}

// Record a single sample into a history map, pruning old entries.
export function recordSample(historyMap, key, value, now, cutoff, maxPoints) {
  if (!historyMap.has(key)) historyMap.set(key, []);
  const hist = historyMap.get(key);
  hist.push({ time: now, value });
  while (hist.length > 0 && hist[0].time < cutoff) hist.shift();
  if (hist.length > maxPoints) hist.splice(0, hist.length - maxPoints);
}

// Merge, deduplicate (by minGapMs), and trim a list of history points.
export function deduplicateAndTrim(points, maxPoints, minGapMs = 500) {
  if (points.length === 0) return points;
  points.sort((a, b) => a.time - b.time);
  const deduped = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].time - deduped[deduped.length - 1].time >= minGapMs) {
      deduped.push(points[i]);
    }
  }
  if (deduped.length > maxPoints) deduped.splice(0, deduped.length - maxPoints);
  return deduped;
}
