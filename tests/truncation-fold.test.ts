import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { observeFold } from "../src/core/truncation-fold.js";

/**
 * Truncation-fold tests use a controlled DOM container with .row /
 * .name children whose widths we can mutate to drive the fold state
 * machine. ResizeObserver is shimmed so we can call its callback
 * synchronously instead of waiting for a real layout pass.
 *
 * Pattern: build a fixture, call ``triggerResize()`` to invoke the
 * shim, then assert on ``row.classList.contains('is-folded')``.
 */

interface ROEntry {
  target: Element;
}

interface RO {
  cb: (entries: ROEntry[]) => void;
  observe: (el: Element) => void;
  disconnect: () => void;
  trigger: (els?: Element[]) => void;
}

const ROs: RO[] = [];

function installResizeObserverShim(): void {
  ROs.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    private _cb: (entries: ROEntry[]) => void;
    private _targets: Element[] = [];
    constructor(cb: (entries: ROEntry[]) => void) {
      this._cb = cb;
      const ro: RO = {
        cb,
        observe: (el: Element) => this._targets.push(el),
        disconnect: () => {
          this._targets = [];
        },
        trigger: (els?: Element[]) => {
          const entries = (els ?? this._targets).map(t => ({ target: t }));
          this._cb(entries);
        },
      };
      ROs.push(ro);
      return ro as unknown as ResizeObserver;
    }
  };
}

function makeRow(container: HTMLElement, opts: { rowWidth: number; nameClient: number; nameScroll: number }): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  Object.defineProperty(row, "clientWidth", { value: opts.rowWidth, configurable: true });
  const name = document.createElement("span");
  name.className = "name";
  Object.defineProperty(name, "clientWidth", { value: opts.nameClient, configurable: true });
  Object.defineProperty(name, "scrollWidth", { value: opts.nameScroll, configurable: true });
  row.appendChild(name);
  container.appendChild(row);
  return row;
}

function setRowWidth(row: HTMLElement, rowWidth: number): void {
  Object.defineProperty(row, "clientWidth", { value: rowWidth, configurable: true });
}

function triggerAllResizes(): void {
  for (const ro of ROs) ro.trigger();
}

async function flushRaf(): Promise<void> {
  await new Promise(r => requestAnimationFrame(() => r(undefined)));
}

const CONFIG = {
  rowSelector: ".row",
  nameSelector: ".name",
  foldClass: "is-folded",
};

describe("observeFold", () => {
  let container: HTMLElement;
  let unobserve: () => void;

  beforeEach(() => {
    installResizeObserverShim();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (unobserve) unobserve();
    container.remove();
  });

  it("returns an unobserve function for an empty container", () => {
    unobserve = observeFold(container, CONFIG);
    expect(typeof unobserve).toBe("function");
  });

  it("does not fold when no row truncates", async () => {
    const row = makeRow(container, { rowWidth: 400, nameClient: 100, nameScroll: 100 });
    unobserve = observeFold(container, CONFIG);
    await flushRaf();
    expect(row.classList.contains("is-folded")).toBe(false);
  });

  it("folds every row when any single row truncates", async () => {
    const a = makeRow(container, { rowWidth: 400, nameClient: 100, nameScroll: 100 });
    const b = makeRow(container, { rowWidth: 400, nameClient: 100, nameScroll: 250 }); // truncated
    const c = makeRow(container, { rowWidth: 400, nameClient: 100, nameScroll: 100 });
    unobserve = observeFold(container, CONFIG);
    await flushRaf();
    expect(a.classList.contains("is-folded")).toBe(true);
    expect(b.classList.contains("is-folded")).toBe(true);
    expect(c.classList.contains("is-folded")).toBe(true);
  });

  it("treats a name with zero client width as truncated", async () => {
    const row = makeRow(container, { rowWidth: 400, nameClient: 0, nameScroll: 0 });
    unobserve = observeFold(container, CONFIG);
    await flushRaf();
    expect(row.classList.contains("is-folded")).toBe(true);
  });

  it("does not fold when row width is 0 (mid-render)", async () => {
    const row = makeRow(container, { rowWidth: 0, nameClient: 0, nameScroll: 0 });
    unobserve = observeFold(container, CONFIG);
    await flushRaf();
    expect(row.classList.contains("is-folded")).toBe(false);
  });

  it("hysteresis: stays folded until row width grows past trigger + hysteresisPx", async () => {
    const row = makeRow(container, { rowWidth: 200, nameClient: 60, nameScroll: 200 });
    unobserve = observeFold(container, { ...CONFIG, hysteresisPx: 30 });
    await flushRaf();
    expect(row.classList.contains("is-folded")).toBe(true);

    // Grow to trigger + 10 < hysteresis: still folded
    setRowWidth(row, 220);
    triggerAllResizes();
    expect(row.classList.contains("is-folded")).toBe(true);

    // Grow to trigger + 31 > hysteresis: unfolds
    setRowWidth(row, 231);
    triggerAllResizes();
    expect(row.classList.contains("is-folded")).toBe(false);
  });

  it("hysteresis prevents oscillation around the trigger boundary", async () => {
    const row = makeRow(container, { rowWidth: 200, nameClient: 60, nameScroll: 200 });
    unobserve = observeFold(container, { ...CONFIG, hysteresisPx: 50 });
    await flushRaf();
    expect(row.classList.contains("is-folded")).toBe(true);

    for (let w = 200; w <= 248; w++) {
      setRowWidth(row, w);
      triggerAllResizes();
      // Within hysteresis window — must remain folded.
      expect(row.classList.contains("is-folded")).toBe(true);
    }
  });

  it("re-evaluates when a row resizes via ResizeObserver", async () => {
    const row = makeRow(container, { rowWidth: 400, nameClient: 100, nameScroll: 100 });
    unobserve = observeFold(container, CONFIG);
    await flushRaf();
    expect(row.classList.contains("is-folded")).toBe(false);

    // Simulate the row narrowing — name now overflows.
    setRowWidth(row, 200);
    Object.defineProperty(row.querySelector(".name")!, "clientWidth", { value: 60, configurable: true });
    Object.defineProperty(row.querySelector(".name")!, "scrollWidth", { value: 200, configurable: true });
    triggerAllResizes();
    expect(row.classList.contains("is-folded")).toBe(true);
  });

  it("disconnects both observers when unobserve is called", () => {
    const row = makeRow(container, { rowWidth: 400, nameClient: 100, nameScroll: 100 });
    void row;
    unobserve = observeFold(container, CONFIG);
    const disconnectSpy = vi.fn();
    for (const ro of ROs) {
      const orig = ro.disconnect;
      ro.disconnect = () => {
        disconnectSpy();
        orig();
      };
    }
    unobserve();
    // Re-call should be safe even if observer is gone.
    expect(() => triggerAllResizes()).not.toThrow();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it("picks up rows added after initial attach (MutationObserver path)", async () => {
    unobserve = observeFold(container, CONFIG);
    // Add a row *after* observeFold ran. The container's MutationObserver
    // (childList:true on direct children) should pick it up.
    const wrap = document.createElement("div");
    container.appendChild(wrap);
    makeRow(wrap, { rowWidth: 400, nameClient: 100, nameScroll: 250 });
    // MutationObserver is async; flush a microtask + raf.
    await new Promise(r => setTimeout(r, 0));
    await flushRaf();
    // Every row in the container should now be folded.
    const rows = container.querySelectorAll<HTMLElement>(".row");
    for (const r of rows) expect(r.classList.contains("is-folded")).toBe(true);
  });
});
