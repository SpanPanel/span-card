// src/core/package-ratings-editor.ts
import { t, tf } from "../i18n.js";
import type { SlotMember } from "../helpers/shared-meters.js";
import { thresholdWarning, warnsOfAveragedLegs, type ThresholdWarning } from "../helpers/monitoring-rating.js";
import { focusedRole, focusWithin, isFocused } from "../helpers/focus.js";
import { bindOtherBreakerField, type OtherBreakerFieldHandle } from "../helpers/other-breaker-field.js";
import type { MonitoringPointInfo, PackageRatingsForm } from "../types.js";

/** What the editor draws from: the slot a circuit side panel is open on, and its monitoring. */
export interface PackageRatingsView {
  readonly members: readonly SlotMember[];
  readonly monitoringInfo: MonitoringPointInfo | null;
  /** True where the circuit's panel takes package ratings (topology `monitoring_rating_offered`). */
  readonly offered: boolean;
}

/** What the editor asks of the side panel that holds it. */
export interface PackageRatingsHost {
  /** The view in force now, read whenever the editor acts, so an action follows the latest refresh. */
  readonly ratingsView: PackageRatingsView | null;
  setPackageRatings(uuid: string, ratings: readonly number[]): Promise<void>;
  clearPackageRatings(uuid: string): Promise<void>;
  /** Show why a change failed. */
  reportRatingsFailure(err: unknown): void;
  /** Choose the global thresholds, as the Monitoring section's Global choice does; resolves whether that succeeded. */
  useGlobalThresholds(): Promise<boolean>;
  /** Turn monitoring off for the circuit, as the Monitoring section's switch does; resolves whether that succeeded. */
  turnOffMonitoring(): Promise<boolean>;
  /** Focus the control after the editor, for when the one focused inside it goes. */
  focusAfterRatingsEditor(): void;
}

/** The editor for one circuit: the form its copy takes, and the panel's rating, the copy's first. */
type Shape = { readonly kind: PackageRatingsForm; readonly member: SlotMember; readonly panelA: number };

/** The warning a stored copy calls for, by the rules the Monitoring tab draws its own by. */
type Warning = ThresholdWarning | "averaged_legs";

/**
 * What the editor shows for a view, or null where it has nothing to offer.
 * Whether a circuit takes a copy, and in which form, is the integration's to say
 * (`package_ratings_form`), so every view draws the same fields: the editor draws
 * one exactly where a form is named, and nothing where none is, or where an
 * integration that predates forms says nothing, or that predates package ratings
 * offers none on the panel. The editor holds one circuit's copy, so a slot of
 * several sharing a meter, judged by their group's capacity, draws none; the
 * integration names no form for those. A form is named only where the panel
 * rates the circuit, whose rating is the copy's first.
 */
function shapeOf(view: PackageRatingsView | null): Shape | null {
  if (!view?.offered) return null;
  const [member, ...others] = view.members;
  if (!member || others.length > 0) return null;
  const kind = member.circuit.package_ratings_form;
  const panelA = member.circuit.breaker_rating_a;
  if ((kind !== "one_space" && kind !== "two_spaces") || panelA == null) return null;
  return { kind, member, panelA };
}

/** The other breaker of the package stored for a circuit, or null where none is. */
function storedOther(member: SlotMember): number | null {
  return member.circuit.package_ratings_a?.[1] ?? null;
}

/** The guidance for a copy of this form, as approved for the side panel (spec §14.6). */
function guidanceText(kind: PackageRatingsForm): string {
  return kind === "one_space" ? t("monitoringRating.guidance") : t("monitoringRating.guidance_two_spaces");
}

/**
 * The warning a circuit's stored copy calls for: the averaged-legs one for a copy
 * kept across two spaces while the circuit is monitored, else the threshold one
 * for a copy monitoring judges by (`thresholdWarning`); null for none.
 */
function warningFor(member: SlotMember, info: MonitoringPointInfo | null): Warning | null {
  if (warnsOfAveragedLegs(member.circuit, info)) return "averaged_legs";
  return thresholdWarning(member.circuit, info);
}

/**
 * The Monitoring section's editor for a package's ratings copied from the SPAN app.
 *
 * It shows the rating the panel publishes, read-only, which is the package's
 * first, and one field for the other breaker, which stores a value only as the
 * user entered it (`bindOtherBreakerField`). A copy in one space is judged; one
 * across two spaces is kept without being applied, and the editor recommends
 * turning monitoring off for that circuit, with a button that does it. A refresh
 * patches the editor in place, so a focused control keeps focus and a field
 * being typed in keeps what was typed, while one the user has not touched shows
 * the copy in force; only a change of shape, such as another form, draws it
 * afresh, focus moving to the equivalent control.
 */
