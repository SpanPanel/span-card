import { escapeHtml } from "./sanitize.js";
import { t, tf } from "../i18n.js";
import type { Circuit, MonitoringPointInfo } from "../types.js";

/**
 * A monitoring rating as the card shows it: what monitoring judges against, the
 * panel's own breaker rating, whether that judgement comes from a package the
 * user copied from the SPAN app, and that package.
 */
export interface RatingView {
  /** What monitoring judges against: both breakers of a copied package where it applies, else the panel's rating. */
  amps: number | null | undefined;
  /** The panel's own breaker rating, null when it publishes none. */
  panelAmps?: number | null;
  /** True when `amps` comes from a copied package rather than the panel's rating. */
  userSet?: boolean;
  /** The package's ratings as the user copied them, in the SPAN app's order; null where there is none. */
  packageRatings?: readonly number[] | null;
}

/**
 * What monitoring judges a circuit against, as the topology reports it: its monitoring rating, null while nothing is
 * judged. A topology from an integration that predates monitoring ratings carries none, and there the judgement is the
 * breaker rating, as it always was.
 */
export function judgedRatingA(circuit: Pick<Circuit | MonitoringPointInfo, "breaker_rating_a" | "monitoring_rating_a">): number | null {
  return (circuit.monitoring_rating_a === undefined ? circuit.breaker_rating_a : circuit.monitoring_rating_a) ?? null;
}

/** The fields a monitoring display reads, on a circuit or a monitoring point. */
export type MonitoringRatingFields = Pick<
  Circuit | MonitoringPointInfo,
  "breaker_rating_a" | "monitoring_rating_a" | "monitoring_rating_user_set" | "package_ratings_a"
>;

/**
 * The rating a circuit's chart limit line and utilization fallback read: its
 * monitoring rating while the circuit is monitored, else the panel's breaker
 * rating. A monitoring rating means nothing while monitoring is off for the
 * circuit, or disabled for the panel, which then reports no status for it; the
 * side panel hides its editor then for the same reason. A status not yet
 * fetched counts as none: the panel's rating is the fact until monitoring is
 * known to judge by another.
 */
export function limitRatingA(
  circuit: Pick<Circuit, "breaker_rating_a" | "monitoring_rating_a">,
  monitoringInfo: Pick<MonitoringPointInfo, "monitoring_enabled"> | null
): number | null {
  const monitored = monitoringInfo !== null && monitoringInfo.monitoring_enabled !== false;
  return monitored ? judgedRatingA(circuit) : (circuit.breaker_rating_a ?? null);
}

/** Where thresholds above 100% under a copy come from: the circuit's own override, or the panel's global settings. */
export type ThresholdWarning = "own" | "global";

/**
 * What the integration says of a circuit's copy of its package from the SPAN app,
 * as a topology circuit and a monitoring status entry both carry it: the form the
 * copy takes and what is done with the one stored.
 */
export type PackageCopyFields = Pick<Circuit | MonitoringPointInfo, "package_ratings_form" | "package_ratings_state">;

const _THRESHOLDS = ["continuous_threshold_pct", "spike_threshold_pct"] as const;

/**
 * Whether monitoring judges the circuit against its copy, or will once the value
 * it waits on arrives. A copy in two spaces never applies, the panel reporting
 * only the average of the circuit's legs, so one waiting is never judged either.
 */
function judgedByCopy(copy: PackageCopyFields): boolean {
  const state = copy.package_ratings_state;
  return state === "applies" || (state === "pending" && copy.package_ratings_form === "one_space");
}

/**
 * Whether a circuit's thresholds, as monitoring resolves them, call for a warning
 * under a copied package, and whose they are; the one rule every view draws the
 * warning by. Thresholds are percentages of the rating a point is judged
 * against, so ones above 100%, as a tandem's may have been raised to quiet its
 * alerts, now apply to both breakers together, which can let a real overload
 * pass. That holds only for a copy monitoring judges by (`judgedByCopy`): one
 * kept on averaged legs changes no threshold's meaning, and offering a reset
 * beside it would bring back the alerts the thresholds were raised to stop. A
 * circuit with an override has its own, which a reset to the global thresholds
 * answers, whatever its values: beside its checked Custom choice, that reset is
 * what the user can act on there. One without has the global ones, which only
 * the global settings change. Null for any other copy, where the integration
 * says nothing of its state, or with every threshold at 100% or below.
 */
