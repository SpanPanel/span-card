import { describe, it, expect, afterEach, vi } from "vitest";
import { bindOtherBreakerField, type OtherBreakerFieldHandle } from "../src/helpers/other-breaker-field.js";
import { t } from "../src/i18n.js";
import { blurOnRemoval } from "./removal-blur.js";

const INVALID = t("monitoringRating.invalid_other");

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

interface Bound {
  input: HTMLInputElement;
  handle: OtherBreakerFieldHandle;
  report: ReturnType<typeof vi.fn<(message: string | null) => void>>;
  save: ReturnType<typeof vi.fn<(amps: number) => void>>;
  /** Change the other breaker of the copy in force, as a refresh would. */
  store(amps: number | null): void;
}

/**
 * A number field bound as a host binds it, showing `stored`. It is drawn in a
 * shadow root: happy-dom's document is no `Document`, so focus is read there.
 */
function bound(stored: number | null = null): Bound {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const input = document.createElement("input");
  input.type = "number";
  input.value = stored !== null ? String(stored) : "";
  shadow.appendChild(input);
  document.body.appendChild(host);
  mounted.push(host);
  let inForce = stored;
  const report = vi.fn<(message: string | null) => void>();
  const save = vi.fn<(amps: number) => void>();
  const handle = bindOtherBreakerField(input, { report, stored: () => inForce, save });
  return {
    input,
    handle,
    report,
    save,
    store: amps => {
      inForce = amps;
    },
  };
}

