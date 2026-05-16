import { buildChartOptions } from "./chart-options.js";
import "./span-chart.js";
import type { SpanChart } from "./span-chart.js";
import type { HomeAssistant, HistoryPoint, ChartMetricDef } from "../types.js";

/**
 * Render or update the live chart for a circuit slot. Reuses the
 * existing <span-chart> element in the container if present so each
 * tick only re-flows the chart's data, not the DOM around it.
 *
 * The hass argument is kept on the call site for parity with the prior
 * <ha-chart-base> shape but no longer flows into the chart — span-chart
 * owns its rendering directly via ECharts. Theme/colour parity is
 * handled by the chart-options builder reading CSS custom properties.
 */
export function updateChart(
  container: HTMLElement,
  _hass: HomeAssistant,
  history: HistoryPoint[] | undefined,
  durationMs: number,
  metric: ChartMetricDef | undefined,
  isProducer: boolean,
  heightPx: number | undefined,
  breakerRatingA?: number,
  useLinearInterpolation?: boolean
): void {
  const { options, series } = buildChartOptions(history, durationMs, metric, isProducer, breakerRatingA, useLinearInterpolation);
  const minH = heightPx ?? 120;
  container.style.minHeight = minH + "px";

  let chart = container.querySelector("span-chart") as SpanChart | null;
  if (!chart) {
    chart = document.createElement("span-chart") as SpanChart;
    chart.style.display = "block";
    chart.style.width = "100%";
    container.innerHTML = "";
    container.appendChild(chart);
  }
  const actualH = container.clientHeight;
  chart.height = (actualH > 0 ? actualH : minH) + "px";
  chart.options = options;
  chart.data = series;
}
