import { describe, it, expect } from "vitest";
import { getHistoryDurationMs, getHorizonDurationMs, getMaxHistoryPoints, getMinGapMs, recordSample, deduplicateAndTrim } from "../src/helpers/history.js";
import type { HistoryMap, HistoryPoint } from "../src/types.js";

describe("getHistoryDurationMs", () => {
  it("returns default 5 minutes when no config specified", () => {
    expect(getHistoryDurationMs({})).toBe(5 * 60 * 1000);
  });

  it("computes from days/hours/minutes", () => {
    expect(getHistoryDurationMs({ history_days: 1 })).toBe(24 * 60 * 60 * 1000);
    expect(getHistoryDurationMs({ history_hours: 2 })).toBe(2 * 60 * 60 * 1000);
    expect(getHistoryDurationMs({ history_minutes: 30 })).toBe(30 * 60 * 1000);
  });

  it("enforces minimum of 60 seconds", () => {
    expect(getHistoryDurationMs({ history_minutes: 0 })).toBe(60000);
  });

  it("combines days, hours, and minutes", () => {
    const expected = ((1 * 24 + 2) * 60 + 30) * 60 * 1000;
    expect(getHistoryDurationMs({ history_days: 1, history_hours: 2, history_minutes: 30 })).toBe(expected);
  });
});

describe("getHorizonDurationMs", () => {
  it("returns known horizon durations", () => {
    expect(getHorizonDurationMs("5m")).toBe(5 * 60 * 1000);
    expect(getHorizonDurationMs("1h")).toBe(60 * 60 * 1000);
    expect(getHorizonDurationMs("1d")).toBe(24 * 60 * 60 * 1000);
  });

  it("falls back to default for unknown horizons", () => {
    expect(getHorizonDurationMs("unknown")).toBe(5 * 60 * 1000);
  });
});

describe("getMaxHistoryPoints", () => {
  it("returns seconds for durations <= 10 minutes", () => {
    expect(getMaxHistoryPoints(5 * 60 * 1000)).toBe(300);
  });

  it("caps at 5000 for large durations", () => {
    expect(getMaxHistoryPoints(30 * 24 * 60 * 60 * 1000)).toBe(5000);
  });
});

describe("getMinGapMs", () => {
  it("returns minimum 500ms", () => {
    expect(getMinGapMs(1000)).toBe(500);
  });

  it("scales with duration", () => {
    expect(getMinGapMs(60 * 60 * 1000)).toBe(Math.floor(3600000 / 5000));
  });
});

describe("recordSample", () => {
  it("creates new entry if key does not exist", () => {
    const map: HistoryMap = new Map();
    recordSample(map, "test", 100, 1000, 0, 100);
    expect(map.get("test")).toHaveLength(1);
    expect(map.get("test")![0]).toEqual({ time: 1000, value: 100 });
  });

  it("prunes entries older than cutoff", () => {
    const map: HistoryMap = new Map();
    map.set("test", [
      { time: 100, value: 1 },
      { time: 200, value: 2 },
      { time: 300, value: 3 },
    ]);
    recordSample(map, "test", 4, 400, 250, 100);
    const result = map.get("test")!;
    expect(result.every(p => p.time >= 250)).toBe(true);
    expect(result[result.length - 1]!.value).toBe(4);
  });

  it("enforces maxPoints limit", () => {
    const map: HistoryMap = new Map();
    for (let i = 0; i < 10; i++) {
      recordSample(map, "test", i, i * 100, 0, 5);
    }
    expect(map.get("test")!.length).toBeLessThanOrEqual(5);
  });
});

describe("deduplicateAndTrim", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateAndTrim([], 100)).toEqual([]);
  });

  it("removes points closer than minGapMs", () => {
    const points: HistoryPoint[] = [
      { time: 100, value: 1 },
      { time: 200, value: 2 },
      { time: 300, value: 3 },
      { time: 1100, value: 4 },
    ];
    const result = deduplicateAndTrim(points, 100, 500);
    expect(result).toHaveLength(2);
    expect(result[0]!.time).toBe(100);
    expect(result[1]!.time).toBe(1100);
  });

  it("trims to maxPoints", () => {
    const points: HistoryPoint[] = Array.from({ length: 20 }, (_, i) => ({
      time: i * 1000,
      value: i,
    }));
    const result = deduplicateAndTrim(points, 5, 0);
    expect(result).toHaveLength(5);
  });

  it("sorts unsorted input", () => {
    const points: HistoryPoint[] = [
      { time: 300, value: 3 },
      { time: 100, value: 1 },
      { time: 200, value: 2 },
    ];
    const result = deduplicateAndTrim(points, 100, 0);
    expect(result[0]!.time).toBe(100);
    expect(result[2]!.time).toBe(300);
  });
});
