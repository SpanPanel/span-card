import { LitElement, html, css, svg, nothing } from "lit";
import { property } from "lit/decorators.js";
import {
  mdiAlert,
  mdiAlertCircle,
  mdiBattery,
  mdiBatteryAlertVariantOutline,
  mdiChevronDown,
  mdiClose,
  mdiCog,
  mdiHeart,
  mdiHeartOutline,
  mdiHelp,
  mdiHelpCircleOutline,
  mdiHomeGroup,
  mdiInformation,
  mdiLock,
  mdiLockOpen,
  mdiMenu,
  mdiMonitorEye,
  mdiRouterWireless,
  mdiSortDescending,
  mdiTransmissionTower,
  mdiViewDashboard,
} from "@mdi/js";

/**
 * Curated map of MDI tokens used by this card. Adding a new icon here
 * is the only step required to use it as <span-icon icon="mdi:foo">.
 *
 * Vendoring icons via @mdi/js (rather than reaching for HA's <ha-icon>)
 * means the bundle only carries the path strings we actually reference.
 * Keeping the map small and explicit also catches typos at review time —
 * an unknown name renders nothing and warns once instead of silently
 * shipping a generic placeholder.
 */
const MDI_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "mdi:alert": mdiAlert,
  "mdi:alert-circle": mdiAlertCircle,
  "mdi:battery": mdiBattery,
  "mdi:battery-alert-variant-outline": mdiBatteryAlertVariantOutline,
  "mdi:chevron-down": mdiChevronDown,
  "mdi:close": mdiClose,
  "mdi:cog": mdiCog,
  "mdi:heart": mdiHeart,
  "mdi:heart-outline": mdiHeartOutline,
  "mdi:help": mdiHelp,
  "mdi:help-circle-outline": mdiHelpCircleOutline,
  "mdi:home-group": mdiHomeGroup,
  "mdi:information": mdiInformation,
  "mdi:lock": mdiLock,
  "mdi:lock-open": mdiLockOpen,
  "mdi:menu": mdiMenu,
  "mdi:monitor-eye": mdiMonitorEye,
  "mdi:router-wireless": mdiRouterWireless,
  "mdi:sort-descending": mdiSortDescending,
  "mdi:transmission-tower": mdiTransmissionTower,
  "mdi:view-dashboard": mdiViewDashboard,
});

const _warned = new Set<string>();
function warnOnce(name: string): void {
  if (_warned.has(name)) return;
  _warned.add(name);
  console.warn(`SPAN: <span-icon> unknown icon "${name}". Add it to MDI_PATHS in span-icon.ts.`);
}

/**
 * Drop-in replacement for HA's <ha-icon>. Renders an inline SVG path
 * looked up from a small curated map of @mdi/js constants.
 *
 * Honors --mdc-icon-size so existing per-site sizing rules in
 * card-styles.ts continue to work without modification. The element is
 * display: inline-flex so it aligns with adjacent text the same way
 * <ha-icon> does inside flex rows.
 */
export class SpanIcon extends LitElement {
  @property({ type: String }) icon = "";

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--mdc-icon-size, 24px);
      height: var(--mdc-icon-size, 24px);
      vertical-align: middle;
      color: inherit;
      flex-shrink: 0;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
      fill: currentColor;
    }
  `;

  protected override render(): unknown {
    if (!this.icon) return nothing;
    const path = MDI_PATHS[this.icon];
    if (!path) {
      warnOnce(this.icon);
      return nothing;
    }
    return html`<svg viewBox="0 0 24 24" aria-hidden="true">${svg`<path d=${path} />`}</svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "span-icon": SpanIcon;
  }
}

// Guarded registration: both span-panel.js and span-panel-card.js are
// loaded onto the same document when a user has the Lovelace card on
// a dashboard alongside the integration's HA panel. The second bundle
// to import this module would otherwise throw NotSupportedError on the
// duplicate define, which would break whichever view loaded second.
try {
  if (!customElements.get("span-icon")) {
    customElements.define("span-icon", SpanIcon);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}
