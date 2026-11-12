import { describe, it, expect } from "vitest";
import {
  getCircuitMonitoringInfo,
  hasCustomOverrides,
  getUtilizationClass,
  isAlertActive,
  mergeMonitoringStatuses,
  monitoringStatusFrom,
  buildMonitoringSummaryHTML,
  utilizationLevel,
} from "../src/core/monitoring-status.js";
import type { MonitoringPointInfo, MonitoringStatus } from "../src/types.js";

describe("getCircuitMonitoringInfo", () => {
  it("returns null when status is null", () => {
    expect(getCircuitMonitoringInfo(null, "sensor.circuit_1_power")).toBeNull();
  });

  it("returns null when circuits map is missing", () => {
    const status: MonitoringStatus = {};
    expect(getCircuitMonitoringInfo(status, "sensor.circuit_1_power")).toBeNull();
  });

  it("returns null when entity is not in circuits map", () => {
    const status: MonitoringStatus = { circuits: {} };
    expect(getCircuitMonitoringInfo(status, "sensor.circuit_1_power")).toBeNull();
  });

  it("returns monitoring info when entity exists", () => {
    const info: MonitoringPointInfo = { utilization_pct: 55, monitoring_enabled: true };
    const status: MonitoringStatus = {
      circuits: { "sensor.circuit_1_power": info },
    };
    expect(getCircuitMonitoringInfo(status, "sensor.circuit_1_power")).toBe(info);
  });
});

describe("hasCustomOverrides", () => {
  it("returns false when info is null", () => {
    expect(hasCustomOverrides(null)).toBe(false);
  });

  it("returns false when continuous_threshold_pct is undefined", () => {
    const info: MonitoringPointInfo = { utilization_pct: 50 };
    expect(hasCustomOverrides(info)).toBe(false);
  });

  it("returns true when continuous_threshold_pct is defined", () => {
    const info: MonitoringPointInfo = { continuous_threshold_pct: 80 };
    expect(hasCustomOverrides(info)).toBe(true);
  });
});

describe("getUtilizationClass", () => {
  it("returns empty string when info is null", () => {
    expect(getUtilizationClass(null)).toBe("");
  });

  it("returns empty string when utilization_pct is undefined", () => {
    const info: MonitoringPointInfo = {};
    expect(getUtilizationClass(info)).toBe("");
  });

  it("returns empty string when utilization_pct is 0", () => {
    const info: MonitoringPointInfo = { utilization_pct: 0 };
    expect(getUtilizationClass(info)).toBe("");
  });

  it("returns utilization-normal for pct below 80", () => {
    const info: MonitoringPointInfo = { utilization_pct: 50 };
    expect(getUtilizationClass(info)).toBe("utilization-normal");
  });

  it("returns utilization-warning for pct at 80", () => {
    const info: MonitoringPointInfo = { utilization_pct: 80 };
    expect(getUtilizationClass(info)).toBe("utilization-warning");
  });

  it("returns utilization-warning for pct between 80 and 99", () => {
    const info: MonitoringPointInfo = { utilization_pct: 95 };
    expect(getUtilizationClass(info)).toBe("utilization-warning");
  });

  it("returns utilization-alert for pct at 100", () => {
    const info: MonitoringPointInfo = { utilization_pct: 100 };
    expect(getUtilizationClass(info)).toBe("utilization-alert");
  });

  it("returns utilization-alert for pct above 100", () => {
    const info: MonitoringPointInfo = { utilization_pct: 120 };
    expect(getUtilizationClass(info)).toBe("utilization-alert");
  });
});

