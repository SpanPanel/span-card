import { describe, it, expect } from "vitest";
import { tabToRow, tabToCol, classifyDualTab } from "../src/helpers/layout.js";

describe("tabToRow", () => {
  it("maps odd tabs to correct rows", () => {
    expect(tabToRow(1)).toBe(1);
    expect(tabToRow(3)).toBe(2);
    expect(tabToRow(5)).toBe(3);
  });

  it("maps even tabs to correct rows", () => {
    expect(tabToRow(2)).toBe(1);
    expect(tabToRow(4)).toBe(2);
    expect(tabToRow(6)).toBe(3);
  });
});

describe("tabToCol", () => {
  it("maps odd tabs to left column (0)", () => {
    expect(tabToCol(1)).toBe(0);
    expect(tabToCol(3)).toBe(0);
    expect(tabToCol(5)).toBe(0);
  });

  it("maps even tabs to right column (1)", () => {
    expect(tabToCol(2)).toBe(1);
    expect(tabToCol(4)).toBe(1);
    expect(tabToCol(6)).toBe(1);
  });
});

describe("classifyDualTab", () => {
  it("returns null for non-dual tabs", () => {
    expect(classifyDualTab([1])).toBeNull();
    expect(classifyDualTab([1, 2, 3])).toBeNull();
  });

  it("returns row-span for adjacent tabs in same row", () => {
    expect(classifyDualTab([1, 2])).toBe("row-span");
    expect(classifyDualTab([3, 4])).toBe("row-span");
  });

  it("returns col-span for tabs in same column", () => {
    expect(classifyDualTab([1, 3])).toBe("col-span");
    expect(classifyDualTab([2, 4])).toBe("col-span");
  });

  it("handles unordered tab arrays", () => {
    expect(classifyDualTab([2, 1])).toBe("row-span");
    expect(classifyDualTab([3, 1])).toBe("col-span");
  });

  it("defaults to row-span for diagonal tabs", () => {
    expect(classifyDualTab([1, 4])).toBe("row-span");
  });
});