export function thresholdWarning(
  copy: PackageCopyFields | null | undefined,
  info: Pick<MonitoringPointInfo, "has_override" | "continuous_threshold_pct" | "spike_threshold_pct"> | null | undefined
): ThresholdWarning | null {
  if (!copy || !info || !judgedByCopy(copy)) return null;
  if (!_THRESHOLDS.some(key => (info[key] ?? 0) > 100)) return null;
  return info.has_override === true ? "own" : "global";
}

/**
 * Whether a circuit's copy calls for the averaged-legs warning, which recommends
 * turning monitoring off: a copy across two spaces, kept without being applied
 * because the panel reports only the average of the circuit's two legs, which
 * can hide an overloaded leg, while the circuit is monitored. Once monitoring is
 * off for it, or while no status says it is monitored, there is nothing to warn of.
 */
export function warnsOfAveragedLegs(
  copy: PackageCopyFields | null | undefined,
  info: Pick<MonitoringPointInfo, "monitoring_enabled"> | null | undefined
): boolean {
  return copy?.package_ratings_state === "averaged_legs" && info != null && info.monitoring_enabled !== false;
}

/**
 * What a monitoring display shows for a circuit or point: the monitoring rating,
 * marked when it comes from a copied package, with the package and the panel's
 * own rating for the mark to name. A status from an integration that predates
 * monitoring ratings carries none, and there it is the breaker rating, as the
 * topology's is (`judgedRatingA`).
 */
export function monitoringRatingView(fields: MonitoringRatingFields | null | undefined): RatingView {
  return {
    amps: fields ? judgedRatingA(fields) : undefined,
    panelAmps: fields?.breaker_rating_a,
    userSet: fields?.monitoring_rating_user_set === true,
    packageRatings: fields?.package_ratings_a ?? null,
  };
}

/**
 * Where a copied rating came from: "20-20 from your SPAN app (the panel publishes
 * 20 A)", the package in the app's order. A view that lacks the package or the
 * panel's rating, which an applying copy always has, says only that it was copied.
 * Plain text, not escaped.
 */
export function copiedSentence(r: RatingView): string {
  if (!r.packageRatings?.length || !r.panelAmps) return t("monitoringRating.copied_unnamed");
  return tf("monitoringRating.copied", { package: r.packageRatings.join("-"), panel: String(r.panelAmps) });
}

/**
 * The rating as a compact label: "20A", or "40A" followed by a pencil mark whose
 * tooltip names the copied package. Empty when there is no rating.
 */
export function ratingLabelHTML(r: RatingView): string {
  if (!r.amps) return "";
  const label = `${escapeHtml(r.amps)}A`;
  return r.userSet ? `${label}${ratingMarkHTML(r)}` : label;
}

/**
 * The pencil that marks a rating from a copied package: a button named by what
 * it marks, the package and the panel's own rating, which it also says as a
 * tooltip, and which a tap or a key press shows in the note after it, where no
 * tooltip can be hovered (`toggleRatingNote`).
 */
export function ratingMarkHTML(r: RatingView): string {
  const text = escapeHtml(copiedSentence(r));
  return (
    `<button type="button" class="rating-user-set" title="${text}" aria-label="${text}" aria-expanded="false">✎</button>` +
    `<span class="rating-copied-note" hidden>${text}</span>`
  );
}

/** Show or hide the note after a rating mark (`ratingMarkHTML`), saying which on the mark. */
export function toggleRatingNote(mark: HTMLElement): void {
  const note = mark.nextElementSibling;
  if (!(note instanceof HTMLElement) || !note.classList.contains("rating-copied-note")) return;
  note.hidden = !note.hidden;
  mark.setAttribute("aria-expanded", String(!note.hidden));
}

/**
 * The side panel's line for what a point is judged against: "Judged against: 20 A",
 * "Judged against: no rating", or for a copied package "Judged against 40 A: 20-20
 * from your SPAN app (the panel publishes 20 A)". Plain text, not escaped.
 */
export function judgedAgainstSentence(r: RatingView): string {
  if (!r.amps) return tf("sidepanel.judged_against", { rating: t("monitoringRating.none") });
  if (!r.userSet) return tf("sidepanel.judged_against", { rating: `${r.amps} A` });
  return tf("monitoringRating.judged_copied", { rating: String(r.amps), copied: copiedSentence(r) });
}
