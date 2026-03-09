export const CARD_VERSION = "0.8.6";

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
    label: "Power",
    unit: v => (Math.abs(v) >= 1000 ? "kW" : "W"),
    format: v => (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) : String(Math.round(Math.abs(v)))),
  },
  current: {
    entityRole: "current",
    label: "Current",
    unit: () => "A",
    format: v => Math.abs(v).toFixed(1),
  },
};

export const BESS_CHART_METRICS = {
  soc: {
    label: "State of Charge",
    unit: () => "%",
    format: v => String(Math.round(v)),
    fixedMin: 0,
    fixedMax: 100,
  },
  soe: {
    label: "State of Energy",
    unit: () => "kWh",
    format: v => v.toFixed(1),
  },
  power: CHART_METRICS.power,
};
