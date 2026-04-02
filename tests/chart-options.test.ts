import { describe, it, expect } from "vitest";
import { buildChartOptions } from "../src/chart/chart-options.js";
import { CHART_METRICS, BESS_CHART_METRICS } from "../src/constants.js";
import type { HistoryPoint, ChartMetricDef } from "../src/types.js";

const powerMetric = CHART_METRICS["power"]!;
const currentMetric = CHART_METRICS["current"]!;
const socMetric = BESS_CHART_METRICS["soc"]!;

describe("buildChartOptions", () => {
  it("returns valid options with empty history", () => {
    const result = buildChartOptions([], 300_000, powerMetric, false, undefined);
    expect(result.options).toBeDefined();
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.data).toEqual([]);
  });

  it("returns valid options when history is undefined", () => {
    const result = buildChartOptions(undefined, 300_000, powerMetric, false, undefined);
    expect(result.series[0]!.data).toEqual([]);
  });

  it("returns correct time axis range", () => {
    const durationMs = 300_000;
    const before = Date.now();
    const result = buildChartOptions([], durationMs, powerMetric, false, undefined);
    const after = Date.now();

    expect(result.options.xAxis.type).toBe("time");
    expect(result.options.xAxis.max).toBeGreaterThanOrEqual(before);
    expect(result.options.xAxis.max).toBeLessThanOrEqual(after);
    expect(result.options.xAxis.min).toBeGreaterThanOrEqual(before - durationMs);
    expect(result.options.xAxis.min).toBeLessThanOrEqual(after - durationMs);
  });

  it("adds NEC limit lines when breakerRatingA is set and metric is current", () => {
    const result = buildChartOptions([], 300_000, currentMetric, false, 20);
    // Main data series + continuous load line + trip rating line
    expect(result.series).toHaveLength(3);
    // Continuous load line (80% of 20A = 16A)
    expect(result.series[1]!.data[0]![1]).toBe(16);
    // Trip rating line (breaker rating = 20A)
    expect(result.series[2]!.data[0]![1]).toBe(20);
    // Y-axis max should be ceil(20 * 1.25) = 25
    expect(result.options.yAxis.max).toBe(25);
    expect(result.options.yAxis.min).toBe(0);
  });

  it("does not add NEC lines for power metric", () => {
    const result = buildChartOptions([], 300_000, powerMetric, false, 20);
    expect(result.series).toHaveLength(1);
  });

  it("uses producer accent color when isProducer is true", () => {
    const producerResult = buildChartOptions([], 300_000, powerMetric, true, undefined);
    const consumerResult = buildChartOptions([], 300_000, powerMetric, false, undefined);

    const producerColor = producerResult.series[0]!.lineStyle.color;
    const consumerColor = consumerResult.series[0]!.lineStyle.color;

    expect(producerColor).toBe("rgb(140, 160, 220)");
    expect(consumerColor).toBe("rgb(77, 217, 175)");
    expect(producerColor).not.toBe(consumerColor);
  });

  it("uses fixedMin/fixedMax when metric has them (SoC 0-100)", () => {
    const result = buildChartOptions([], 300_000, socMetric, false, undefined);
    expect(result.options.yAxis.min).toBe(0);
    expect(result.options.yAxis.max).toBe(100);
  });

  it("defaults to power metric when metric is undefined", () => {
    const result = buildChartOptions([], 300_000, undefined, false, undefined);
    expect(result.options).toBeDefined();
    expect(result.series).toHaveLength(1);
  });

  it("filters history points outside the duration window", () => {
    const now = Date.now();
    const history: HistoryPoint[] = [
      { time: now - 600_000, value: 100 }, // outside 5m window
      { time: now - 60_000, value: 200 }, // inside window
    ];
    const result = buildChartOptions(history, 300_000, powerMetric, false, undefined);
    expect(result.series[0]!.data).toHaveLength(1);
    expect(result.series[0]!.data[0]![1]).toBe(200);
  });

  it("uses absolute values for data points", () => {
    const now = Date.now();
    const history: HistoryPoint[] = [{ time: now - 1000, value: -500 }];
    const result = buildChartOptions(history, 300_000, powerMetric, false, undefined);
    expect(result.series[0]!.data[0]![1]).toBe(500);
  });
});
