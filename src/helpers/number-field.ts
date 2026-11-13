import { tf } from "../i18n.js";
import { isFocused, onLeave } from "./focus.js";

/** A monitored point's threshold or duration, by the name the monitoring services give it. */
export type LimitField = "continuous_threshold_pct" | "spike_threshold_pct" | "window_duration_m" | "cooldown_duration_m";

/** Each threshold and duration's range, as the monitoring services' schemas take it. */
export const LIMIT_RANGES: Readonly<Record<LimitField, { readonly min: number; readonly max: number }>> = {
  continuous_threshold_pct: { min: 1, max: 200 },
  spike_threshold_pct: { min: 1, max: 200 },
  window_duration_m: { min: 1, max: 180 },
  cooldown_duration_m: { min: 1, max: 180 },
};

const LIMIT_FIELDS: readonly LimitField[] = ["continuous_threshold_pct", "spike_threshold_pct", "window_duration_m", "cooldown_duration_m"];

/** Whether `name` is a threshold or duration's service name. */
export function isLimitField(name: string | undefined): name is LimitField {
  return LIMIT_FIELDS.some(field => field === name);
}

/**
 * Keep a number field's value from changing under the wheel: a scroll over the
 * focused field would otherwise step it, and a step is a value nobody entered.
 */
export function guardNumberWheel(input: HTMLInputElement): void {
  input.addEventListener(
    "wheel",
    event => {
      if (isFocused(input)) event.preventDefault();
    },
    { passive: false }
  );
}

/** Where a threshold or duration field's value goes, and where what it needs correcting is said. */
export interface LimitFieldHandlers {
  /** Show `message` with the field, or clear what was shown when it is null. */
  report(message: string | null): void;
  /** Store `amount`, a whole number in the field's range that the user entered. */
  save(amount: number): void;
}

/**
 * Make `input` send a threshold or duration only as the user entered it: when
 * they press Enter or leave the field, never while they type, step or scroll,
 * only where they changed it, and only a whole number in the field's range.
 * Anything else, an emptied field included, is marked invalid, reported, and
 * sent nowhere. The field going from the page, as a redraw takes it, is not the
 * user leaving it (`onLeave`), so nothing half typed is sent then.
 */
export function bindLimitField(input: HTMLInputElement, field: LimitField, handlers: LimitFieldHandlers): void {
  const { min, max } = LIMIT_RANGES[field];
  guardNumberWheel(input);
  let dirty = false;
  const say = (message: string | null): void => {
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    handlers.report(message);
  };
  const commit = (): void => {
    if (!dirty) return;
    const amount = input.value.trim() === "" ? Number.NaN : Number(input.value);
    if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
      say(tf("monitoring.limit_invalid", { min: String(min), max: String(max) }));
      return;
    }
    dirty = false;
    say(null);
    handlers.save(amount);
  };
  input.addEventListener("input", () => {
    dirty = true;
    say(null);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") commit();
  });
  onLeave(input, commit);
}
