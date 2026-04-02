import { CHART_METRICS, DEFAULT_CHART_METRIC } from "../constants.js";
import type { CardConfig, ChartMetricDef, Circuit } from "../types.js";

export function getChartMetric(config: CardConfig): ChartMetricDef {
  const key = config.chart_metric ?? DEFAULT_CHART_METRIC;
  return CHART_METRICS[key] ?? CHART_METRICS[DEFAULT_CHART_METRIC]!;
}

export function getChartEntityRole(config: CardConfig): string {
  return getChartMetric(config).entityRole;
}

export function getCircuitChartEntity(circuit: Circuit, config: CardConfig): string | null {
  const role = getChartEntityRole(config);
  return circuit.entities?.[role] ?? circuit.entities?.power ?? null;
}
