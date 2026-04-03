import { describe, it, expect } from "vitest";
import { formatPowerUnit, formatPowerSigned, formatKw } from "../src/helpers/format.js";

describe("formatPowerUnit", () => {
  it("returns W for values under 1000", () => {
    expect(formatPowerUnit(500)).toBe("W");
    expect(formatPowerUnit(0)).toBe("W");
    expect(formatPowerUnit(999)).toBe("W");
  });

  it("returns kW for values >= 1000", () => {
    expect(formatPowerUnit(1000)).toBe("kW");
    expect(formatPowerUnit(5000)).toBe("kW");
  });

  it("handles negative values", () => {
    expect(formatPowerUnit(-500)).toBe("W");
    expect(formatPowerUnit(-1000)).toBe("kW");
  });
});

describe("formatPowerSigned", () => {
  it("formats positive values without sign", () => {
    expect(formatPowerSigned(500)).toBe("500");
    expect(formatPowerSigned(1500)).toBe("1.5");
  });

  it("formats negative values with minus sign", () => {
    expect(formatPowerSigned(-500)).toBe("-500");
    expect(formatPowerSigned(-1500)).toBe("-1.5");
  });

  it("formats zero", () => {
    expect(formatPowerSigned(0)).toBe("0");
  });

  it("formats small values with one decimal", () => {
    expect(formatPowerSigned(5)).toBe("5.0");
  });
});

describe("formatKw", () => {
  it("converts watts to kW with one decimal", () => {
    expect(formatKw(1000)).toBe("1.0");
    expect(formatKw(1500)).toBe("1.5");
    expect(formatKw(2345)).toBe("2.3");
  });

  it("handles negative values using absolute value", () => {
    expect(formatKw(-1500)).toBe("1.5");
  });

  it("handles zero", () => {
    expect(formatKw(0)).toBe("0.0");
  });
});
