import { describe, it, expect, vi } from "vitest";
import { errorText, serviceErrorMessage } from "../src/helpers/error-text.js";
import type { HomeAssistant } from "../src/types.js";

describe("errorText", () => {
  it("reads an Error's message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
  });

  it("reads Home Assistant's { code, message } rejection, never [object Object]", () => {
    expect(errorText({ code: "unauthorized", message: "Unauthorized" })).toBe("Unauthorized");
  });

  it("stringifies anything else", () => {
    expect(errorText("plain")).toBe("plain");
    expect(errorText({ code: 3 })).toBe("[object Object]");
  });
});

const REFUSAL = {
  code: "service_validation_error",
  message: "Validation error: The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A.",
  translation_domain: "span_panel",
  translation_key: "package_ratings_above_service_rating",
  translation_placeholders: { service_rating: "40", ignored: { nested: true } },
};

function hassLocalizing(text: string): { hass: HomeAssistant; load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(async () => (_key: string, values?: Record<string, string | number>) => `${text} ${JSON.stringify(values)}`);
  return { hass: { loadBackendTranslation: load } as unknown as HomeAssistant, load };
}

describe("serviceErrorMessage", () => {
  it("localises a refusal of its own domain, passing on only text and number placeholders", async () => {
    const { hass, load } = hassLocalizing("localised");
    expect(await serviceErrorMessage(hass, REFUSAL, "span_panel", "fallback")).toBe('localised {"service_rating":"40"}');
    expect(load).toHaveBeenCalledWith("exceptions", "span_panel");
  });

  it("leaves a refusal of another domain as its message, without loading that domain's translations", async () => {
    const { hass, load } = hassLocalizing("localised");
    const other = { ...REFUSAL, translation_domain: "another_integration" };
    expect(await serviceErrorMessage(hass, other, "span_panel", "fallback")).toBe(
      "The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A."
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("uses the frontend's translator where it cannot load a category", async () => {
    const hass = { localize: (key: string) => (key === "component.span_panel.exceptions.package_ratings_above_service_rating.message" ? "from localize" : "") };
    expect(await serviceErrorMessage(hass as unknown as HomeAssistant, REFUSAL, "span_panel", "fallback")).toBe("from localize");
  });

  it("falls back to the message where loading the translations fails", async () => {
    const hass = { loadBackendTranslation: async () => Promise.reject(new Error("offline")) };
    expect(await serviceErrorMessage(hass as unknown as HomeAssistant, REFUSAL, "span_panel", "fallback")).toBe(
      "The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A."
    );
  });

  it("falls back to the given text where the refusal carries no message", async () => {
    expect(await serviceErrorMessage(null, {}, "span_panel", "fallback")).toBe("fallback");
    expect(await serviceErrorMessage(null, new Error(""), "span_panel", "fallback")).toBe("fallback");
  });
});
