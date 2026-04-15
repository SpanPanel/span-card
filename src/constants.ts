import { t } from "./i18n.js";
import type { ChartMetricDef, GraphHorizonPreset, SheddingPriorityDef } from "./types.js";

export const CARD_VERSION = "0.9.3";

// -- Defaults --

export const DEFAULT_HISTORY_DAYS = 0;
export const DEFAULT_HISTORY_HOURS = 0;
export const DEFAULT_HISTORY_MINUTES = 5;
export const DEFAULT_CHART_METRIC = "power";
export const LIVE_SAMPLE_INTERVAL_MS = 1000;

// -- Graph time horizon presets --

export const DEFAULT_GRAPH_HORIZON = "5m";

export const GRAPH_HORIZONS: Record<string, GraphHorizonPreset> = {
  "5m": { ms: 5 * 60 * 1000, refreshMs: 1000, useRealtime: true },
  "1h": { ms: 60 * 60 * 1000, refreshMs: 30000, useRealtime: false },
  "1d": { ms: 24 * 60 * 60 * 1000, refreshMs: 60000, useRealtime: false },
  "1w": { ms: 7 * 24 * 60 * 60 * 1000, refreshMs: 60000, useRealtime: false },
  "1M": { ms: 30 * 24 * 60 * 60 * 1000, refreshMs: 60000, useRealtime: false },
};

// -- Domain / type identifiers --

export const INTEGRATION_DOMAIN = "span_panel";
export const RELAY_STATE_CLOSED = "CLOSED";
export const DEVICE_TYPE_PV = "pv";
export const SUB_DEVICE_TYPE_BESS = "bess";
export const SUB_DEVICE_TYPE_EVSE = "evse";
export const SUB_DEVICE_KEY_PREFIX = "sub_";

// -- Chart layout constants --

export const CIRCUIT_CHART_HEIGHT = 100;
export const CIRCUIT_COL_SPAN_CHART_HEIGHT = 200;
export const BESS_CHART_COL_HEIGHT = 120;
export const EVSE_CHART_HEIGHT = 150;

// -- NEC breaker limits --

export const NEC_CONTINUOUS_LOAD_FACTOR = 0.8;
export const NEC_TRIP_RATING_FACTOR = 1.25;

// -- History thresholds --

export const STATISTICS_PERIOD_THRESHOLD_HOURS = 72;
export const MIN_HISTORY_DURATION_MS = 60_000;

// -- UI debounce / timing --

export const INPUT_DEBOUNCE_MS = 500;
export const THRESHOLD_DEBOUNCE_MS = 800;
export const ERROR_DISPLAY_MS = 5_000;

// -- Chart metric definitions --

export const CHART_METRICS: Record<string, ChartMetricDef> = {
  power: {
    entityRole: "power",
    label: () => t("metric.power"),
    unit: (v: number) => (Math.abs(v) >= 1000 ? "kW" : "W"),
    format: (v: number) => {
      const abs = Math.abs(v);
      if (abs >= 1000) return (abs / 1000).toFixed(1);
      if (abs < 10 && abs > 0) return abs.toFixed(1);
      return String(Math.round(abs));
    },
  },
  current: {
    entityRole: "current",
    label: () => t("metric.current"),
    unit: () => "A",
    format: (v: number) => Math.abs(v).toFixed(1),
  },
};

export const BESS_CHART_METRICS: Record<string, ChartMetricDef> = {
  soc: {
    entityRole: "soc",
    label: () => t("metric.soc"),
    unit: () => "%",
    format: (v: number) => String(Math.round(v)),
    fixedMin: 0,
    fixedMax: 100,
  },
  soe: {
    entityRole: "soe",
    label: () => t("metric.soe"),
    unit: () => "kWh",
    format: (v: number) => v.toFixed(1),
  },
  power: CHART_METRICS.power!,
};

// -- Shedding priority --

export const SHEDDING_PRIORITIES: Record<string, SheddingPriorityDef> = {
  always_on: { icon: "mdi:battery", icon2: "mdi:router-wireless", color: "#4caf50", label: () => t("shedding.always_on") },
  never: { icon: "mdi:battery", color: "#4caf50", label: () => t("shedding.never") },
  soc_threshold: { icon: "mdi:battery-alert-variant-outline", color: "#9c27b0", label: () => t("shedding.soc_threshold"), textLabel: "SoC" },
  off_grid: { icon: "mdi:transmission-tower", color: "#ff9800", label: () => t("shedding.off_grid") },
  unknown: { icon: "mdi:help-circle-outline", color: "#888", label: () => t("shedding.unknown") },
};

export const MONITORING_COLORS: Record<string, string> = {
  normal: "#4caf50",
  warning: "#ff9800",
  alert: "#f44336",
  custom: "#ff9800",
};
