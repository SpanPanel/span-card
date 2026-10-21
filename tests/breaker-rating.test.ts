import { describe, it, expect, afterEach } from "vitest";
import { ratingLabelHTML, ratingSentence, type RatingView } from "../src/helpers/breaker-rating.js";
import { setLanguage, tf } from "../src/i18n.js";

afterEach(() => setLanguage("en"));

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

  it("marks a user-set rating with a pencil whose title names the panel's value", () => {
    expect(ratingLabelHTML({ amps: 50, panelAmps: 20, userSet: true })).toBe('50A<span class="rating-user-set" title="Set by you; panel: 20 A">✎</span>');
  });

  it("states that the panel publishes no rating when the user set one over none", () => {
    expect(ratingLabelHTML({ amps: 30, panelAmps: null, userSet: true })).toContain('title="Set by you; panel: none"');
  });

  it("localizes the title", () => {
    setLanguage("fr");
    const html = ratingLabelHTML({ amps: 50, panelAmps: 20, userSet: true });
    expect(html).toContain('title="D\u00e9fini par vous');
  });

  it("escapes hostile text arriving in a websocket payload so it cannot leave the title attribute", () => {
    const payload = '{"amps": 50, "panelAmps": "\\"><img src=x onerror=1>", "userSet": true}';
    const view: RatingView = JSON.parse(payload);
    const html = ratingLabelHTML(view);
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain('"><');
    expect(html).not.toContain("<img");
  });
});

describe("ratingSentence", () => {
  it("says there is no rating", () => {
    expect(ratingSentence({ amps: null })).toBe("no rating");
    expect(ratingSentence({ amps: 0 })).toBe("no rating");
  });

  it("gives the rating alone when it is the panel's", () => {
    expect(ratingSentence({ amps: 20, panelAmps: 20 })).toBe("20 A");
  });

  it("gives the correction and the panel's value when user-set", () => {
    expect(ratingSentence({ amps: 50, panelAmps: 20, userSet: true })).toBe("50 A, set by you (panel: 20 A)");
  });

  it("says none for the panel's value when it publishes none", () => {
    expect(ratingSentence({ amps: 30, panelAmps: null, userSet: true })).toBe("30 A, set by you (panel: none)");
  });
});

describe("rating strings", () => {
  it.each(["en", "es", "fr", "ja", "pt"])("%s has every key with its placeholders", lang => {
    setLanguage(lang);
    expect(tf("rating.user_set", { rating: "R1", panel: "P1" })).toMatch(/R1[\s\S]*P1/);
    expect(tf("rating.user_set_title", { panel: "P1" })).toContain("P1");
    expect(tf("rating.user_set_no_panel", { rating: "R1" })).toContain("R1");
    expect(tf("rating.user_set_title_no_panel", {})).not.toBe("rating.user_set_title_no_panel");
    expect(tf("rating.none", {})).not.toBe("rating.none");
  });
});
