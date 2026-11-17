import type { HomeAssistant } from "../types.js";

// ── Home Assistant's lists of custom dashboard parts ─────────────────────────
//
// The frontend reads `window.customCards` for the card picker and
// `window.customStrategies` for the dashboard editor's automatic dashboards,
// views and sections. The interfaces below are the parts of the frontend's own
// entry types the card fills in.

/** A card's config as a dashboard holds it, of any card: its type, beside whatever options that type takes. */
export interface LovelaceCardConfig {
  type: string;
}

/**
 * A card the card picker suggests for an entity: its config, and a label that
 * tells it apart where a card suggests more than one.
 */
export interface CardSuggestion<C extends LovelaceCardConfig = LovelaceCardConfig> {
  label?: string;
  config: C;
}

/** A custom card's entry in `window.customCards`. */
export interface CustomCardEntry {
  type: string;
  name?: string;
  description?: string;
  preview?: boolean;
  /**
   * The card configs the card picker suggests for an entity, under Community
   * (Home Assistant 2026.6+); null for an entity the card has no use for.
   */
  getEntitySuggestion?: (hass: HomeAssistant, entityId: string) => CardSuggestion | CardSuggestion[] | null;
}

/**
 * A custom strategy's entry in `window.customStrategies`: the strategy's name
 * without Home Assistant's `custom:` prefix, and the kind of thing it builds.
 * The dashboard editor offers a section strategy under Community sections
 * (Home Assistant 2026.11+).
 */
export interface CustomStrategyEntry {
  type: string;
  strategyType: "dashboard" | "view" | "section";
  name?: string;
  description?: string;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
    customStrategies?: CustomStrategyEntry[];
  }
}

/**
 * Add a card to the list the card picker reads, unless an entry of its type is
 * there already. The list is created where it does not exist yet and never
 * replaced, because the frontend keeps the list it found when it loaded.
 */
export function registerCustomCard(entry: CustomCardEntry): void {
  const cards = (window.customCards ??= []);
  if (!cards.some(card => card.type === entry.type)) cards.push(entry);
}

/**
 * Add a strategy to the list the dashboard editor reads, unless an entry of its
 * name and kind is there already. The list is created where it does not exist
 * yet and never replaced, because the frontend keeps the list it found when it
 * loaded.
 */
export function registerCustomStrategy(entry: CustomStrategyEntry): void {
  const strategies = (window.customStrategies ??= []);
  if (!strategies.some(strategy => strategy.type === entry.type && strategy.strategyType === entry.strategyType)) strategies.push(entry);
}