export class PackageRatingsEditor {
  private _section: HTMLDivElement | null = null;
  /** The drawn editor's other-breaker field, or null where it draws none. */
  private _field: OtherBreakerFieldHandle | null = null;

  constructor(private readonly _host: PackageRatingsHost) {}

  /** The editor as drawn, or null where there is none. */
  get element(): HTMLDivElement | null {
    return this._section;
  }

  /** Draw the editor for the view in force after `anchor`; used when the Monitoring section is drawn. */
  mount(anchor: Element): void {
    this._field = null;
    const shape = shapeOf(this._host.ratingsView);
    this._section = shape ? this._build(shape) : null;
    if (this._section) anchor.after(this._section);
  }

  /**
   * Bring the drawn editor up to the view in force, after `anchor`. The same
   * shape is patched in place; a new one is drawn afresh, focus moving to the
   * same control where there is one, else to the field, else past the editor.
   */
  sync(anchor: Element): void {
    const shape = shapeOf(this._host.ratingsView);
    const old = this._section;
    if (old && shape && old.dataset.kind === shape.kind && old.dataset.uuid === shape.member.uuid) {
      this._patch(old, shape);
      return;
    }
    const role = focusedRole(old);
    // A field drawn afresh holds the copy in force, nothing the user typed.
    this._field = null;
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

    const guidance = document.createElement("div");
    guidance.className = "field-label";
    guidance.id = "rating-guidance";
    guidance.dataset.role = "rating-guidance";
    guidance.textContent = guidanceText(shape.kind);
    section.appendChild(guidance);

    // Always present, so what it says is announced as it changes.
    const feedback = document.createElement("div");
    feedback.className = "field-label rating-feedback";
    feedback.id = "rating-feedback";
    feedback.dataset.role = "rating-feedback";
    feedback.setAttribute("aria-live", "polite");

    section.appendChild(this._buildRow(shape, feedback));
    section.appendChild(feedback);

    const warnings = document.createElement("div");
    warnings.dataset.role = "rating-warning-region";
    warnings.setAttribute("aria-live", "polite");
    section.appendChild(warnings);
    this._syncWarning(section, shape.member);
    return section;
  }

