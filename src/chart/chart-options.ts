import { CHART_METRICS, DEFAULT_CHART_METRIC, LIMIT_AXIS_HEADROOM } from "../constants.js";
import type { HistoryPoint, ChartMetricDef } from "../types.js";

type DataPair = [number, number];

interface SeriesDef {
  type: "line";
  data: DataPair[];
  showSymbol: boolean;
  smooth?: boolean;
  step?: "start" | "middle" | "end" | false;
  lineStyle: { width: number; color: string; type?: string };
  areaStyle?: {
    color: {
      type: "linear";
      x: number;
      y: number;
      x2: number;
      y2: number;
      colorStops: { offset: number; color: string }[];
    };
  };
  itemStyle: { color: string };
  tooltip?: { show: boolean };
}

interface YAxisDef {
  type: "value";
  splitNumber: number;
  axisLabel: {
    fontSize: number;
    formatter: (v: number) => string;
  };
  splitLine: { lineStyle: { opacity: number } };
  min?: number;
  max?: number;
}

interface ChartOptionsDef {
  xAxis: {
    type: "time";
    min: number;
    max: number;
    axisLabel: { fontSize: number };
    splitLine: { show: boolean };
  };
  yAxis: YAxisDef;
  grid: { top: number; right: number; bottom: number; left: number; containLabel: boolean };
  tooltip: {
    trigger: "axis";
    axisPointer: { type: "line"; lineStyle: { type: "dashed" } };
    formatter: (params: { value: [number, number] }[]) => string;
  };
  animation: boolean;
}

/**
 * What a current chart draws its limit lines against: the rating its point is judged against (a shared meter's
 * capacity for its group), and the thresholds, in percent of it, that the point warns (continuous) and alerts (spike) at.
 */
export interface ChartLimit {
  readonly ratingA: number;
  readonly continuousPct: number;
  readonly spikePct: number;
}

export interface BuildChartResult {
  options: ChartOptionsDef;
  series: SeriesDef[];
}

function safeMax(data: DataPair[]): number {
  let max = 0;
  for (const pair of data) {
    if (pair[1] > max) {
      max = pair[1];
    }
  }
  return max;
}

export function buildChartOptions(
  history: HistoryPoint[] | undefined,
  durationMs: number,
  metric: ChartMetricDef | undefined,
  isProducer: boolean,
  limit: ChartLimit | undefined,
  useLinearInterpolation = false
): BuildChartResult {
  if (!metric) metric = CHART_METRICS[DEFAULT_CHART_METRIC]!;
  const accentRgb = isProducer ? "140, 160, 220" : "77, 217, 175";
  const accentColor = `rgb(${accentRgb})`;
  const now = Date.now();
  const startTime = now - durationMs;

  const hasFixedRange = metric.fixedMin !== undefined && metric.fixedMax !== undefined;

  const data: DataPair[] = (history ?? []).filter(p => p.time >= startTime).map((p): DataPair => [p.time, Math.abs(p.value)]);

  const series: SeriesDef[] = [
    {
      type: "line",
      data,
      showSymbol: false,
      smooth: false,
      // Continuous signals (PV, SoC) suit linear interpolation; discrete readings use step
      ...(useLinearInterpolation ? {} : { step: "end" as const }),
      lineStyle: { width: 1.5, color: accentColor },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: `rgba(${accentRgb}, 0.18)` },
            { offset: 1, color: `rgba(${accentRgb}, 0.18)` },
          ],
        },
      },
      itemStyle: { color: accentColor },
    },
  ];

  const dataMax = data.length > 0 ? safeMax(data) : 0;
  const useDecimalAxis = dataMax < 10;

  const yAxis: YAxisDef = {
    type: "value",
    splitNumber: 4,
    axisLabel: {
      fontSize: 10,
      formatter: useDecimalAxis ? (v: number): string => (v === 0 ? "0" : v.toFixed(1)) : (v: number): string => metric.format(v),
    },
    splitLine: { lineStyle: { opacity: 0.15 } },
  };

  if (hasFixedRange) {
    yAxis.min = metric.fixedMin;
    yAxis.max = metric.fixedMax;
  } else if (dataMax < 1) {
    yAxis.min = 0;
    yAxis.max = 1;
  }

  if (limit && metric.entityRole === "current") {
    // The dashed line is where the point warns, the solid one where it alerts, each at its own threshold of the rating.
    const continuousA = (limit.ratingA * limit.continuousPct) / 100;
    const spikeA = (limit.ratingA * limit.spikePct) / 100;
    yAxis.min = 0;
    // Above the highest line and the highest reading, so neither runs off the top.
    yAxis.max = Math.ceil(Math.max(continuousA, spikeA, dataMax) * LIMIT_AXIS_HEADROOM);

    series.push({
      type: "line",
      data: [
        [startTime, continuousA],
        [now, continuousA],
      ],
      showSymbol: false,
      lineStyle: { width: 1, color: "rgba(255, 200, 40, 0.6)", type: "dashed" },
      itemStyle: { color: "transparent" },
      tooltip: { show: false },
    });

    series.push({
      type: "line",
      data: [
        [startTime, spikeA],
        [now, spikeA],
      ],
      showSymbol: false,
      lineStyle: { width: 1.5, color: "rgba(255, 60, 60, 0.7)", type: "solid" },
      itemStyle: { color: "transparent" },
      tooltip: { show: false },
    });
  }

  const options: ChartOptionsDef = {
    xAxis: {
      type: "time",
      min: startTime,
      max: now,
      axisLabel: { fontSize: 10 },
      splitLine: { show: false },
    },
    yAxis,
    grid: { top: 8, right: 4, bottom: 0, left: 0, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { type: "dashed" } },
      formatter: (params: { value: [number, number] }[]): string => {
        if (!params || params.length === 0) return "";
        const p = params[0]!;
        const date = new Date(p.value[0]);
        const timeStr = date.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const val = parseFloat(p.value[1].toFixed(2));
        return `<div style="font-size:12px">${timeStr}<br/><strong>${metric.format(val)} ${metric.unit(val)}</strong></div>`;
      },
    },
    animation: false,
  };

  return { options, series };
}
