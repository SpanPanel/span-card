import { describe, it, expect, afterEach } from "vitest";
import {
  judgedAgainstSentence,
  limitRatingA,
  monitoringRatingView,
  ratingLabelHTML,
  thresholdWarning,
  type RatingView,
} from "../src/helpers/monitoring-rating.js";
import { setLanguage, t, tf } from "../src/i18n.js";
import { CARD_STYLES } from "../src/card/card-styles.js";

afterEach(() => setLanguage("en"));

const COPIED: RatingView = { amps: 40, panelAmps: 20, userSet: true, packageRatings: [20, 20] };

describe("ratingLabelHTML", () => {
  it("is empty when there is no rating", () => {
    expect(ratingLabelHTML({ amps: null })).toBe("");
    expect(ratingLabelHTML({ amps: undefined })).toBe("");
    expect(ratingLabelHTML({ amps: 0 })).toBe("");
  });

  it("is the bare rating when the panel's value is in force", () => {
    expect(ratingLabelHTML({ amps: 20, panelAmps: 20, userSet: false })).toBe("20A");
    expect(ratingLabelHTML({ amps: 20 })).toBe("20A");
  });

  it("marks a copied package with a pencil button named by the package and the panel's value, its note revealed on a tap", () => {
    const text = "20-20 from your SPAN app (the panel publishes 20 A)";
    expect(ratingLabelHTML(COPIED)).toBe(
      `40A<button type="button" class="rating-user-set" title="${text}" aria-label="${text}" aria-expanded="false">✎</button>` +
        `<span class="rating-copied-note" hidden>${text}</span>`
    );
  });

  it("names an unequal package in the SPAN app's order", () => {
    expect(ratingLabelHTML({ amps: 35, panelAmps: 15, userSet: true, packageRatings: [15, 20] })).toContain(
      'title="15-20 from your SPAN app (the panel publishes 15 A)"'
    );
  });

  it("still says where the rating came from when the package or the panel's value is missing", () => {
    expect(ratingLabelHTML({ amps: 40, panelAmps: 20, userSet: true })).toContain('title="Copied from your SPAN app"');
    expect(ratingLabelHTML({ amps: 40, panelAmps: null, userSet: true, packageRatings: [20, 20] })).toContain('title="Copied from your SPAN app"');
  });

  it("localizes the title", () => {
    setLanguage("fr");
    expect(ratingLabelHTML(COPIED)).toContain("depuis votre application SPAN");
  });

  it("escapes hostile text arriving in a websocket payload so it cannot leave the title attribute", () => {
    const payload = '{"amps": 50, "panelAmps": 20, "userSet": true, "packageRatings": ["\\"><img src=x onerror=1>", 30]}';
    const view: RatingView = JSON.parse(payload);
    const html = ratingLabelHTML(view);
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain('"><');
    expect(html).not.toContain("<img");
  });
});

describe("judgedAgainstSentence", () => {
  it("says there is no rating", () => {
    expect(judgedAgainstSentence({ amps: null })).toBe("Judged against: no rating");
    expect(judgedAgainstSentence({ amps: 0 })).toBe("Judged against: no rating");
  });

  it("gives the rating alone when it is the panel's", () => {
    expect(judgedAgainstSentence({ amps: 20, panelAmps: 20 })).toBe("Judged against: 20 A");
  });

  it("names the copied package and the panel's rating when the copy applies", () => {
    expect(judgedAgainstSentence(COPIED)).toBe("Judged against 40 A: 20-20 from your SPAN app (the panel publishes 20 A)");
  });
});

describe("rating strings", () => {
  it.each(["en", "es", "fr", "ja", "pt"])("%s has every key with its placeholders", lang => {
    setLanguage(lang);
    expect(tf("monitoringRating.copied", { package: "P1", panel: "P2" })).toMatch(/P1[\s\S]*P2/);
    expect(tf("monitoringRating.judged_copied", { rating: "R1", copied: "C1" })).toMatch(/R1[\s\S]*C1/);
    expect(t("monitoringRating.copied_unnamed")).not.toBe("monitoringRating.copied_unnamed");
    expect(t("monitoringRating.none")).not.toBe("monitoringRating.none");
  });
});

