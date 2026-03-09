import { buildChartOptions } from "./chart-options.js";

export function updateChart(container, hass, history, durationMs, metric, isProducer, heightPx) {
  const { options, series } = buildChartOptions(history, durationMs, metric, isProducer);
  let chart = container.querySelector("ha-chart-base");
  if (!chart) {
    chart = document.createElement("ha-chart-base");
    chart.style.display = "block";
    chart.style.width = "100%";
    chart.height = (heightPx || 120) + "px";
    container.innerHTML = "";
    container.appendChild(chart);
  }
  chart.hass = hass;
  chart.options = options;
  chart.data = series;
}
