import { describe, it, expect } from "vitest";
import { CARD_STYLES } from "../src/card/card-styles.js";

/** The opacity the card's stylesheet gives a pill with these classes, inside a locked or unlocked card. */
function pillOpacity(pillClasses: string, locked: boolean): number {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CARD_STYLES}</style><div class="span-card ${locked ? "switches-disabled" : ""}"><div class="${pillClasses}"></div></div>`;
  const opacity = Number(getComputedStyle(root.querySelector(".toggle-pill")!).opacity || "1");
  host.remove();
  return opacity;
}

describe("the toggle pill's dimming", () => {
  it("draws an inert pill dimmer than an operable one, locked or not", () => {
    expect(pillOpacity("toggle-pill toggle-on toggle-unavailable", false)).toBeLessThan(pillOpacity("toggle-pill toggle-on", false));
    expect(pillOpacity("toggle-pill toggle-on toggle-unavailable", true)).toBeLessThan(pillOpacity("toggle-pill toggle-on", true));
  });
});
