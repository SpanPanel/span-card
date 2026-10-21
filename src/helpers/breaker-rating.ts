import { escapeHtml } from "./sanitize.js";
import { t, tf } from "../i18n.js";

/**
 * A breaker rating as the card shows it: the rating in force, the panel's own
 * published value, and whether the user corrected it.
 */
export interface RatingView {
  /** The rating in force: the user's correction where one applies, else the panel's. */
  amps: number | null | undefined;
  /** The rating the panel publishes, null when it publishes none. */
  panelAmps?: number | null;
  /** True when `amps` is the user's correction rather than the panel's value. */
  userSet?: boolean;
}

/**
 * The rating as a compact label: "20A", or "50A" followed by a pencil mark whose
 * tooltip names the panel's value when the user set it. Empty when there is no rating.
 */
export function ratingLabelHTML(r: RatingView): string {
  if (!r.amps) return "";
  const label = `${escapeHtml(r.amps)}A`;
  if (!r.userSet) return label;
  const title = escapeHtml(r.panelAmps ? tf("rating.user_set_title", { panel: String(r.panelAmps) }) : t("rating.user_set_title_no_panel"));
  return `${label}<span class="rating-user-set" title="${title}">✎</span>`;
}

/** The rating as a sentence for a side panel or a message; plain text, not escaped. */
export function ratingSentence(r: RatingView): string {
  if (!r.amps) return t("rating.none");
  if (!r.userSet) return `${r.amps} A`;
  const rating = String(r.amps);
  return r.panelAmps ? tf("rating.user_set", { rating, panel: String(r.panelAmps) }) : tf("rating.user_set_no_panel", { rating });
}