describe("monitoringRatingView", () => {
  it("judges against the package's capacity and names the package and the panel's rating beside it", () => {
    const view = monitoringRatingView({ breaker_rating_a: 20, monitoring_rating_a: 40, monitoring_rating_user_set: true, package_ratings_a: [20, 20] });
    expect(view).toEqual(COPIED);
    expect(ratingLabelHTML(view)).toContain("40A");
    expect(judgedAgainstSentence(view)).toBe("Judged against 40 A: 20-20 from your SPAN app (the panel publishes 20 A)");
  });

  it("falls back to the breaker rating for a status from an integration that predates monitoring ratings", () => {
    expect(monitoringRatingView({ breaker_rating_a: 20 }).amps).toBe(20);
    expect(ratingLabelHTML(monitoringRatingView({ breaker_rating_a: 20 }))).toBe("20A");
  });

  it("is unmarked while the rating is the panel's, and absent when nothing is judged", () => {
    expect(monitoringRatingView({ breaker_rating_a: 20, monitoring_rating_a: 20, monitoring_rating_user_set: false }).userSet).toBe(false);
    expect(monitoringRatingView({ breaker_rating_a: 20, monitoring_rating_a: null }).amps).toBeNull();
    expect(monitoringRatingView(undefined)).toEqual({ amps: undefined, panelAmps: undefined, userSet: false, packageRatings: null });
  });
});

describe("the mark's style", () => {
  it("gives the mark a touch target of at least 24 by 24 px", () => {
    const at = CARD_STYLES.indexOf(".rating-user-set {");
    const rule = CARD_STYLES.slice(at, CARD_STYLES.indexOf("}", at));
    expect(rule).toContain("min-width: 24px");
    expect(rule).toContain("min-height: 24px");
  });
});

describe("thresholdWarning", () => {
  const GLOBALS = { continuous_threshold_pct: 80, spike_threshold_pct: 100 };
  const COPY = [20, 20];

  it("is nothing without a copy, or with every threshold at 100% or below", () => {
    expect(thresholdWarning(null, { continuous_threshold_pct: 160 }, GLOBALS)).toBeNull();
    expect(thresholdWarning(COPY, { continuous_threshold_pct: 100, spike_threshold_pct: 100 }, GLOBALS)).toBeNull();
    expect(thresholdWarning(COPY, null, GLOBALS)).toBeNull();
  });

  it("is the circuit's own where a threshold above 100% differs from the global one", () => {
    expect(thresholdWarning(COPY, { has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 100 }, GLOBALS)).toBe("own");
  });

  it("is the global one where every threshold above 100% equals the global one, an override or not", () => {
    const globals = { continuous_threshold_pct: 160, spike_threshold_pct: 200 };
    expect(thresholdWarning(COPY, { has_override: false, continuous_threshold_pct: 160, spike_threshold_pct: 200 }, globals)).toBe("global");
    expect(thresholdWarning(COPY, { has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 }, globals)).toBe("global");
  });

  it("is the circuit's own where one is and the global one another, above 100% both", () => {
    expect(thresholdWarning(COPY, { has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 }, { continuous_threshold_pct: 160 })).toBe(
      "own"
    );
  });

  it("takes the override's presence where the global thresholds are not known", () => {
    expect(thresholdWarning(COPY, { has_override: true, continuous_threshold_pct: 160 }, null)).toBe("own");
    expect(thresholdWarning(COPY, { has_override: false, continuous_threshold_pct: 160 }, null)).toBe("global");
  });
});

describe("limitRatingA", () => {
  const circuit = { breaker_rating_a: 20, monitoring_rating_a: 50 };

  it("is the monitoring rating while the circuit's monitoring is on", () => {
    expect(limitRatingA(circuit, { monitoring_enabled: true })).toBe(50);
  });

  it("is the panel's rating while the circuit's monitoring is off", () => {
    expect(limitRatingA(circuit, { monitoring_enabled: false })).toBe(20);
  });

  it("is the panel's rating while monitoring is disabled, so the circuit has no status", () => {
    expect(limitRatingA(circuit, null)).toBe(20);
  });

  it("is null where the reading it takes is null", () => {
    expect(limitRatingA({ breaker_rating_a: 20, monitoring_rating_a: null }, { monitoring_enabled: true })).toBeNull();
    expect(limitRatingA({ breaker_rating_a: null, monitoring_rating_a: 50 }, null)).toBeNull();
  });
});
