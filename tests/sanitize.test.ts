import { describe, it, expect } from "vitest";
import { escapeHtml } from "../src/helpers/sanitize.js";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes quotes", () => {
    expect(escapeHtml("\"hello'")).toBe("&quot;hello&#39;");
  });

  it("handles non-string input", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("null");
    expect(escapeHtml(undefined)).toBe("undefined");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("does not double-escape", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
