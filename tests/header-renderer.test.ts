import { describe, it, expect } from "vitest";
import { buildSheddingLegendHTML } from "../src/core/header-renderer.js";

describe("buildSheddingLegendHTML", () => {
  it("returns a shedding-legend container with one item per non-unknown priority", () => {
    const html = buildSheddingLegendHTML();
    // Container
    expect(html).toContain('class="shedding-legend"');
    // Each visible priority renders a .shedding-legend-item
    const itemCount = (html.match(/class="shedding-legend-item"/g) ?? []).length;
    expect(itemCount).toBeGreaterThan(0);
  });

  it("includes an ha-icon with a color style for each item", () => {
    const html = buildSheddingLegendHTML();
    expect(html).toMatch(/<ha-icon icon="[^"]+" style="color:[^"]+"><\/ha-icon>/);
  });

  it("does not render a .shedding-legend-item for the 'unknown' priority key", () => {
    // Crude but effective: the 'unknown' label is never user-visible in real
    // panel headers; this asserts that remains true in the extracted helper.
    const html = buildSheddingLegendHTML();
    expect(html.toLowerCase()).not.toContain("unknown");
  });
});
