import { describe, it, expect } from "vitest";
import { CARD_VERSION } from "../src/constants.js";
import pkg from "../package.json";

describe("CARD_VERSION", () => {
  it("is the package version, which the console banner reports", () => {
    expect(CARD_VERSION).toBe(pkg.version);
  });
});
