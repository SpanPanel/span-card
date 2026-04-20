import { describe, it, expect } from "vitest";
import "../src/core/span-switch.js";

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
