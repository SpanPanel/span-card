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
  breakerRatingA?: number
): void {
  const { options, series } = buildChartOptions(history, durationMs, metric, isProducer, breakerRatingA);
  let chart = container.querySelector("ha-chart-base") as HaChartBaseElement | null;
  if (!chart) {
    chart = document.createElement("ha-chart-base") as HaChartBaseElement;
    chart.style.display = "block";
    chart.style.width = "100%";
    chart.height = (heightPx ?? 120) + "px";
    container.innerHTML = "";
    container.appendChild(chart);
  }
  chart.hass = hass;
  chart.options = options;
  chart.data = series;
}
