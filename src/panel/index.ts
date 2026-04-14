import { CARD_VERSION } from "../constants.js";
import { SpanPanelElement } from "./span-panel.js";

console.warn(
  `%c SPAN-PANEL %c v${CARD_VERSION} `,
  "background: var(--primary-color, #4dd9af); color: #000; font-weight: 700; padding: 2px 6px; border-radius: 4px 0 0 4px;",
  "background: var(--secondary-background-color, #333); color: var(--primary-text-color, #fff); padding: 2px 6px; border-radius: 0 4px 4px 0;"
);

// HA removes <ha-panel-custom> after WS reconnect while the browser tab
// is backgrounded and does not re-create it — regardless of whether the
// element uses LitElement or vanilla HTMLElement.  Track connection state
// and reload when the tab is restored with a missing panel.

let _panelConnected = false;

const origConnected = SpanPanelElement.prototype.connectedCallback;
SpanPanelElement.prototype.connectedCallback = function () {
  _panelConnected = true;
  origConnected.call(this);
};

const origDisconnected = SpanPanelElement.prototype.disconnectedCallback;
SpanPanelElement.prototype.disconnectedCallback = function () {
  _panelConnected = false;
  origDisconnected.call(this);
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (_panelConnected) return;
  if (!window.location.pathname.includes("span-panel")) return;

  setTimeout(() => {
    if (_panelConnected) return;
    location.reload();
  }, 200);
});
