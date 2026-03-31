import { CHART_METRICS, DEFAULT_CHART_METRIC } from "../constants.js";

export function buildChartOptions(history, durationMs, metric, isProducer, breakerRatingA) {
  if (!metric) metric = CHART_METRICS[DEFAULT_CHART_METRIC];
  const accentRgb = isProducer ? "140, 160, 220" : "77, 217, 175";
  const accentColor = `rgb(${accentRgb})`;
  const now = Date.now();
  const startTime = now - durationMs;

  const hasFixedRange = metric.fixedMin !== undefined && metric.fixedMax !== undefined;
  const unit = metric.unit(0);

  const data = (history || []).filter(p => p.time >= startTime).map(p => [p.time, Math.abs(p.value)]);

  const series = [
    {
      type: "line",
      data,
      showSymbol: false,
      smooth: false,
      lineStyle: { width: 1.5, color: accentColor },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: `rgba(${accentRgb}, 0.35)` },
            { offset: 1, color: `rgba(${accentRgb}, 0.02)` },
          ],
        },
      },
      itemStyle: { color: accentColor },
    },
  ];

  // Determine the max data value to ensure a meaningful Y-axis range
  const dataMax = data.length > 0 ? Math.max(...data.map(d => d[1])) : 0;

  const yAxis = {
    type: "value",
    splitNumber: 4,
    axisLabel: { fontSize: 10, formatter: v => metric.format(v) },
    splitLine: { lineStyle: { opacity: 0.15 } },
  };
  if (hasFixedRange) {
    yAxis.min = metric.fixedMin;
    yAxis.max = metric.fixedMax;
  } else if (dataMax < 1) {
    // Prevent all-zero Y-axis labels when values are very small
    yAxis.min = 0;
    yAxis.max = 1;
  }

  // When displaying current with a known breaker rating, fix Y-axis to 125%
  // of the rating and draw a red limit line at 100% (NEC reference).
  if (breakerRatingA && metric.entityRole === "current") {
    yAxis.min = 0;
    yAxis.max = Math.ceil(breakerRatingA * 1.25);

    // 80% NEC continuous load limit (yellow dashed)
    series.push({
      type: "line",
      data: [
        [startTime, breakerRatingA * 0.8],
        [now, breakerRatingA * 0.8],
      ],
      showSymbol: false,
      lineStyle: { width: 1, color: "rgba(255, 200, 40, 0.6)", type: "dashed" },
      itemStyle: { color: "transparent" },
      tooltip: { show: false },
    });
    // 100% breaker rating (red solid)
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

  const options = {
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
      formatter: params => {
        if (!params || !params.length) return "";
        const p = params[0];
        const date = new Date(p.value[0]);
        const timeStr = date.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const val = parseFloat(p.value[1].toFixed(2));
        return `<div style="font-size:12px">${timeStr}<br/><strong>${val} ${unit}</strong></div>`;
      },
    },
    animation: false,
  };

  return { options, series };
}
