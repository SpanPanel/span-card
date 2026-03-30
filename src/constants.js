import { t } from "./i18n.js";

export const CARD_VERSION = "0.8.9";

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_HISTORY_DAYS = 0;
export const DEFAULT_HISTORY_HOURS = 0;
export const DEFAULT_HISTORY_MINUTES = 5;
export const DEFAULT_CHART_METRIC = "power";
export const LIVE_SAMPLE_INTERVAL_MS = 1000;

// ── Domain / type identifiers ───────────────────────────────────────────────

export const INTEGRATION_DOMAIN = "span_panel";
export const RELAY_STATE_CLOSED = "CLOSED";
export const DEVICE_TYPE_PV = "pv";
export const SUB_DEVICE_TYPE_BESS = "bess";
export const SUB_DEVICE_TYPE_EVSE = "evse";
export const SUB_DEVICE_KEY_PREFIX = "sub_";

// ── Chart metric definitions ────────────────────────────────────────────────

export const CHART_METRICS = {
  power: {
    entityRole: "power",
    label: () => t("metric.power"),
    unit: v => (Math.abs(v) >= 1000 ? "kW" : "W"),
    format: v => (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) : String(Math.round(Math.abs(v)))),
  },
  current: {
    entityRole: "current",
    label: () => t("metric.current"),
    unit: () => "A",
    format: v => Math.abs(v).toFixed(1),
  },
};

export const BESS_CHART_METRICS = {
  soc: {
    label: () => t("metric.soc"),
    unit: () => "%",
    format: v => String(Math.round(v)),
    fixedMin: 0,
    fixedMax: 100,
  },
  soe: {
    label: () => t("metric.soe"),
    unit: () => "kWh",
    format: v => v.toFixed(1),
  },
  power: CHART_METRICS.power,
};

// ── Shedding priority ──────────────────────────────────────────────────────

export const SHEDDING_PRIORITIES = {
  never: { icon: "mdi:shield-check", color: "#4caf50", label: () => t("shedding.never") },
  soc_threshold: { icon: "mdi:battery-alert-variant-outline", color: "#9c27b0", label: () => t("shedding.soc_threshold") },
  off_grid: { icon: "mdi:transmission-tower", color: "#ff9800", label: () => t("shedding.off_grid") },
  unknown: { icon: "mdi:help-circle-outline", color: "#888", label: () => t("shedding.unknown") },
};

export const MONITORING_COLORS = {
  normal: "#4caf50",
  warning: "#ff9800",
  alert: "#f44336",
  custom: "#ff9800",
};
