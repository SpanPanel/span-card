import { describe, it, expect } from "vitest";
import { SpanSwitch } from "../src/core/span-switch.js";

/**
 * The stylesheet's rules, by selector, each a map of its declarations. happy-dom
 * drops a declaration whose var() has a fallback, so the styles are read from
 * the stylesheet's text rather than from computed styles.
 */
function rules(cssText: string): Map<string, Map<string, string>> {
  const text = cssText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
  const byselector = new Map<string, Map<string, string>>();
  for (const [, selector = "", body = ""] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    byselector.set(selector.trim(), declarations);
  }
  return byselector;
}

const RULES = rules(SpanSwitch.styles.cssText);

function declarations(selector: string): Map<string, string> {
  const found = RULES.get(selector);
  if (!found) throw new Error(`no rule for ${selector}`);
  return found;
}

describe("<span-switch> styles, after <ha-switch> at Home Assistant frontend 20261028", () => {
  it("draws an unchecked switch in <ha-switch>'s colors, the theme's switch tokens first", () => {
    const host = declarations(":host");
    expect(host.get("--span-switch-track-color")).toBe(
      "var(--ha-switch-background-color, var(--ha-color-fill-disabled-quiet-resting, rgba(120, 120, 120, 0.45)))"
    );
    expect(host.get("--span-switch-track-border-color")).toBe("var(--ha-switch-border-color, var(--ha-color-border-neutral-normal, transparent))");
    expect(host.get("--span-switch-thumb-color")).toBe("var(--ha-switch-thumb-background-color, var(--ha-color-on-neutral-normal, #fafafa))");
    expect(host.get("--span-switch-thumb-border-color")).toBe("var(--ha-switch-thumb-border-color, var(--ha-color-on-neutral-normal, transparent))");
  });

  it("draws a checked switch in <ha-switch>'s colors, the theme's switch tokens first", () => {
    const checked = declarations(":host([checked])");
    expect(checked.get("--span-switch-track-color")).toBe(
      "var(--ha-switch-checked-background-color, var(--ha-color-fill-primary-normal-resting, var(--primary-color, #4dd9af)))"
    );
    expect(checked.get("--span-switch-track-border-color")).toBe("var(--ha-switch-checked-border-color, var(--ha-color-border-primary-loud, transparent))");
    expect(checked.get("--span-switch-thumb-color")).toBe("var(--ha-switch-checked-thumb-background-color, var(--ha-color-on-primary-normal, #fff))");
    expect(checked.get("--span-switch-thumb-border-color")).toBe("var(--ha-switch-checked-thumb-border-color, var(--ha-color-on-primary-normal, transparent))");
  });

  it("takes <ha-switch>'s hover colors under the pointer or keyboard focus, falling back to its resting tokens", () => {
    const unchecked = declarations(":host(:not([checked]):not([disabled]):hover), :host(:not([checked]):not([disabled]):focus-visible)");
    expect(unchecked.get("--span-switch-track-color")).toBe(
      "var(--ha-switch-background-color-hover, var(--ha-switch-background-color, var(--ha-color-fill-disabled-quiet-hover, rgba(120, 120, 120, 0.45))))"
    );
    expect(unchecked.has("--span-switch-track-border-color")).toBe(false);
    expect(unchecked.get("--span-switch-thumb-color")).toBe(
      "var(--ha-switch-thumb-background-color-hover, var(--ha-switch-thumb-background-color, var(--ha-color-on-neutral-normal, #fafafa)))"
    );
    expect(unchecked.get("--span-switch-thumb-border-color")).toBe(
      "var(--ha-switch-thumb-border-color-hover, var(--ha-switch-thumb-border-color, var(--ha-color-on-neutral-normal, transparent)))"
    );

    const checked = declarations(":host([checked]:not([disabled]):hover), :host([checked]:not([disabled]):focus-visible)");
    expect(checked.get("--span-switch-track-color")).toBe(
      "var(--ha-switch-checked-background-color-hover, var(--ha-switch-checked-background-color, var(--ha-color-fill-primary-normal-hover, var(--primary-color, #4dd9af))))"
    );
    expect(checked.get("--span-switch-track-border-color")).toBe(
      "var(--ha-switch-checked-border-color-hover, var(--ha-switch-checked-border-color, var(--ha-color-border-primary-loud, transparent)))"
    );
    expect(checked.get("--span-switch-thumb-color")).toBe(
      "var(--ha-switch-checked-thumb-background-color-hover, var(--ha-switch-checked-thumb-background-color, var(--ha-color-on-primary-normal, #fff)))"
    );
    expect(checked.get("--span-switch-thumb-border-color")).toBe(
      "var(--ha-switch-checked-thumb-border-color-hover, var(--ha-switch-checked-thumb-border-color, var(--ha-color-on-primary-normal, transparent)))"
    );
  });

  it("draws the track and thumb in those colors, each with a 1px border, and the thumb with <ha-switch>'s shadow", () => {
    expect(declarations(":host").get("--span-switch-border")).toBe("1px");
    const track = declarations(".track");
    expect(track.get("background")).toBe("var(--span-switch-track-color)");
    expect(track.get("border")).toBe("var(--span-switch-border) solid var(--span-switch-track-border-color)");
    const thumb = declarations(".thumb");
    expect(thumb.get("background")).toBe("var(--span-switch-thumb-color)");
    expect(thumb.get("border")).toBe("var(--span-switch-border) solid var(--span-switch-thumb-border-color)");
    expect(thumb.get("box-shadow")).toBe("var(--ha-switch-thumb-box-shadow, var(--ha-box-shadow-s, 0 1px 3px rgba(0, 0, 0, 0.35)))");
  });

  it("keeps its own size, not <ha-switch>'s, with the thumb an equal gap from the border on every side", () => {
    const host = declarations(":host");
    expect(host.get("--span-switch-track-w")).toBe("36px");
    expect(host.get("--span-switch-track-h")).toBe("20px");
    expect(host.get("--span-switch-thumb")).toBe("14px");
    expect(SpanSwitch.styles.cssText).not.toMatch(/--ha-switch-(size|width|thumb-size)\b/);
    // Both sizes count the 1px border inside them.
    expect(declarations(".track").get("box-sizing")).toBe("border-box");
    expect(declarations(".thumb").get("box-sizing")).toBe("border-box");
    // The gap above and below the thumb inside the border, and the same gap to its side, unchecked and checked.
    expect(host.get("--span-switch-inset")).toBe("calc((var(--span-switch-track-h) - 2 * var(--span-switch-border) - var(--span-switch-thumb)) / 2)");
    expect(declarations(".thumb").get("left")).toBe("var(--span-switch-inset)");
    expect(declarations(":host([checked]) .thumb").get("left")).toBe(
      "calc(var(--span-switch-track-w) - 2 * var(--span-switch-border) - var(--span-switch-inset) - var(--span-switch-thumb))"
    );
  });

  it("dims only the control while disabled, by the theme's disabled opacity or <ha-switch>'s", () => {
    expect(declarations(":host([disabled]) .track").get("opacity")).toBe("var(--ha-switch-disabled-opacity, 0.3)");
    expect(declarations(":host([disabled])").get("cursor")).toBe("not-allowed");
    expect(declarations(":host([disabled])").has("opacity")).toBe(false);
  });

  // <ha-switch> rings focus with --wa-focus-ring and --wa-focus-ring-offset, which Home Assistant declares on the
  // document as `solid 2px var(--wa-focus-ring-color)`, that color being --ha-color-focus.
  it("rings keyboard focus as <ha-switch> does, with Home Assistant's focus ring and offset", () => {
    const focus = declarations(":host(:focus-visible:not([disabled])) .track");
    expect(focus.get("outline")).toBe("var(--wa-focus-ring, 2px solid var(--ha-color-focus, var(--primary-color, #4dd9af)))");
    expect(focus.get("outline-offset")).toBe("var(--wa-focus-ring-offset, 2px)");
  });

  // <ha-switch> rings `label:not(.disabled)` only.
  it("rings no disabled switch", () => {
    const ringed = [...RULES].filter(([, body]) => body.has("outline")).map(([selector]) => selector);
    expect(ringed).toEqual([":host(:focus-visible:not([disabled])) .track"]);
  });

  it("reads none of the switch tokens Home Assistant 2026.5 retired", () => {
    expect(SpanSwitch.styles.cssText).not.toMatch(/var\(--switch-/);
  });
});

describe("<span-switch>", () => {
  it("registers as a custom element", () => {
    expect(customElements.get("span-switch")).toBeDefined();
  });

  it("sets ARIA role and tabindex on connect", async () => {
    const el = document.createElement("span-switch");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(el.getAttribute("role")).toBe("switch");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-checked")).toBe("false");

    el.remove();
  });

  it("takes no focus while disabled, and its tabindex back when enabled again", async () => {
    const el = document.createElement("span-switch");
    el.disabled = true;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.getAttribute("aria-disabled")).toBe("true");

    el.disabled = false;
    await el.updateComplete;
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-disabled")).toBe("false");

    el.disabled = true;
    await el.updateComplete;
    expect(el.hasAttribute("tabindex")).toBe(false);
    expect(el.getAttribute("aria-disabled")).toBe("true");

    el.remove();
  });

  it("keeps a tabindex it was given across being disabled and enabled", async () => {
    const el = document.createElement("span-switch");
    el.setAttribute("tabindex", "-1");
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.getAttribute("tabindex")).toBe("-1");

    el.disabled = true;
    await el.updateComplete;
    expect(el.hasAttribute("tabindex")).toBe(false);

    el.disabled = false;
    await el.updateComplete;
    expect(el.getAttribute("tabindex")).toBe("-1");

    el.remove();
  });

  it("reflects checked changes onto aria-checked and the [checked] attribute", async () => {
    const el = document.createElement("span-switch");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    (el as unknown as { checked: boolean }).checked = true;
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(el.hasAttribute("checked")).toBe(true);

    el.remove();
  });

  it("toggles checked and dispatches a bubbling composed change event on click", async () => {
    const el = document.createElement("span-switch");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    let received: Event | null = null;
    document.addEventListener(
      "change",
      e => {
        received = e;
      },
      { once: true }
    );

    el.click();
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect((el as unknown as { checked: boolean }).checked).toBe(true);
    expect(received).not.toBeNull();
    expect(received!.bubbles).toBe(true);
    expect(received!.composed).toBe(true);

    el.remove();
  });

  it("does not toggle or fire change while disabled", async () => {
    const el = document.createElement("span-switch");
    (el as unknown as { disabled: boolean }).disabled = true;
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    let received: Event | null = null;
    document.addEventListener(
      "change",
      e => {
        received = e;
      },
      { once: true }
    );

    el.click();
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect((el as unknown as { checked: boolean }).checked).toBe(false);
    expect(received).toBeNull();

    el.remove();
  });

  it("activates on Space or Enter keypress", async () => {
    const el = document.createElement("span-switch");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect((el as unknown as { checked: boolean }).checked).toBe(true);

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect((el as unknown as { checked: boolean }).checked).toBe(false);

    el.remove();
  });
});
