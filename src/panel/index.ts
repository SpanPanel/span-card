import { CARD_VERSION } from "../constants.js";
import { SpanPanelElement } from "./span-panel.js";

try {
  if (!customElements.get("span-panel")) {
    customElements.define("span-panel", SpanPanelElement);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}

console.warn(
  `%c SPAN-PANEL %c v${CARD_VERSION} `,
  "background: var(--primary-color, #4dd9af); color: #000; font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;",
  "background: var(--secondary-background-color, #333); color: var(--primary-text-color, #fff); padding: 2px 6px; border-radius: 0 4px 4px 0;"
);
