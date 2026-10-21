import { escapeHtml } from "./sanitize.js";
import { t, tf } from "../i18n.js";
import type { Circuit, MonitoringPointInfo } from "../types.js";

/**
 * A monitoring rating as the card shows it: what monitoring judges against, the
 * panel's own breaker rating, and whether the user set the monitoring rating.
 */
export interface RatingView {
  /** What monitoring judges against: the user's value where one applies, else the panel's. */
  amps: number | null | undefined;
  /** The panel's own breaker rating, null when it publishes none. */
  panelAmps?: number | null;
  /** True when `amps` is the user's value rather than the panel's. */
  userSet?: boolean;
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
export type MonitoringRatingFields = Pick<Circuit | MonitoringPointInfo, "breaker_rating_a" | "monitoring_rating_a" | "monitoring_rating_user_set">;

/**
 * What a monitoring display shows for a circuit or point: the monitoring rating,
 * marked when the user set it, with the panel's own rating for the mark to name.
 */
export function monitoringRatingView(fields: MonitoringRatingFields | null | undefined): RatingView {
  return { amps: fields?.monitoring_rating_a, panelAmps: fields?.breaker_rating_a, userSet: fields?.monitoring_rating_user_set === true };
}

/**
 * The rating as a compact label: "20A", or "50A" followed by a pencil mark whose
 * tooltip names the panel's value when the user set it. Empty when there is no rating.
 */
export function ratingLabelHTML(r: RatingView): string {
  if (!r.amps) return "";
  const label = `${escapeHtml(r.amps)}A`;
  return r.userSet ? `${label}${ratingMarkHTML(r.panelAmps)}` : label;
}

/** The pencil that marks a user-set rating, its tooltip naming the panel's own value (or that it publishes none). */
export function ratingMarkHTML(panelAmps: number | null | undefined): string {
  const title = escapeHtml(panelAmps ? tf("monitoringRating.user_set_title", { panel: String(panelAmps) }) : t("monitoringRating.user_set_title_no_panel"));
  return `<span class="rating-user-set" title="${title}">✎</span>`;
}

/** "50 A, set by you (panel: 20 A)": a user-set rating, already formatted, beside the panel's own; plain text. */
export function userSetSentence(rating: string, panelAmps: number | null | undefined): string {
  return panelAmps ? tf("monitoringRating.user_set", { rating, panel: String(panelAmps) }) : tf("monitoringRating.user_set_no_panel", { rating });
}

/** The rating as a sentence for a side panel or a message; plain text, not escaped. */
export function ratingSentence(r: RatingView): string {
  if (!r.amps) return t("monitoringRating.none");
  if (!r.userSet) return `${r.amps} A`;
  return userSetSentence(String(r.amps), r.panelAmps);
}
