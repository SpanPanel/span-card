import { describe, it, expect } from "vitest";
import { getCircuitStateClasses } from "../src/core/circuit-state.js";
import type { Circuit, MonitoringPointInfo } from "../src/types.js";

const baseCircuit = { name: "Test" } as Circuit;

describe("getCircuitStateClasses", () => {
  it("returns empty string when circuit is on, not producer, no monitoring info", () => {
    expect(getCircuitStateClasses(baseCircuit, null, true, false)).toBe("");
  });

  it("adds circuit-off when isOn is false", () => {
    expect(getCircuitStateClasses(baseCircuit, null, false, false)).toBe("circuit-off");
  });

  it("adds circuit-producer when isProducer is true", () => {
    expect(getCircuitStateClasses(baseCircuit, null, true, true)).toBe("circuit-producer");
  });

  it("adds both when off and producer", () => {
    const result = getCircuitStateClasses(baseCircuit, null, false, true);
    expect(result).toContain("circuit-off");
    expect(result).toContain("circuit-producer");
  });

  it("adds circuit-alert when monitoringInfo indicates alert", () => {
    const info: MonitoringPointInfo = { utilization_pct: 95, over_threshold_since: "2024-01-01T00:00:00Z" };
    const result = getCircuitStateClasses(baseCircuit, info, true, false);
    expect(result).toContain("circuit-alert");
  });

  it("adds circuit-custom-monitoring when continuous_threshold_pct is set", () => {
    const info: MonitoringPointInfo = { continuous_threshold_pct: 80 };
    const result = getCircuitStateClasses(baseCircuit, info, true, false);
    expect(result).toContain("circuit-custom-monitoring");
  });

  it("handles all classes together", () => {
    const info: MonitoringPointInfo = {
      utilization_pct: 99,
      over_threshold_since: "2024-01-01T00:00:00Z",
      continuous_threshold_pct: 80,
    };
    const result = getCircuitStateClasses(baseCircuit, info, false, true);
    expect(result).toContain("circuit-off");
    expect(result).toContain("circuit-producer");
    expect(result).toContain("circuit-alert");
    expect(result).toContain("circuit-custom-monitoring");
  });
});
