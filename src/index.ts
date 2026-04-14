import { CARD_VERSION } from "./constants.js";
import "./card/span-panel-card.js";
import { SpanPanelCardEditor } from "./editor/span-panel-card-editor.js";

try {
  if (!customElements.get("span-panel-card-editor")) {
    customElements.define("span-panel-card-editor", SpanPanelCardEditor);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}

interface CustomCardDef {
  type: string;
  name: string;
  description: string;
  preview: boolean;
}

declare global {
  interface Window {
    customCards?: CustomCardDef[];
  }
}

window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "span-panel-card",
  name: "SPAN Panel",
  description: "Physical panel layout with live power charts matching the SPAN frontend",
  preview: true,
});

console.warn(
  `%c SPAN-PANEL-CARD %c v${CARD_VERSION} `,
  "background: var(--primary-color, #4dd9af); color: var(--text-primary-color, #000); font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;",
  "background: var(--secondary-background-color, #333); color: var(--primary-text-color, #fff); padding: 2px 6px; border-radius: 0 4px 4px 0;"
);
