import { t } from "../i18n.js";
import { onLeave } from "./focus.js";
import { guardNumberWheel } from "./number-field.js";

/** Where an other-breaker field's value goes, what it is checked against, and where what it needs correcting is said. */
export interface OtherBreakerFieldHandlers {
  /** Show `message` under the field, or clear it when null. */
  report(message: string | null): void;
  /** The other breaker of the copy in force, read at commit time; null where none. */
  stored(): number | null;
  /** Store `amps`, a whole number ≥ 1 the user entered that differs from `stored()`. */
  save(amps: number): void;
}

/** A bound other-breaker field, as its host reads it. */
export interface OtherBreakerFieldHandle {
  /**
   * Whether the field holds something the user typed and has not committed. Only
   * such a value is sent, so leaving a field nobody touched never re-sends a copy
   * a change elsewhere has replaced, and only such a value is the user's to keep
   * across a refresh.
   */
  readonly dirty: boolean;
  /** Drop what was typed and show the copy in force (the ✕ and a refresh use this). */
  revert(): void;
  /**
   * Answer the refusal of `amps`, a value this field saved: show the copy in
   * force again, read now, where the field still shows the value refused. Where
   * the user has typed or saved since, what the field shows is theirs, and where
   * it shows the copy in force again, as after the ✕ or a refresh, there is
   * nothing to put back. Returns whether it put the copy back, so the host can
   * give the field focus to correct it.
   */
  answerRefusal(amps: number): boolean;
}

/**
 * Make `input` the field for the other breaker of a package copied from the SPAN
 * app, wherever it is drawn. A value is stored only as the user entered it: when
 * they press Enter or leave the field, never while they type, step or scroll,
 * only where they changed it, and only as a whole number of amps of at least 1
 * that the copy in force does not already hold. Anything else is marked invalid,
 * reported, and sent nowhere; an emptied field shows the copy in force again,
 * removing it being the ✕'s. The field going from the page, as a redraw takes
 * it, is not the user leaving it (`onLeave`), so nothing half typed is sent then.
 */
export function bindOtherBreakerField(input: HTMLInputElement, handlers: OtherBreakerFieldHandlers): OtherBreakerFieldHandle {
  guardNumberWheel(input);
  let dirty = false;
  /** The amps the field shows as the user saved them, until they type again or it shows the copy in force; null otherwise. */
  let saved: number | null = null;
  const say = (message: string | null): void => {
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    handlers.report(message);
  };
  const revert = (): void => {
    dirty = false;
    saved = null;
    say(null);
    const stored = handlers.stored();
    input.value = stored !== null ? String(stored) : "";
  };
  const commit = (): void => {
    if (!dirty) return;
    const raw = input.value.trim();
    // A browser empties a number field holding text it cannot read, and says so here.
    if (raw === "" && input.validity?.badInput) {
      say(t("monitoringRating.invalid_other"));
      return;
    }
    if (raw === "") {
      revert();
      return;
    }
    const amps = Number(raw);
    if (!Number.isSafeInteger(amps) || amps < 1) {
      say(t("monitoringRating.invalid_other"));
      return;
    }
    dirty = false;
    say(null);
    if (amps === handlers.stored()) return;
    saved = amps;
    handlers.save(amps);
  };
  input.addEventListener("input", () => {
    dirty = true;
    saved = null;
    say(null);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") commit();
  });
  onLeave(input, commit);
  return {
    get dirty(): boolean {
      return dirty;
    },
    revert,
    answerRefusal: amps => {
      if (saved !== amps) return false;
      revert();
      return true;
    },
  };
}
