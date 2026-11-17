import { CARD_ELEMENT, CARD_VERSION, SECTION_STRATEGY_ELEMENT, SECTION_STRATEGY_NAME } from "./constants.js";
import "./card/span-panel-card.js";
import { spanPanelCardSuggestion } from "./card/card-suggestion.js";
import { registerCustomCard, registerCustomStrategy } from "./core/lovelace-registration.js";
import { SpanPanelCardEditor } from "./editor/span-panel-card-editor.js";
import { SpanPanelSectionStrategy } from "./strategy/span-panel-section-strategy.js";

try {
  if (!customElements.get("span-panel-card-editor")) {
    customElements.define("span-panel-card-editor", SpanPanelCardEditor);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}

try {
  if (!customElements.get(SECTION_STRATEGY_ELEMENT)) {
    customElements.define(SECTION_STRATEGY_ELEMENT, SpanPanelSectionStrategy);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}

registerCustomCard({
  type: CARD_ELEMENT,
  name: "SPAN Panel",
  description: "Physical panel layout with live power charts matching the SPAN frontend",
  preview: true,
  getEntitySuggestion: spanPanelCardSuggestion,
});

registerCustomStrategy({
  type: SECTION_STRATEGY_NAME,
  strategyType: "section",
  name: "SPAN Panel",
  description: "A SPAN panel's breaker layout and live power charts, under a heading with the panel's name",
});

console.warn(
  `%c SPAN-PANEL-CARD %c v${CARD_VERSION} `,
  "background: var(--primary-color, #4dd9af); color: var(--text-primary-color, #000); font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;",
  "background: var(--secondary-background-color, #333); color: var(--primary-text-color, #fff); padding: 2px 6px; border-radius: 0 4px 4px 0;"
);