  /** The row of the panel's rating and the other breaker's field, which says what it needs correcting in `feedback`. */
  private _buildRow(shape: Shape, feedback: HTMLElement): HTMLDivElement {
    const { member } = shape;
    const row = document.createElement("div");
    row.className = "field-row rating-row";
    row.dataset.role = "rating-row";
    row.dataset.uuid = member.uuid;

    const panelEl = document.createElement("span");
    panelEl.className = "field-label";
    panelEl.id = "rating-panel-rating";
    panelEl.dataset.role = "rating-panel-rating";
    panelEl.textContent = tf("monitoringRating.panel_rating", { panel: String(shape.panelA) });

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
    this._field = bindOtherBreakerField(input, {
      report: message => {
        feedback.textContent = message ?? "";
      },
      stored: () => this._storedInForce(),
      save: amps => this._save(amps),
    });

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
      this._field?.revert();
      this._host.clearPackageRatings(uuid).catch((err: unknown) => this._host.reportRatingsFailure(err));
    });
    return reset;
  }

  /** Bring an editor of the same shape up to the circuit's state, in place. */
  private _patch(section: HTMLDivElement, shape: Shape): void {
    const { member } = shape;
    const stored = storedOther(member);

    const panelEl = section.querySelector<HTMLElement>('[data-role="rating-panel-rating"]');
    if (panelEl) panelEl.textContent = tf("monitoringRating.panel_rating", { panel: String(shape.panelA) });

    const input = section.querySelector<HTMLInputElement>('[data-role="rating-input"]');
    // A value the user typed is theirs, focused or not, a value needing correction included; any other shows the copy.
    if (this._field && !this._field.dirty) this._field.revert();

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

  /** The other breaker of the copy in force for the view in force, or null where none is or the editor has no field. */
  private _storedInForce(): number | null {
    const shape = shapeOf(this._host.ratingsView);
    return shape ? storedOther(shape.member) : null;
  }

  /** Send the package with `amps`, an other breaker the user committed, for the circuit the view in force has the field for. */
  private _save(amps: number): void {
    const shape = shapeOf(this._host.ratingsView);
    if (!shape) return;
    const { member, panelA } = shape;
    this._host.setPackageRatings(member.uuid, [panelA, amps]).catch((err: unknown) => {
      this._host.reportRatingsFailure(err);
      this._answerRefusal(member.uuid, amps);
    });
  }

  /**
   * Answer the refusal of `amps` for circuit `uuid` while the editor still shows
   * that circuit: the field puts the copy in force back where it still shows the
   * value refused (`answerRefusal`). Focus then goes to the field where it was in
   * the editor or nowhere, so the value can be corrected.
   */
  private _answerRefusal(uuid: string, amps: number): void {
    const section = this._section;
    const input = section?.querySelector<HTMLInputElement>('[data-role="rating-input"]');
    const field = this._field;
    if (!section || !input || !field || section.dataset.uuid !== uuid || shapeOf(this._host.ratingsView)?.member.uuid !== uuid) return;
    if (!field.answerRefusal(amps)) return;
    // Focus lost, as to the page's body, or still in the editor: the field, to correct. Anywhere else is the user's.
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (lost || focusWithin(section)) input.focus();
  }

  // ── Warnings ────────────────────────────────────────────────────────

  /**
   * The warning a stored copy calls for, re-read on every sync, so it follows a
   * threshold change, the copy's state, and monitoring turned on or off. Where a
   * copy is judged and the thresholds the circuit is judged by exceed 100%: for
   * its own override, with a reset to the global thresholds; for the global ones,
   * pointing to the global settings, which a reset here would not change. Where a
   * copy across two spaces is kept on averaged legs: a recommendation to turn
   * monitoring off, with a button that does it. The copy changes no threshold and
   * no monitoring itself; the user chooses.
   */
  private _syncWarning(section: HTMLDivElement, member: SlotMember): void {
    const region = section.querySelector<HTMLElement>('[data-role="rating-warning-region"]');
    if (!region) return;
    const wanted = warningFor(member, this._host.ratingsView?.monitoringInfo ?? null);
    const current = region.firstElementChild instanceof HTMLElement ? region.firstElementChild : null;
    if (current && current.dataset.kind === wanted) return;
    const hadFocus = focusWithin(current);
    current?.remove();
    if (wanted) region.appendChild(wanted === "averaged_legs" ? this._buildAveragedLegsWarning() : this._buildThresholdWarning(wanted));
    if (hadFocus) this._host.focusAfterRatingsEditor();
  }

  private _buildThresholdWarning(kind: ThresholdWarning): HTMLDivElement {
    const text =
      kind === "own"
        ? t("monitoringRating.threshold_warning")
        : tf("monitoringRating.threshold_warning_global", { settings: t("monitoring.global_settings"), tab: t("tab.monitoring") });
    const warning = this._buildWarning("rating-threshold-warning", kind, text);
    if (kind === "own") {
      warning.appendChild(
        this._buildActionButton("rating-threshold-reset", t("monitoringRating.use_global_thresholds"), () => this._host.useGlobalThresholds())
      );
    }
    return warning;
  }

  private _buildAveragedLegsWarning(): HTMLDivElement {
    const warning = this._buildWarning("rating-averaged-legs-warning", "averaged_legs", t("monitoringRating.averaged_legs"));
    warning.appendChild(this._buildActionButton("rating-turn-off-monitoring", t("monitoringRating.turn_off_monitoring"), () => this._host.turnOffMonitoring()));
    return warning;
  }

  private _buildWarning(role: string, kind: Warning, text: string): HTMLDivElement {
    const warning = document.createElement("div");
    warning.className = "field-label rating-warning";
    warning.dataset.role = role;
    warning.dataset.kind = kind;
    warning.setAttribute("role", "note");
    const span = document.createElement("span");
    span.textContent = text;
    warning.appendChild(span);
    return warning;
  }

  /**
   * A warning's button for an action the host carries out. While it is in
   * flight the button is busy, not disabled: a disabled button loses focus, and
   * focus is to follow the action. A second press then does nothing. It stays
   * busy once the action succeeds, the warning going with what it warned of, and
   * is ready again where it fails.
   */
  private _buildActionButton(role: string, label: string, act: () => Promise<boolean>): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-btn";
    button.dataset.role = role;
    button.textContent = label;
    button.addEventListener("click", () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      button.setAttribute("aria-disabled", "true");
      void act().then(done => {
        if (!done) button.removeAttribute("aria-disabled");
      });
    });
    return button;
  }
}
