import { describe, it, expect } from "vitest";
import { deepEqual } from "../src/helpers/deep-equal.js";

describe("deepEqual", () => {
  it("compares JSON-shaped values by structure, not by reference", () => {
    expect(deepEqual({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: { b: "x" } }, { a: { b: "y" } })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });

  it("treats a key holding undefined as absent, as JSON does", () => {
    expect(deepEqual({ a: 1, area: undefined }, { a: 1 })).toBe(true);
  });
});