describe("isAlertActive", () => {
  it("returns false when info is null", () => {
    expect(isAlertActive(null)).toBe(false);
  });

  it("returns false when over_threshold_since is null", () => {
    const info: MonitoringPointInfo = { over_threshold_since: null };
    expect(isAlertActive(info)).toBe(false);
  });

  it("returns false when over_threshold_since is undefined", () => {
    const info: MonitoringPointInfo = {};
    expect(isAlertActive(info)).toBe(false);
  });

  it("returns true when over_threshold_since is a timestamp string", () => {
    const info: MonitoringPointInfo = { over_threshold_since: "2026-04-01T12:00:00Z" };
    expect(isAlertActive(info)).toBe(true);
  });
});

describe("mergeMonitoringStatuses", () => {
  it("returns null when input is empty", () => {
    expect(mergeMonitoringStatuses([])).toBeNull();
  });

  it("returns null when every input is null", () => {
    expect(mergeMonitoringStatuses([null, null, undefined])).toBeNull();
  });

  it("returns the single status when only one is non-null", () => {
    const status: MonitoringStatus = {
      circuits: { "sensor.a_power": { utilization_pct: 40 } },
      mains: {},
    };
    expect(mergeMonitoringStatuses([status])).toEqual({
      circuits: { "sensor.a_power": { utilization_pct: 40 } },
      mains: {},
    });
  });

  it("merges circuit maps across multiple statuses", () => {
    const s1: MonitoringStatus = {
      circuits: { "sensor.a_power": { utilization_pct: 40 } },
    };
    const s2: MonitoringStatus = {
      circuits: { "sensor.b_power": { utilization_pct: 60 } },
    };
    const merged = mergeMonitoringStatuses([s1, s2]);
    expect(merged?.circuits).toEqual({
      "sensor.a_power": { utilization_pct: 40 },
      "sensor.b_power": { utilization_pct: 60 },
    });
  });

  it("merges mains maps across multiple statuses", () => {
    const s1: MonitoringStatus = {
      mains: { "sensor.main_a": { utilization_pct: 50 } },
    };
    const s2: MonitoringStatus = {
      mains: { "sensor.main_b": { utilization_pct: 70 } },
    };
    const merged = mergeMonitoringStatuses([s1, s2]);
    expect(merged?.mains).toEqual({
      "sensor.main_a": { utilization_pct: 50 },
      "sensor.main_b": { utilization_pct: 70 },
    });
  });

  it("skips null entries while merging the rest", () => {
    const s1: MonitoringStatus = {
      circuits: { "sensor.a_power": { utilization_pct: 40 } },
    };
    const s2: MonitoringStatus = {
      circuits: { "sensor.b_power": { utilization_pct: 60 } },
    };
    const merged = mergeMonitoringStatuses([s1, null, s2, undefined]);
    expect(merged?.circuits).toEqual({
      "sensor.a_power": { utilization_pct: 40 },
      "sensor.b_power": { utilization_pct: 60 },
    });
  });

  it("later entries overwrite earlier ones on key collision", () => {
    const s1: MonitoringStatus = {
      circuits: { "sensor.a_power": { utilization_pct: 10 } },
    };
    const s2: MonitoringStatus = {
      circuits: { "sensor.a_power": { utilization_pct: 99 } },
    };
    const merged = mergeMonitoringStatuses([s1, s2]);
    expect(merged?.circuits?.["sensor.a_power"]?.utilization_pct).toBe(99);
  });
});

describe("monitoringStatusFrom", () => {
  it("is no status when monitoring is off", () => {
    expect(monitoringStatusFrom({ enabled: false })).toBeNull();
    expect(monitoringStatusFrom(undefined)).toBeNull();
  });

  it("is the monitored points when monitoring is on", () => {
    const circuits = { "sensor.circuit_1_power": { utilization_pct: 55 } };
    const mains = { "sensor.mains_power": { utilization_pct: 20 } };
    expect(monitoringStatusFrom({ enabled: true, circuits, mains, global_settings: {} })).toEqual({ circuits, mains });
  });
});

/** The thresholds the #260 user was told to set on a 20 A tandem judged as its pair. */
const TANDEM: MonitoringPointInfo = { continuous_threshold_pct: 160, spike_threshold_pct: 200 };
const DEFAULTS: MonitoringPointInfo = { continuous_threshold_pct: 80, spike_threshold_pct: 100 };

