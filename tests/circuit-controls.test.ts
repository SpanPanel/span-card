import { describe, it, expect, afterEach } from "vitest";
import { applySheddingIcon, applyTogglePill, buildSheddingIconHTML, buildTogglePillHTML } from "../src/core/circuit-controls.js";
import { CONTROLS_OPERABLE } from "../src/core/control-access.js";
import { setLanguage } from "../src/i18n.js";
import type { ControlAccess } from "../src/types.js";

const ADMIN_ONLY: ControlAccess = { mayOperate: false, reason: "admin_only" };
const SWITCHED_OFF: ControlAccess = { mayOperate: false, reason: "control_disabled" };

function host(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

afterEach(() => {
  setLanguage("en");
});

describe("the toggle pill", () => {
  it("is not drawn when there is no switch", () => {
    expect(buildTogglePillHTML(true, "none", CONTROLS_OPERABLE)).toBe("");
  });

  it("is drawn operable, or dimmed and inert", () => {
    const operable = host(buildTogglePillHTML(true, "operable", CONTROLS_OPERABLE)).querySelector(".toggle-pill")!;
    expect(operable.classList.contains("toggle-on")).toBe(true);
    expect(operable.classList.contains("toggle-unavailable")).toBe(false);
    const inert = host(buildTogglePillHTML(false, "inert", CONTROLS_OPERABLE)).querySelector(".toggle-pill")!;
    expect(inert.classList.contains("toggle-off")).toBe(true);
    expect(inert.classList.contains("toggle-unavailable")).toBe(true);
  });

  it("keeps toggle-unavailable in step", () => {
    const scope = host(buildTogglePillHTML(true, "operable", CONTROLS_OPERABLE));
    applyTogglePill(scope, false, "inert", CONTROLS_OPERABLE);
    const pill = scope.querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-unavailable")).toBe(true);
    expect(pill.classList.contains("toggle-off")).toBe(true);
    applyTogglePill(scope, true, "operable", CONTROLS_OPERABLE);
    expect(pill.classList.contains("toggle-unavailable")).toBe(false);
    expect(pill.classList.contains("toggle-on")).toBe(true);
  });

  it("is drawn untitled and not forbidden where the user may operate the panel's controls", () => {
    const pill = host(buildTogglePillHTML(true, "operable", CONTROLS_OPERABLE)).querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-forbidden")).toBe(false);
    expect(pill.hasAttribute("title")).toBe(false);
    expect(pill.hasAttribute("aria-disabled")).toBe(false);
  });

  it.each([
    [ADMIN_ONLY, "Only an administrator can operate this panel's controls."],
    [SWITCHED_OFF, "Control of this panel is switched off in its options."],
    [{ mayOperate: false, reason: "read_only" } satisfies ControlAccess, "Your Home Assistant account can't operate this panel's controls."],
    [{ mayOperate: false, reason: null } satisfies ControlAccess, "You can't operate this panel's controls."],
  ])("is drawn forbidden where the user may not operate the panel's controls, still showing the relay, titled with why", (access, why) => {
    const pill = host(buildTogglePillHTML(true, "operable", access)).querySelector(".toggle-pill")!;
    expect(pill.classList.contains("toggle-forbidden")).toBe(true);
    expect(pill.classList.contains("toggle-on")).toBe(true);
    expect(pill.getAttribute("title")).toBe(why);
    expect(pill.getAttribute("aria-disabled")).toBe("true");
  });

  it("says why it is forbidden over that it switches every circuit in its space", () => {
    const shared = host(buildTogglePillHTML(false, "operable", CONTROLS_OPERABLE, true)).querySelector(".toggle-pill")!;
    expect(shared.getAttribute("title")).toBe("Switches every circuit in this space");
    const forbidden = host(buildTogglePillHTML(false, "operable", ADMIN_ONLY, true)).querySelector(".toggle-pill")!;
    expect(forbidden.getAttribute("title")).toBe("Only an administrator can operate this panel's controls.");
  });

  it("keeps toggle-forbidden, its title and aria-disabled in step with the access, a shared switch's title coming back", () => {
    const scope = host(buildTogglePillHTML(true, "operable", CONTROLS_OPERABLE, true));
    const pill = scope.querySelector(".toggle-pill")!;
    applyTogglePill(scope, true, "operable", ADMIN_ONLY);
    expect(pill.classList.contains("toggle-forbidden")).toBe(true);
    expect(pill.getAttribute("title")).toBe("Only an administrator can operate this panel's controls.");
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    applyTogglePill(scope, true, "operable", CONTROLS_OPERABLE);
    expect(pill.classList.contains("toggle-forbidden")).toBe(false);
    expect(pill.getAttribute("title")).toBe("Switches every circuit in this space");
    expect(pill.hasAttribute("aria-disabled")).toBe(false);
  });

  it("leaves a pill that is neither forbidden nor shared untitled as it updates", () => {
    const scope = host(buildTogglePillHTML(true, "operable", ADMIN_ONLY));
    const pill = scope.querySelector(".toggle-pill")!;
    applyTogglePill(scope, false, "operable", CONTROLS_OPERABLE);
    expect(pill.hasAttribute("title")).toBe(false);
  });

  it("says why in the user's language", () => {
    setLanguage("fr");
    const pill = host(buildTogglePillHTML(true, "operable", SWITCHED_OFF)).querySelector(".toggle-pill")!;
    expect(pill.getAttribute("title")).toBe("La commande de ce panneau est d\u00e9sactiv\u00e9e dans ses options.");
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
