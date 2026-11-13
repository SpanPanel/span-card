import { describe, it, expect, afterEach } from "vitest";
import {
  copyWarning,
  isMonitored,
  judgedAgainstSentence,
  limitRatingA,
  monitoringRatingView,
  ratingLabelHTML,
  thresholdWarning,
  warnsOfAveragedLegs,
  type PackageCopyFields,
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

  it.each(["en", "es", "fr", "ja", "pt"])("%s has the side panel's guidance for each form, and the averaged-legs warning, in its own words", lang => {
    setLanguage(lang);
    const keys = ["guidance", "guidance_two_spaces", "averaged_legs", "turn_off_monitoring"].map(key => `monitoringRating.${key}`);
    for (const key of keys) expect(t(key)).not.toBe(key);
    if (lang !== "en") {
      setLanguage("en");
      const english = keys.map(key => t(key));
      setLanguage(lang);
      expect(keys.map(key => t(key)).filter((text, i) => text === english[i])).toEqual([]);
    }
  });

  it("has no note for a circuit across several spaces, which now takes a copy", () => {
    expect(t("monitoringRating.multi_space")).toBe("monitoringRating.multi_space");
  });
});

describe("the side panel's text, as approved", () => {
  it("is the approved line for each form, and the approved averaged-legs warning", () => {
    expect(t("monitoringRating.guidance")).toBe(
      "If your SPAN app shows two ratings for this circuit, such as 20-20A, enter the second one here. SPAN Panel MAIN 32 panels report " +
        "only the first, and monitoring then judges this space against both breakers together."
    );
    expect(t("monitoringRating.guidance_two_spaces")).toBe("If your SPAN app shows two ratings for this circuit, such as 20-30A, enter the second one here.");
    expect(t("monitoringRating.averaged_legs")).toBe(
      "SPAN Panel MAIN 32 panels report only the average of this circuit's two legs, which can hide an overloaded leg. We recommend " +
        "turning monitoring off for this circuit."
    );
    expect(t("monitoringRating.turn_off_monitoring")).toBe("Turn off monitoring");
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

describe("the Japanese pointer to the global settings", () => {
  it("runs the placeholders into the sentence with no space around them, as Japanese is written", () => {
    setLanguage("ja");
    const text = tf("monitoringRating.threshold_warning_global", { settings: "<S>", tab: "<T>" });
    expect(text).toContain("<T>タブの<S>で");
    expect(text).not.toMatch(/\s<[ST]>|<[ST]>\s/);
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
  const APPLIES: PackageCopyFields = { package_ratings_form: "one_space", package_ratings_state: "applies" };
  const ABOVE = { has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 };

  it("is nothing without a copy, or with every threshold at 100% or below", () => {
    expect(thresholdWarning(null, ABOVE)).toBeNull();
    expect(thresholdWarning({ package_ratings_form: "one_space", package_ratings_state: null }, ABOVE)).toBeNull();
    expect(thresholdWarning(APPLIES, { has_override: true, continuous_threshold_pct: 100, spike_threshold_pct: 100 })).toBeNull();
    expect(thresholdWarning(APPLIES, null)).toBeNull();
  });

  it("is the circuit's own wherever it has an override, its values the global ones or not", () => {
    // Beside a checked Custom choice, the reset to the global thresholds is what the user can act on here.
    expect(thresholdWarning(APPLIES, { has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 100 })).toBe("own");
    expect(thresholdWarning(APPLIES, { has_override: true, spike_threshold_pct: 200 })).toBe("own");
  });

  it("is the global one where the circuit has no override", () => {
    expect(thresholdWarning(APPLIES, { has_override: false, continuous_threshold_pct: 160, spike_threshold_pct: 200 })).toBe("global");
    expect(thresholdWarning(APPLIES, { continuous_threshold_pct: 160 })).toBe("global");
  });

  it("is given for a copy in one space waiting on a value not yet arrived, which applies once it does", () => {
    expect(thresholdWarning({ package_ratings_form: "one_space", package_ratings_state: "pending" }, ABOVE)).toBe("own");
  });

  it("is nothing for a copy kept on averaged legs, which changes no threshold's meaning, however high they are", () => {
    expect(thresholdWarning({ package_ratings_form: "two_spaces", package_ratings_state: "averaged_legs" }, ABOVE)).toBeNull();
  });

  it("is nothing for a two-space copy waiting on a value, which never applies once it arrives", () => {
    expect(thresholdWarning({ package_ratings_form: "two_spaces", package_ratings_state: "pending" }, ABOVE)).toBeNull();
    expect(thresholdWarning({ package_ratings_form: null, package_ratings_state: "pending" }, ABOVE)).toBeNull();
  });

  it("is nothing where an integration that predates states says nothing of the copy's", () => {
    expect(thresholdWarning({}, ABOVE)).toBeNull();
  });
});

describe("warnsOfAveragedLegs", () => {
  const AVERAGED: PackageCopyFields = { package_ratings_form: "two_spaces", package_ratings_state: "averaged_legs" };

  it("warns of a copy kept on averaged legs while the circuit is monitored", () => {
    expect(warnsOfAveragedLegs(AVERAGED, { monitoring_enabled: true })).toBe(true);
    expect(warnsOfAveragedLegs(AVERAGED, {})).toBe(true);
  });

  it("is quiet once monitoring is off for the circuit, or while no status says it is monitored", () => {
    expect(warnsOfAveragedLegs(AVERAGED, { monitoring_enabled: false })).toBe(false);
    expect(warnsOfAveragedLegs(AVERAGED, null)).toBe(false);
  });

  it("is quiet for any other copy, or none", () => {
    for (const state of ["applies", "pending", null] as const) {
      expect(warnsOfAveragedLegs({ package_ratings_form: "two_spaces", package_ratings_state: state }, { monitoring_enabled: true })).toBe(false);
    }
    expect(warnsOfAveragedLegs(null, { monitoring_enabled: true })).toBe(false);
  });
});

describe("copyWarning", () => {
  const AVERAGED: PackageCopyFields = { package_ratings_form: "two_spaces", package_ratings_state: "averaged_legs" };
  const APPLIES: PackageCopyFields = { package_ratings_form: "one_space", package_ratings_state: "applies" };
  const ABOVE = { has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 };

  it("is the averaged-legs warning for a copy kept on averaged legs while the circuit is monitored, however high its thresholds", () => {
    expect(copyWarning(AVERAGED, { ...ABOVE, monitoring_enabled: true })).toBe("averaged_legs");
  });

  it("is nothing for a copy on averaged legs once monitoring is off for the circuit", () => {
    expect(copyWarning(AVERAGED, { ...ABOVE, monitoring_enabled: false })).toBeNull();
  });

  it("is the threshold warning for a copy monitoring judges by, as thresholdWarning names it", () => {
    expect(copyWarning(APPLIES, ABOVE)).toBe("own");
    expect(copyWarning(APPLIES, { ...ABOVE, has_override: false })).toBe("global");
    expect(copyWarning(APPLIES, { has_override: true, continuous_threshold_pct: 80, spike_threshold_pct: 100 })).toBeNull();
  });

  it("is nothing without a copy or a status", () => {
    expect(copyWarning(null, ABOVE)).toBeNull();
    expect(copyWarning(APPLIES, null)).toBeNull();
  });
});

describe("isMonitored", () => {
  it("is true for a point a status reports with monitoring on, or with the switch left out", () => {
    expect(isMonitored({ monitoring_enabled: true })).toBe(true);
    expect(isMonitored({})).toBe(true);
  });

  it("is false once monitoring is off for the point, or where no status reports it", () => {
    expect(isMonitored({ monitoring_enabled: false })).toBe(false);
    expect(isMonitored(null)).toBe(false);
    expect(isMonitored(undefined)).toBe(false);
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
