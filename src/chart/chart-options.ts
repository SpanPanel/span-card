import { CHART_METRICS, DEFAULT_CHART_METRIC, NEC_CONTINUOUS_LOAD_FACTOR, NEC_TRIP_RATING_FACTOR } from "../constants.js";
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
  breakerRatingA: number | undefined,
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

  if (breakerRatingA && metric.entityRole === "current") {
    yAxis.min = 0;
    yAxis.max = Math.ceil(breakerRatingA * NEC_TRIP_RATING_FACTOR);

    series.push({
      type: "line",
      data: [
        [startTime, breakerRatingA * NEC_CONTINUOUS_LOAD_FACTOR],
        [now, breakerRatingA * NEC_CONTINUOUS_LOAD_FACTOR],
      ],
      showSymbol: false,
      lineStyle: { width: 1, color: "rgba(255, 200, 40, 0.6)", type: "dashed" },
      itemStyle: { color: "transparent" },
      tooltip: { show: false },
    });

    series.push({
      type: "line",
      data: [
        [startTime, breakerRatingA],
        [now, breakerRatingA],
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
