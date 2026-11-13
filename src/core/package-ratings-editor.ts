// src/core/package-ratings-editor.ts
import { t, tf } from "../i18n.js";
import { occupiedSpaces, type SlotMember } from "../helpers/shared-meters.js";
import { thresholdWarning, type ThresholdWarning } from "../helpers/monitoring-rating.js";
import { focusedRole, focusWithin, isFocused } from "../helpers/focus.js";
import { guardNumberWheel } from "../helpers/number-field.js";
import type { MonitoringPointInfo } from "../types.js";

/** What the editor draws from: the slot a circuit side panel is open on, and its monitoring. */
export interface PackageRatingsState {
  readonly members: readonly SlotMember[];
  readonly monitoringInfo: MonitoringPointInfo | null;
  /** True where the circuit's panel takes package ratings (topology `monitoring_rating_offered`). */
  readonly offered: boolean;
}

/** What the editor asks of the side panel that holds it. */
export interface PackageRatingsHost {
  /** The state in force now, read whenever the editor acts, so an action follows the latest refresh. */
  readonly ratingsState: PackageRatingsState | null;
  setPackageRatings(uuid: string, ratings: readonly number[]): Promise<void>;
  clearPackageRatings(uuid: string): Promise<void>;
  /** Show why a change failed. */
  reportRatingsFailure(err: unknown): void;
  /** Choose the global thresholds, as the Monitoring section's Global choice does; resolves whether that succeeded. */
  useGlobalThresholds(): Promise<boolean>;
  /** Focus the control after the editor, for when the one focused inside it goes. */
  focusAfterRatingsEditor(): void;
}

type Shape = { readonly kind: "editor" | "multi-space"; readonly member: SlotMember };

/**
 * What the editor shows for a state, or null where it has nothing to offer: the
 * integration takes no package ratings on this panel (or predates them and says
 * nothing), the slot is a shared meter, judged by its group's capacity, or the
 * circuit has no space yet or no panel rating to copy against. A circuit across
 * several spaces gets an explanation in place of the editor.
 */
function shapeOf(state: PackageRatingsState | null): Shape | null {
  if (!state?.offered) return null;
  const [member, ...others] = state.members;
  if (!member || others.length > 0) return null;
  const spaces = occupiedSpaces([member.circuit]);
  if (spaces.length === 0) return null;
  if (spaces.length > 1) return { kind: "multi-space", member };
  if (member.circuit.breaker_rating_a == null) return null;
  return { kind: "editor", member };
}

/** The other breaker of the package stored for a circuit, or null where none is. */
function storedOther(member: SlotMember): number | null {
  return member.circuit.package_ratings_a?.[1] ?? null;
}

/**
 * The Monitoring section's editor for a tandem's ratings copied from the SPAN app.
 *
 * It shows the rating the panel publishes, read-only, which is the package's
 * first, and one field for the other breaker in the space. A value is stored only
 * as the user entered it: when they press Enter or leave the field, never while
 * they type, step or scroll, only where they changed it, and only as a whole
 * number of amps of at least 1; anything else is shown as needing correction and
 * sent nowhere. A refresh patches the editor in place, so a focused control keeps
 * focus and a field being typed in keeps what was typed, while one the user has
 * not touched shows the copy in force; only a change of shape, such as a copy
 * becoming possible, draws it afresh, focus moving to the equivalent control.
 */
export class PackageRatingsEditor {
  private _section: HTMLDivElement | null = null;
  /**
   * Whether the field holds something the user typed and has not committed. Only
   * such a value is sent, so leaving a field nobody touched never re-sends a copy
   * a change elsewhere has replaced, and only such a value survives a refresh.
   */
  private _dirty = false;

  constructor(private readonly _host: PackageRatingsHost) {}

  /** The editor as drawn, or null where there is none. */
  get element(): HTMLDivElement | null {
    return this._section;
  }

  /** Draw the editor for the state in force after `anchor`; used when the Monitoring section is drawn. */
  mount(anchor: Element): void {
    this._dirty = false;
    const shape = shapeOf(this._host.ratingsState);
    this._section = shape ? this._build(shape) : null;
    if (this._section) anchor.after(this._section);
  }

