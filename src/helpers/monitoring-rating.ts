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
export function judgedRatingA(circuit: Pick<Circuit, "breaker_rating_a" | "monitoring_rating_a">): number | null {
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

/**
 * What a monitoring display shows for a circuit or point: the monitoring rating,
 * marked when it comes from a copied package, with the package and the panel's
 * own rating for the mark to name.
 */
export function monitoringRatingView(fields: MonitoringRatingFields | null | undefined): RatingView {
  return {
    amps: fields?.monitoring_rating_a,
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

/** The pencil that marks a rating from a copied package, its tooltip naming the package and the panel's own rating. */
export function ratingMarkHTML(r: RatingView): string {
  return `<span class="rating-user-set" title="${escapeHtml(copiedSentence(r))}">✎</span>`;
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
