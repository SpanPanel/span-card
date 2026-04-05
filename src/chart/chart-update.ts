import { buildChartOptions } from "./chart-options.js";
import type { HomeAssistant, HistoryPoint, ChartMetricDef } from "../types.js";

interface HaChartBaseElement extends HTMLElement {
  hass: HomeAssistant;
  options: unknown;
  data: unknown;
  height: string;
}

export function updateChart(
  container: HTMLElement,
  hass: HomeAssistant,
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

  let chart = container.querySelector("ha-chart-base") as HaChartBaseElement | null;
  if (!chart) {
    chart = document.createElement("ha-chart-base") as HaChartBaseElement;
    chart.style.display = "block";
    chart.style.width = "100%";
    container.innerHTML = "";
    container.appendChild(chart);
  }
  const actualH = container.clientHeight;
  chart.height = (actualH > 0 ? actualH : minH) + "px";
  chart.hass = hass;
  chart.options = options;
  chart.data = series;
}
