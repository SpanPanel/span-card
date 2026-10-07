import { describe, it, expect } from "vitest";
import { applySheddingIcon, applyTogglePill, buildSheddingIconHTML, buildTogglePillHTML } from "../src/core/circuit-controls.js";

function host(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("the toggle pill", () => {
  it("is not drawn when there is no switch", () => {
    expect(buildTogglePillHTML(true, "none")).toBe("");
  });

  it("is drawn operable, or dimmed and inert", () => {
    const operable = host(buildTogglePillHTML(true, "operable")).querySelector(".toggle-pill")!;
    expect(operable.classList.contains("toggle-on")).toBe(true);
    expect(operable.classList.contains("toggle-unavailable")).toBe(false);
    const inert = host(buildTogglePillHTML(false, "inert")).querySelector(".toggle-pill")!;
    expect(inert.classList.contains("toggle-off")).toBe(true);
    expect(inert.classList.contains("toggle-unavailable")).toBe(true);
  });

  it("keeps toggle-unavailable in step", () => {
    const scope = host(buildTogglePillHTML(true, "operable"));
    applyTogglePill(scope, false, "inert");
    const pill = scope.querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-unavailable")).toBe(true);
    expect(pill.classList.contains("toggle-off")).toBe(true);
    applyTogglePill(scope, true, "operable");
    expect(pill.classList.contains("toggle-unavailable")).toBe(false);
    expect(pill.classList.contains("toggle-on")).toBe(true);
  });
});

describe("the shedding marker", () => {
  it("is emitted hidden, with no help icon, while the priority is unknown", () => {
    const html = buildSheddingIconHTML("unknown");
    const marker = host(html).querySelector<HTMLElement>(".shedding-composite")!;
    expect(marker.style.display).toBe("none");
    expect(html).not.toContain("mdi:help-circle-outline");
  });

  it("shows a known priority, with its secondary icon or text label", () => {
    const scope = host(buildSheddingIconHTML("soc_threshold"));
    const marker = scope.querySelector<HTMLElement>(".shedding-composite")!;
    expect(marker.style.display).toBe("");
    expect(scope.querySelector<HTMLElement>(".shedding-label")!.style.display).toBe("");
    expect(scope.querySelector<HTMLElement>(".shedding-icon-secondary")!.style.display).toBe("none");
  });

  it("is re-shown once the priority becomes known, and hidden again for unknown", () => {
    const scope = host(buildSheddingIconHTML("unknown"));
    applySheddingIcon(scope, "always_on");
    const marker = scope.querySelector<HTMLElement>(".shedding-composite")!;
    expect(marker.style.display).toBe("");
    expect(scope.querySelector(".shedding-icon")!.getAttribute("icon")).toBe("mdi:battery");
    expect(scope.querySelector<HTMLElement>(".shedding-icon-secondary")!.style.display).toBe("");
    applySheddingIcon(scope, "unknown");
    expect(marker.style.display).toBe("none");
  });
});