/** Type `value` into the field, as keystrokes do, without committing it. */
function typeOnly(el: HTMLInputElement, value: string): void {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

function enter(el: HTMLInputElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
}

/** Leave the field, and let the leave land: it is read a microtask on, once a removal would be over. */
async function leave(el: HTMLInputElement): Promise<void> {
  el.blur();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** What the field last said, null where it said nothing or cleared it. */
const said = (b: Bound): string | null | undefined => b.report.mock.lastCall?.[0];

describe("committing the other breaker", () => {
  it("saves what was typed when Enter is pressed, once", async () => {
    const b = bound();
    typeOnly(b.input, "30");
    expect(b.save).not.toHaveBeenCalled();
    enter(b.input);
    await leave(b.input);
    expect(b.save.mock.calls).toEqual([[30]]);
  });

  it("saves what was typed when the field is left, once", async () => {
    const b = bound();
    typeOnly(b.input, "30");
    await leave(b.input);
    expect(b.save.mock.calls).toEqual([[30]]);
  });

  it("saves nothing on leaving a field nobody typed in", async () => {
    const b = bound(30);
    b.input.focus();
    await leave(b.input);
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();
    expect(b.report).not.toHaveBeenCalled();
  });

  it("saves nothing as the field goes from the page, which is not the user leaving it", async () => {
    const b = bound();
    typeOnly(b.input, "30");
    const blurred = vi.fn();
    b.input.addEventListener("blur", blurred);

    // Chromium blurs the focused field as it is removed, before it is detached; happy-dom does not without this.
    const undo = blurOnRemoval();
    try {
      b.input.remove();
    } finally {
      undo();
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(blurred).toHaveBeenCalled();
    expect(b.save).not.toHaveBeenCalled();
  });

  it("saves a value typed after the copy in force changed, read when it is committed", () => {
    const b = bound(30);
    typeOnly(b.input, "25");
    b.store(25);
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();
    typeOnly(b.input, "30");
    enter(b.input);
    expect(b.save.mock.calls).toEqual([[30]]);
  });
});

describe("a value that needs correcting", () => {
  it.each(["0", "2.5", "-3", "1e30"])("%j is reported, marked invalid and never saved", async value => {
    const b = bound();
    typeOnly(b.input, value);
    enter(b.input);
    await leave(b.input);
    expect(b.save).not.toHaveBeenCalled();
    expect(said(b)).toBe(INVALID);
    expect(b.input.getAttribute("aria-invalid")).toBe("true");
    expect(b.handle.dirty).toBe(true);
  });

  it("is reported where the browser holds back text a number field cannot read, leaving the field as it is", () => {
    const b = bound(30);
    typeOnly(b.input, "");
    Object.defineProperty(b.input, "validity", { value: { badInput: true } });
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();
    expect(said(b)).toBe(INVALID);
    expect(b.input.getAttribute("aria-invalid")).toBe("true");
    expect(b.input.value).toBe("");
  });

  it("is cleared once the user types again, and a corrected value is saved", () => {
    const b = bound();
    typeOnly(b.input, "2.5");
    enter(b.input);
    typeOnly(b.input, "3");
    expect(said(b)).toBeNull();
    expect(b.input.hasAttribute("aria-invalid")).toBe(false);
    enter(b.input);
    expect(b.save.mock.calls).toEqual([[3]]);
  });
});

describe("a commit that stores nothing", () => {
  it("puts the copy in force back where the field was emptied", async () => {
    const b = bound(30);
    typeOnly(b.input, "");
    await leave(b.input);
    expect(b.save).not.toHaveBeenCalled();
    expect(b.input.value).toBe("30");
    expect(b.handle.dirty).toBe(false);
    expect(said(b)).toBeNull();
  });

  it("leaves an emptied field empty where no copy is in force", () => {
    const b = bound();
    typeOnly(b.input, "");
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();
    expect(b.input.value).toBe("");
  });

  it("is the copy already in force typed again", () => {
    const b = bound(30);
    typeOnly(b.input, "30");
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();
    expect(b.handle.dirty).toBe(false);
    expect(b.input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("the handle", () => {
  it("is dirty from the first keystroke until a commit takes it", () => {
    const b = bound();
    expect(b.handle.dirty).toBe(false);
    typeOnly(b.input, "3");
    expect(b.handle.dirty).toBe(true);
    typeOnly(b.input, "30");
    enter(b.input);
    expect(b.handle.dirty).toBe(false);
  });

  it("reverts to the copy in force, dropping what was typed and what was said of it", () => {
    const b = bound(30);
    typeOnly(b.input, "2.5");
    enter(b.input);
    b.store(25);

    b.handle.revert();

    expect(b.handle.dirty).toBe(false);
    expect(b.input.value).toBe("25");
    expect(said(b)).toBeNull();
    expect(b.input.hasAttribute("aria-invalid")).toBe(false);
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();
  });

  it("reverts to an empty field where no copy is in force", () => {
    const b = bound(30);
    typeOnly(b.input, "40");
    b.store(null);
    b.handle.revert();
    expect(b.input.value).toBe("");
  });
});

describe("answering a refusal", () => {
  it("puts the copy in force back where the field still shows the value refused, and says it did", () => {
    const b = bound(30);
    typeOnly(b.input, "90");
    enter(b.input);

    expect(b.handle.answerRefusal(90)).toBe(true);

    expect(b.input.value).toBe("30");
    expect(b.handle.dirty).toBe(false);
  });

  it("reads the copy in force when the refusal lands, not when the value was saved", () => {
    const b = bound(30);
    typeOnly(b.input, "90");
    enter(b.input);
    b.store(15);

    expect(b.handle.answerRefusal(90)).toBe(true);
    expect(b.input.value).toBe("15");
  });

  it("knows the value saved by its amps, not by how it was typed", () => {
    const b = bound(30);
    typeOnly(b.input, "090");
    enter(b.input);
    expect(b.save.mock.calls).toEqual([[90]]);

    expect(b.handle.answerRefusal(90)).toBe(true);
    expect(b.input.value).toBe("30");
  });

  it("leaves what the user has typed since, which is theirs", () => {
    const b = bound(30);
    typeOnly(b.input, "90");
    enter(b.input);
    typeOnly(b.input, "9");

    expect(b.handle.answerRefusal(90)).toBe(false);
    expect(b.input.value).toBe("9");
    expect(b.handle.dirty).toBe(true);
  });

  it("leaves a value saved since, until that one is refused too", () => {
    const b = bound(30);
    typeOnly(b.input, "90");
    enter(b.input);
    typeOnly(b.input, "25");
    enter(b.input);

    expect(b.handle.answerRefusal(90)).toBe(false);
    expect(b.input.value).toBe("25");
    expect(b.handle.answerRefusal(25)).toBe(true);
    expect(b.input.value).toBe("30");
  });

  it("does nothing once the field shows the copy in force again, as after the ✕ or a refresh", () => {
    const b = bound(30);
    typeOnly(b.input, "90");
    enter(b.input);
    b.store(null);
    b.handle.revert();
    b.store(15);

    expect(b.handle.answerRefusal(90)).toBe(false);
    expect(b.input.value).toBe("");
  });

  it("does nothing for a value the field never saved", () => {
    const b = bound(30);
    typeOnly(b.input, "30");
    enter(b.input);
    expect(b.save).not.toHaveBeenCalled();

    expect(b.handle.answerRefusal(30)).toBe(false);
    expect(b.handle.answerRefusal(90)).toBe(false);
    expect(b.input.value).toBe("30");
  });
});

describe("the wheel over the field", () => {
  it("does not step the focused field", () => {
    const b = bound(30);
    b.input.focus();
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    b.input.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(b.input.value).toBe("30");
    expect(b.handle.dirty).toBe(false);
  });

  it("is left alone over a field that is not focused, so the page scrolls", () => {
    const b = bound(30);
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    b.input.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });
});
