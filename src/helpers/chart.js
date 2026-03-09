import { CHART_METRICS, DEFAULT_CHART_METRIC } from "../constants.js";

export function getChartMetric(config) {
  return CHART_METRICS[config.chart_metric] || CHART_METRICS[DEFAULT_CHART_METRIC];
}

export function getChartEntityRole(config) {
  return getChartMetric(config).entityRole;
}

export function getCircuitChartEntity(circuit, config) {
  const role = getChartEntityRole(config);
  return circuit.entities?.[role] || circuit.entities?.power || null;
}
