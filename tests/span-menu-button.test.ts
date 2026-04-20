import { describe, it, expect, beforeAll } from "vitest";
import "../src/panel/span-menu-button.js";

beforeAll(() => {
  // Force the customElements registration to run by importing the module.
  // The guarded define inside the module is idempotent if the element is
  // already registered.
});

describe("<span-menu-button>", () => {
  it("registers as a custom element", () => {
    expect(customElements.get("span-menu-button")).toBeDefined();
  });

  it("dispatches a hass-toggle-menu CustomEvent on click that bubbles and is composed", async () => {
    const el = document.createElement("span-menu-button");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    let received: CustomEvent | null = null;
    document.addEventListener(
      "hass-toggle-menu",
      e => {
        received = e as CustomEvent;
      },
      { once: true }
    );

    const button = el.shadowRoot?.querySelector("button");
    expect(button).toBeTruthy();
    button!.click();

    expect(received).not.toBeNull();
    expect(received!.bubbles).toBe(true);
    expect(received!.composed).toBe(true);

    el.remove();
  });

  it("reflects the narrow boolean property to an attribute so :host([narrow]) CSS can match", async () => {
    const el = document.createElement("span-menu-button");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(el.hasAttribute("narrow")).toBe(false);

    (el as unknown as { narrow: boolean }).narrow = true;
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.hasAttribute("narrow")).toBe(true);

    (el as unknown as { narrow: boolean }).narrow = false;
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.hasAttribute("narrow")).toBe(false);

    el.remove();
  });
});
