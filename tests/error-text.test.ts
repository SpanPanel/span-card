import { describe, it, expect } from "vitest";
import { errorText } from "../src/helpers/error-text.js";

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
