import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../src/core/span-icon.js";

describe("<span-icon>", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the console.warn spy so it doesn't leak into other test
    // files that re-spy console.warn (vitest reuses workers across
    // files; without this, call counts collide).
    vi.restoreAllMocks();
  });

  it("registers as a custom element", () => {
    expect(customElements.get("span-icon")).toBeDefined();
  });

  it("renders an inline SVG path for a known icon", async () => {
    const el = document.createElement("span-icon");
    (el as unknown as { icon: string }).icon = "mdi:cog";
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg).toBeTruthy();
    const path = svg!.querySelector("path");
    expect(path).toBeTruthy();
    expect(path!.getAttribute("d")).toBeTruthy();

    el.remove();
  });

  it("renders nothing for an empty icon attribute", async () => {
    const el = document.createElement("span-icon");
    document.body.appendChild(el);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(el.shadowRoot?.querySelector("svg")).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();

    el.remove();
  });

  it("renders nothing for an unknown icon and warns once", async () => {
    const el1 = document.createElement("span-icon");
    (el1 as unknown as { icon: string }).icon = "mdi:does-not-exist-xyz";
    document.body.appendChild(el1);
    await (el1 as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(el1.shadowRoot?.querySelector("svg")).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);

    // Same unknown icon used again — should not warn a second time.
    const el2 = document.createElement("span-icon");
    (el2 as unknown as { icon: string }).icon = "mdi:does-not-exist-xyz";
    document.body.appendChild(el2);
    await (el2 as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    expect(console.warn).toHaveBeenCalledTimes(1);

    el1.remove();
    el2.remove();
  });
});
