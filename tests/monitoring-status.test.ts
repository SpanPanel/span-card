import { describe, it, expect } from "vitest";
import { getCircuitMonitoringInfo, hasCustomOverrides, getUtilizationClass, isAlertActive, mergeMonitoringStatuses } from "../src/core/monitoring-status.js";
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