  /**
   * Bring the drawn editor up to the state in force, after `anchor`. The same
   * shape is patched in place; a new one is drawn afresh, focus moving to the
   * same control where there is one, else to the field, else past the editor.
   */
  sync(anchor: Element): void {
    const shape = shapeOf(this._host.ratingsState);
    const old = this._section;
    if (old && shape && old.dataset.kind === shape.kind && old.dataset.uuid === shape.member.uuid) {
      if (shape.kind === "editor") this._patch(old, shape.member);
      return;
    }
    const role = focusedRole(old);
    // A field drawn afresh holds the copy in force, nothing the user typed.
    this._dirty = false;
    const next = shape ? this._build(shape) : null;
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) anchor.after(next);
    this._section = next;
    if (role === null) return;
    const same = next?.querySelector<HTMLElement>(`[data-role="${role}"]`) ?? next?.querySelector<HTMLElement>('[data-role="rating-input"]');
    if (same) same.focus();
    else this._host.focusAfterRatingsEditor();
  }

  // ── Drawing ─────────────────────────────────────────────────────────

  private _build(shape: Shape): HTMLDivElement {
    const section = document.createElement("div");
    section.dataset.role = "rating-section";
    section.dataset.kind = shape.kind;
    section.dataset.uuid = shape.member.uuid;
    section.className = "rating-section";

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = t("monitoringRating.title");
    section.appendChild(label);

    if (shape.kind === "multi-space") {
      // The panel reports a multi-space circuit's legs averaged, which no copied package can be judged against.
      const note = document.createElement("div");
      note.className = "field-label";
      note.dataset.role = "rating-multi-space";
      note.setAttribute("role", "note");
      note.textContent = t("monitoringRating.multi_space");
      section.appendChild(note);
      return section;
    }

    const guidance = document.createElement("div");
    guidance.className = "field-label";
    guidance.id = "rating-guidance";
    guidance.dataset.role = "rating-guidance";
    guidance.textContent = t("monitoringRating.guidance");
    section.appendChild(guidance);

    section.appendChild(this._buildRow(shape.member));

    // Always present, so what it says is announced as it changes.
    const feedback = document.createElement("div");
    feedback.className = "field-label rating-feedback";
    feedback.id = "rating-feedback";
    feedback.dataset.role = "rating-feedback";
    feedback.setAttribute("aria-live", "polite");
    section.appendChild(feedback);

    const warnings = document.createElement("div");
    warnings.dataset.role = "rating-warning-region";
    warnings.setAttribute("aria-live", "polite");
    section.appendChild(warnings);
    this._syncWarning(section, shape.member);
    return section;
  }

  private _buildRow(member: SlotMember): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "field-row rating-row";
    row.dataset.role = "rating-row";
    row.dataset.uuid = member.uuid;

    const panelEl = document.createElement("span");
    panelEl.className = "field-label";
    panelEl.id = "rating-panel-rating";
    panelEl.dataset.role = "rating-panel-rating";
    panelEl.textContent = tf("monitoringRating.panel_rating", { panel: String(member.circuit.breaker_rating_a) });

    const labelEl = document.createElement("span");
    labelEl.className = "field-label";
    labelEl.textContent = t("monitoringRating.other_breaker");

    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.inputMode = "numeric";
    const stored = storedOther(member);
    input.value = stored !== null ? String(stored) : "";
    input.setAttribute("aria-label", tf("monitoringRating.other_breaker_label", { circuit: member.circuit.name }));
    input.setAttribute("aria-describedby", "rating-panel-rating rating-guidance rating-feedback");
    input.dataset.role = "rating-input";
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") this._commit(input);
    });
    input.addEventListener("blur", () => this._commit(input));
    input.addEventListener("input", () => {
      this._dirty = true;
      this._showFeedback(input, null);
    });
    guardNumberWheel(input);

    row.append(panelEl, labelEl, input);
    if (stored !== null) row.appendChild(this._buildReset(member.uuid));
    return row;
  }

  private _buildReset(uuid: string): HTMLButtonElement {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "text-btn";
    reset.dataset.role = "rating-reset";
    reset.textContent = t("monitoringRating.reset");
    reset.addEventListener("click", () => {
      // What the field held goes with the copy, a value needing correction and what was said of it included.
      this._dirty = false;
      const input = this._section?.querySelector<HTMLInputElement>('[data-role="rating-input"]');
      const shape = shapeOf(this._host.ratingsState);
      if (input) {
        this._showFeedback(input, null);
        const stored = shape?.kind === "editor" ? storedOther(shape.member) : null;
        input.value = stored !== null ? String(stored) : "";
      }
      this._host.clearPackageRatings(uuid).catch((err: unknown) => this._host.reportRatingsFailure(err));
    });
    return reset;
  }

  /** Bring an editor of the same shape up to the circuit's state, in place. */
  private _patch(section: HTMLDivElement, member: SlotMember): void {
    const stored = storedOther(member);

    const panelEl = section.querySelector<HTMLElement>('[data-role="rating-panel-rating"]');
    if (panelEl) panelEl.textContent = tf("monitoringRating.panel_rating", { panel: String(member.circuit.breaker_rating_a) });

    const input = section.querySelector<HTMLInputElement>('[data-role="rating-input"]');
    // A value the user typed is theirs, focused or not, a value needing correction included; any other shows the copy.
    if (input && !this._dirty) input.value = stored !== null ? String(stored) : "";

    const row = section.querySelector<HTMLElement>('[data-role="rating-row"]');
    const reset = section.querySelector<HTMLElement>('[data-role="rating-reset"]');
    if (stored === null && reset) {
      if (isFocused(reset)) input?.focus();
      reset.remove();
    } else if (stored !== null && !reset && row) {
      row.appendChild(this._buildReset(member.uuid));
    }
    this._syncWarning(section, member);
  }

  // ── Committing ──────────────────────────────────────────────────────

  /** Send what the user typed in the field, where it is a valid other breaker the copy does not already hold. */
  private _commit(input: HTMLInputElement): void {
    if (!this._dirty) return;
    const shape = shapeOf(this._host.ratingsState);
    if (shape?.kind !== "editor") return;
    const { member } = shape;
    const panel = member.circuit.breaker_rating_a;
    if (panel == null) return;
    const stored = storedOther(member);

    const raw = input.value.trim();
    // A browser empties a number field holding text it cannot read, and says so here.
    if (raw === "" && input.validity?.badInput) {
      this._showFeedback(input, t("monitoringRating.invalid_other"));
      return;
    }
    if (raw === "") {
      // Nothing entered: the field shows the copy in force; removing it is the reset's.
      this._dirty = false;
      this._showFeedback(input, null);
      input.value = stored !== null ? String(stored) : "";
      return;
    }
    const amps = Number(raw);
    if (!Number.isSafeInteger(amps) || amps < 1) {
      this._showFeedback(input, t("monitoringRating.invalid_other"));
      return;
    }
    this._dirty = false;
    this._showFeedback(input, null);
    if (amps === stored) return;
    this._host.setPackageRatings(member.uuid, [panel, amps]).catch((err: unknown) => {
      this._host.reportRatingsFailure(err);
      this._answerRefusal(member.uuid, amps);
    });
  }

  /**
   * Put the copy in force back in the field after `amps` was refused for circuit
   * `uuid`, unless the editor now shows another circuit, or the user has typed
   * since, which is theirs. Focus goes to the field where it was in the editor or
   * nowhere, so the value can be corrected.
   */
  private _answerRefusal(uuid: string, amps: number): void {
    const section = this._section;
    const input = section?.querySelector<HTMLInputElement>('[data-role="rating-input"]');
    const shape = shapeOf(this._host.ratingsState);
    if (!section || !input || shape?.kind !== "editor" || shape.member.uuid !== uuid || section.dataset.uuid !== uuid) return;
    if (this._dirty || input.value.trim() !== String(amps)) return;
    const stored = storedOther(shape.member);
    input.value = stored !== null ? String(stored) : "";
    // Focus lost, as to the page's body, or still in the editor: the field, to correct. Anywhere else is the user's.
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost || focusWithin(section)) input.focus();
  }

  private _showFeedback(input: HTMLInputElement, message: string | null): void {
    const feedback = this._section?.querySelector<HTMLElement>('[data-role="rating-feedback"]');
    if (feedback) feedback.textContent = message ?? "";
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  // ── The threshold warning ───────────────────────────────────────────

  /**
   * A warning where a copied package is stored and the thresholds the circuit is
   * judged by exceed 100% (`thresholdWarning`): for its own override, with a reset
   * to the global thresholds; for the global ones, pointing to the global
   * settings, which a reset here would not change. The copy changes no threshold itself;
   * the user chooses. Re-read on every sync, so it follows a threshold change.
   */
  private _syncWarning(section: HTMLDivElement, member: SlotMember): void {
    const region = section.querySelector<HTMLElement>('[data-role="rating-warning-region"]');
    if (!region) return;
    const state = this._host.ratingsState;
    const wanted = thresholdWarning(member.circuit.package_ratings_a, state?.monitoringInfo);
    const current = region.querySelector<HTMLElement>('[data-role="rating-threshold-warning"]');
    if (current && current.dataset.kind === wanted) return;
    const hadFocus = focusWithin(current);
    current?.remove();
    if (wanted) region.appendChild(this._buildWarning(wanted));
    if (hadFocus) this._host.focusAfterRatingsEditor();
  }

  private _buildWarning(kind: ThresholdWarning): HTMLDivElement {
    const warning = document.createElement("div");
    warning.className = "field-label rating-warning";
    warning.dataset.role = "rating-threshold-warning";
    warning.dataset.kind = kind;
    warning.setAttribute("role", "note");

    const text = document.createElement("span");
    text.textContent =
      kind === "own"
        ? t("monitoringRating.threshold_warning")
        : tf("monitoringRating.threshold_warning_global", { settings: t("monitoring.global_settings"), tab: t("tab.monitoring") });
    warning.appendChild(text);
    if (kind === "global") return warning;

    const useGlobal = document.createElement("button");
    useGlobal.type = "button";
    useGlobal.className = "text-btn";
    useGlobal.dataset.role = "rating-threshold-reset";
    useGlobal.textContent = t("monitoringRating.use_global_thresholds");
    useGlobal.addEventListener("click", () => {
      // Busy, not disabled: a disabled button loses focus, and focus is to follow the reset.
      if (useGlobal.getAttribute("aria-disabled") === "true") return;
      useGlobal.setAttribute("aria-disabled", "true");
      void this._host.useGlobalThresholds().then(done => {
        if (!done) useGlobal.removeAttribute("aria-disabled");
      });
    });
    warning.appendChild(useGlobal);
    return warning;
  }
}