describe("utilizationLevel", () => {
  it("judges a point against its own thresholds: a warning from the continuous one, an alert from the spike one", () => {
    expect([150, 159.9, 160, 199.9, 200, 250].map(pct => utilizationLevel(pct, TANDEM))).toEqual(["normal", "normal", "warning", "warning", "alert", "alert"]);
  });

  it("judges the default thresholds as the card always has", () => {
    expect([0, 79.9, 80, 99.9, 100, 150].map(pct => utilizationLevel(pct, DEFAULTS))).toEqual(["normal", "normal", "warning", "warning", "alert", "alert"]);
  });

  it("falls back to 80 % and 100 % only where monitoring gives no thresholds", () => {
    for (const info of [null, {}]) {
      expect([79.9, 80, 99.9, 100].map(pct => utilizationLevel(pct, info))).toEqual(["normal", "warning", "warning", "alert"]);
    }
  });
});

describe("the monitoring summary's counts", () => {
  /** The summary's warning and alert counts, null where it shows none. */
  function counts(points: MonitoringPointInfo[]): { warnings: number | null; alerts: number | null } {
    const div = document.createElement("div");
    const circuits = Object.fromEntries(points.map((point, i) => [`sensor.c${i}_power`, point]));
    div.innerHTML = buildMonitoringSummaryHTML({ circuits, mains: {} });
    const count = (selector: string) => {
      const text = div.querySelector(selector)?.textContent;
      return text ? Number.parseInt(text, 10) : null;
    };
    return { warnings: count(".count-warning"), alerts: count(".count-alert") };
  }

  it("counts a point against its own thresholds", () => {
    // 150 % is under the tandem's 160 % continuous threshold: neither a warning nor an alert, as the monitor judges it.
    expect(counts([{ ...TANDEM, utilization_pct: 150 }])).toEqual({ warnings: null, alerts: null });
    expect(
      counts([
        { ...TANDEM, utilization_pct: 170 },
        { ...TANDEM, utilization_pct: 200 },
      ])
    ).toEqual({ warnings: 1, alerts: 1 });
  });

  it("counts default thresholds as before", () => {
    const points = [79, 80, 99, 100, 150].map(utilization_pct => ({ ...DEFAULTS, utilization_pct }));
    expect(counts(points)).toEqual({ warnings: 2, alerts: 2 });
  });

  it("counts a shared meter once, however many of its members report it", () => {
    // Every member of a group reports the group's judgement under the group's point id.
    const tandem = (utilization_pct: number) => ({ ...TANDEM, utilization_pct, point_id: "t-a" });
    expect(counts([tandem(170), tandem(170)])).toEqual({ warnings: 1, alerts: null });
    expect(counts([tandem(210), tandem(210), { ...DEFAULTS, utilization_pct: 120, point_id: "c-1" }])).toEqual({ warnings: null, alerts: 2 });
  });

  it("counts each entry as its own point where the integration names none, as an older one does", () => {
    expect(
      counts([
        { ...DEFAULTS, utilization_pct: 85 },
        { ...DEFAULTS, utilization_pct: 85 },
      ])
    ).toEqual({ warnings: 2, alerts: null });
  });

  it("counts a shared meter's override once", () => {
    const div = document.createElement("div");
    const member = { has_override: true, point_id: "t-a" };
    div.innerHTML = buildMonitoringSummaryHTML({ circuits: { "sensor.a_power": member, "sensor.b_power": member }, mains: {} });
    expect(Number.parseInt(div.querySelector(".count-overrides")!.textContent!, 10)).toBe(1);
  });

  it("counts a point that reports no thresholds against 80 % and 100 %", () => {
    expect(counts([{ utilization_pct: 85 }, { utilization_pct: 120 }])).toEqual({ warnings: 1, alerts: 1 });
  });
});
