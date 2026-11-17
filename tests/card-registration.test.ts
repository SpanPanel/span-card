import { describe, it, expect, beforeAll, vi } from "vitest";
import type { CustomCardEntry, CustomStrategyEntry } from "../src/core/lovelace-registration.js";
import { PANEL, hassWithRegistries } from "./hass-registries.js";

/**
 * The card bundle adds the card to the card picker's list and the section
 * strategy to the dashboard editor's, and defines the element the editor looks
 * the strategy up by. The frontend creates both lists when it loads and keeps
 * the ones it created, so the bundle adds to a list that is there rather than
 * replacing it.
 */

const OTHER_CARD: CustomCardEntry = { type: "other-card", name: "Other Card" };
const OTHER_STRATEGY: CustomStrategyEntry = { type: "other-section", strategyType: "section", name: "Other Section" };

let frontendCards: CustomCardEntry[];
let frontendStrategies: CustomStrategyEntry[];

beforeAll(async () => {
  frontendCards = [OTHER_CARD];
  frontendStrategies = [OTHER_STRATEGY];
  window.customCards = frontendCards;
  window.customStrategies = frontendStrategies;
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

  it("adds the section strategy to the dashboard editor's list, kept as the frontend created it", () => {
    expect(window.customStrategies).toBe(frontendStrategies);
    expect(frontendStrategies[0]).toBe(OTHER_STRATEGY);
    expect(frontendStrategies.filter(strategy => strategy.type === "span-panel")).toEqual([
      { type: "span-panel", strategyType: "section", name: "SPAN Panel", description: expect.any(String) },
    ]);
  });

  it("defines the strategy's element under the name the frontend derives from custom:span-panel", async () => {
    const { SpanPanelSectionStrategy } = await import("../src/strategy/span-panel-section-strategy.js");
    expect(customElements.get("ll-strategy-section-span-panel")).toBe(SpanPanelSectionStrategy);
  });

  it("registers nothing from a second copy of the bundle, which throws at the card's own definition first", async () => {
    vi.resetModules();
    await expect(import("../src/index.js")).rejects.toThrow(/span-panel-card/);
    expect(frontendCards.filter(card => card.type === "span-panel-card")).toHaveLength(1);
    expect(frontendStrategies.filter(strategy => strategy.type === "span-panel")).toHaveLength(1);
  });

  it("adds an entry of a type once, called again regardless", async () => {
    const { registerCustomCard, registerCustomStrategy } = await import("../src/core/lovelace-registration.js");
    registerCustomCard({ type: "span-panel-card", name: "SPAN Panel" });
    registerCustomStrategy({ type: "span-panel", strategyType: "section", name: "SPAN Panel" });
    expect(frontendCards.filter(card => card.type === "span-panel-card")).toHaveLength(1);
    expect(frontendStrategies.filter(strategy => strategy.type === "span-panel")).toHaveLength(1);
  });

  it("keeps a strategy of the same name for another kind of thing apart", async () => {
    const { registerCustomStrategy } = await import("../src/core/lovelace-registration.js");
    registerCustomStrategy({ type: "span-panel", strategyType: "view", name: "SPAN Panel view" });
    expect(frontendStrategies.filter(strategy => strategy.type === "span-panel").map(strategy => strategy.strategyType)).toEqual(["section", "view"]);
  });
});

describe("registration before the frontend has created its lists", () => {
  it("creates each list", async () => {
    const { registerCustomCard, registerCustomStrategy } = await import("../src/core/lovelace-registration.js");
    delete window.customCards;
    delete window.customStrategies;
    registerCustomCard(OTHER_CARD);
    registerCustomStrategy(OTHER_STRATEGY);
    expect(window.customCards).toEqual([OTHER_CARD]);
    expect(window.customStrategies).toEqual([OTHER_STRATEGY]);
  });
});
