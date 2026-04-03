import { describe, it, expect } from "vitest";
import { getEffectiveHorizon, getEffectiveSubDeviceHorizon } from "../src/core/graph-settings.js";
import type { GraphSettings } from "../src/types.js";

describe("getEffectiveHorizon", () => {
  it("returns DEFAULT_GRAPH_HORIZON when settings is null", () => {
    expect(getEffectiveHorizon(null, "circuit_1")).toBe("5m");
  });

  it("returns global_horizon when no circuit override exists", () => {
    const settings: GraphSettings = { global_horizon: "1h" };
    expect(getEffectiveHorizon(settings, "circuit_1")).toBe("1h");
  });

  it("returns global_horizon when circuit exists but has_override is false", () => {
    const settings: GraphSettings = {
      global_horizon: "1h",
      circuits: { circuit_1: { horizon: "1d", has_override: false } },
    };
    expect(getEffectiveHorizon(settings, "circuit_1")).toBe("1h");
  });

  it("returns override horizon when has_override is true", () => {
    const settings: GraphSettings = {
      global_horizon: "1h",
      circuits: { circuit_1: { horizon: "1d", has_override: true } },
    };
    expect(getEffectiveHorizon(settings, "circuit_1")).toBe("1d");
  });

  it("falls back to DEFAULT_GRAPH_HORIZON when global_horizon is undefined", () => {
    const settings: GraphSettings = {};
    expect(getEffectiveHorizon(settings, "circuit_1")).toBe("5m");
  });
});

describe("getEffectiveSubDeviceHorizon", () => {
  it("returns DEFAULT_GRAPH_HORIZON when settings is null", () => {
    expect(getEffectiveSubDeviceHorizon(null, "sub_1")).toBe("5m");
  });

  it("returns global_horizon when no sub-device override exists", () => {
    const settings: GraphSettings = { global_horizon: "1h" };
    expect(getEffectiveSubDeviceHorizon(settings, "sub_1")).toBe("1h");
  });

  it("returns global_horizon when sub-device exists but has_override is false", () => {
    const settings: GraphSettings = {
      global_horizon: "1h",
      sub_devices: { sub_1: { horizon: "1w", has_override: false } },
    };
    expect(getEffectiveSubDeviceHorizon(settings, "sub_1")).toBe("1h");
  });

  it("returns override horizon when has_override is true", () => {
    const settings: GraphSettings = {
      global_horizon: "1h",
      sub_devices: { sub_1: { horizon: "1w", has_override: true } },
    };
    expect(getEffectiveSubDeviceHorizon(settings, "sub_1")).toBe("1w");
  });

  it("falls back to DEFAULT_GRAPH_HORIZON when global_horizon is undefined", () => {
    const settings: GraphSettings = {};
    expect(getEffectiveSubDeviceHorizon(settings, "sub_1")).toBe("5m");
  });
});
