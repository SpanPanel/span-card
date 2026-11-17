import { describe, it, expect, beforeAll, vi } from "vitest";
import type { CustomCardEntry } from "../src/core/lovelace-registration.js";
import { PANEL, hassWithRegistries } from "./hass-registries.js";

/**
 * The card bundle adds the card to the card picker's list. The frontend
 * creates the list when it loads and keeps the one it created, so the bundle
 * adds to a list that is there rather than replacing it.
 */

const OTHER_CARD: CustomCardEntry = { type: "other-card", name: "Other Card" };

let frontendCards: CustomCardEntry[];

beforeAll(async () => {
  frontendCards = [OTHER_CARD];
  window.customCards = frontendCards;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await import("../src/index.js");
});

describe("card bundle registration", () => {
  it("adds the card to the card picker's list, kept as the frontend created it", () => {
    expect(window.customCards).toBe(frontendCards);
    expect(frontendCards[0]).toBe(OTHER_CARD);
    expect(frontendCards.filter(card => card.type === "span-panel-card")).toEqual([
      expect.objectContaining({ type: "span-panel-card", name: "SPAN Panel", preview: true, getEntitySuggestion: expect.any(Function) }),
    ]);
  });

  it("suggests the card through the entry the card picker reads", () => {
    const entry = frontendCards.find(card => card.type === "span-panel-card");
    const hass = hassWithRegistries([PANEL], [{ entity_id: "binary_sensor.span_panel_status", device_id: PANEL.id, platform: "span_panel" }]);
    expect(entry?.getEntitySuggestion?.(hass, "binary_sensor.span_panel_status")).toEqual({ config: { type: "custom:span-panel-card", device_id: PANEL.id } });
  });

  it("adds each entry once, however often the registration runs", async () => {
    const { registerCustomCard } = await import("../src/core/lovelace-registration.js");
    registerCustomCard({ type: "span-panel-card", name: "SPAN Panel" });
    expect(frontendCards.filter(card => card.type === "span-panel-card")).toHaveLength(1);
  });
});

describe("registration before the frontend has created its list", () => {
  it("creates the list", async () => {
    const { registerCustomCard } = await import("../src/core/lovelace-registration.js");
    delete window.customCards;
    registerCustomCard(OTHER_CARD);
    expect(window.customCards).toEqual([OTHER_CARD]);
  });
});
