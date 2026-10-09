import { describe, it, expect } from "vitest";
import { readNumber, sumReadings } from "../src/helpers/read-number.js";
import type { HassEntity } from "../src/types.js";

function entity(state: string): HassEntity {
  return { entity_id: "sensor.x", state, attributes: {}, last_changed: "", last_updated: "" };
}

describe("readNumber", () => {
  it("reads a published number, zero included", () => {
    expect(readNumber(entity("120.5"))).toBe(120.5);
    expect(readNumber(entity("0"))).toBe(0);
    expect(readNumber(entity("-3.2"))).toBe(-3.2);
  });

  it("is null for anything that is not a reading", () => {
    expect(readNumber(undefined)).toBeNull();
    expect(readNumber(null)).toBeNull();
    expect(readNumber(entity("unknown"))).toBeNull();
    expect(readNumber(entity("unavailable"))).toBeNull();
    expect(readNumber(entity(""))).toBeNull();
    expect(readNumber(entity("abc"))).toBeNull();
    expect(readNumber(entity("Infinity"))).toBeNull();
  });
});

describe("sumReadings", () => {
  it("adds every reading, a published zero included, and is whole", () => {
    expect(sumReadings([100, 0, 25])).toEqual({ total: 125, partial: false });
  });

  it("skips an unknown term and says the total is partial", () => {
    expect(sumReadings([100, null, 25])).toEqual({ total: 125, partial: true });
  });

  it("is unknown, not 0, when no term was measured", () => {
    expect(sumReadings([null, null])).toEqual({ total: null, partial: false });
    expect(sumReadings([])).toEqual({ total: null, partial: false });
  });
});
