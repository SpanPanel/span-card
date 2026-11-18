import { describe, it, expect } from "vitest";

/**
 * Test harness: import the same pure pieces the panel method uses so we
 * can assert the summary strip's structural contract without needing a
 * DOM or a Lit element instance. The panel method itself is a thin
 * wrapper over `buildFavoritesSummaryHTML(isAmpsMode, controls)` once refactored.
 */
import { buildFavoritesSummaryHTML } from "../src/panel/favorites-summary.js";
import { CONTROLS_OPERABLE } from "../src/core/control-access.js";

describe("buildFavoritesSummaryHTML", () => {
  it("renders gear → slide-to-arm → right-cluster in DOM order", () => {
    const html = buildFavoritesSummaryHTML(false, CONTROLS_OPERABLE);
    const idxGear = html.indexOf('class="gear-icon panel-gear favorites-gear"');
    const idxSlide = html.indexOf('class="slide-confirm"');
    const idxRight = html.indexOf('class="favorites-summary-right"');
    expect(idxGear).toBeGreaterThanOrEqual(0);
    expect(idxSlide).toBeGreaterThanOrEqual(0);
    expect(idxRight).toBeGreaterThanOrEqual(0);
    expect(idxGear).toBeLessThan(idxSlide);
    expect(idxSlide).toBeLessThan(idxRight);
  });

  it("right cluster contains shedding-legend then unit-toggle in order", () => {
    const html = buildFavoritesSummaryHTML(false, CONTROLS_OPERABLE);
    const idxRight = html.indexOf('class="favorites-summary-right"');
    const rest = html.slice(idxRight);
    const idxLegend = rest.indexOf('class="shedding-legend"');
    const idxToggle = rest.indexOf('class="unit-toggle favorites-summary-unit-toggle"');
    expect(idxLegend).toBeGreaterThanOrEqual(0);
    expect(idxToggle).toBeGreaterThanOrEqual(0);
    expect(idxLegend).toBeLessThan(idxToggle);
  });

  it("marks W active when isAmpsMode is false", () => {
    const html = buildFavoritesSummaryHTML(false, CONTROLS_OPERABLE);
    expect(html).toMatch(/<button class="unit-btn unit-active" data-unit="power">W<\/button>/);
    expect(html).toMatch(/<button class="unit-btn " data-unit="current">A<\/button>/);
  });

  it("marks A active when isAmpsMode is true", () => {
    const html = buildFavoritesSummaryHTML(true, CONTROLS_OPERABLE);
    expect(html).toMatch(/<button class="unit-btn " data-unit="power">W<\/button>/);
    expect(html).toMatch(/<button class="unit-btn unit-active" data-unit="current">A<\/button>/);
  });

  it("draws the slider as before, with no note, where the user may operate the favorites' controls", () => {
    const strip = document.createElement("div");
    strip.innerHTML = buildFavoritesSummaryHTML(false, CONTROLS_OPERABLE);
    const slide = strip.querySelector(".slide-confirm")!;
    expect(slide.classList.contains("slide-confirm-forbidden")).toBe(false);
    expect(slide.hasAttribute("title")).toBe(false);
    expect(strip.querySelector('[data-role="controls-note"]')).toBeNull();
  });

  it("draws the slider forbidden, titled and noted with why, where the user may operate none of them", () => {
    const strip = document.createElement("div");
    strip.innerHTML = buildFavoritesSummaryHTML(false, { mayOperate: false, reason: "admin_only" });
    const slide = strip.querySelector(".slide-confirm")!;
    expect(slide.classList.contains("slide-confirm-forbidden")).toBe(true);
    expect(slide.hasAttribute("aria-disabled")).toBe(false);
    expect(slide.getAttribute("title")).toBe("Only an administrator can operate this panel's controls.");
    expect(strip.querySelector('[data-role="controls-note"]')!.textContent).toBe("Only an administrator can operate this panel's controls.");
  });
});
