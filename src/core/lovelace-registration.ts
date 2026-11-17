import type { HomeAssistant } from "../types.js";

// ── Home Assistant's list of custom cards ────────────────────────────────────
//
// The frontend reads `window.customCards` for the card picker. The interfaces
// below are the parts of the frontend's own entry types the card fills in.

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
   * cards (Home Assistant 2026.6+); null for an entity the card has no use for.
   */
  getEntitySuggestion?: (hass: HomeAssistant, entityId: string) => CardSuggestion | CardSuggestion[] | null;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
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
