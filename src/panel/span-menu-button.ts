import { LitElement, html, css, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { mdiMenu } from "@mdi/js";

/**
 * Replacement for HA's <ha-menu-button>. Renders a hamburger icon that
 * fires the documented `hass-toggle-menu` custom event on click — the
 * same event HA's drawer listens for. The event API is part of HA's
 * panel contract (panels live inside the drawer-aware shell), not a
 * component API, so it stays stable across the frontend component
 * migrations the dev blog flagged.
 *
 * Mirrors HA's narrow-only display: hidden on wider viewports where the
 * drawer is permanent, visible on narrow viewports where the drawer is
 * collapsed behind the hamburger. The `narrow` property reflects to an
 * attribute so CSS can drive visibility without re-rendering.
 */
@customElement("span-menu-button")
export class SpanMenuButton extends LitElement {
  @property({ type: Boolean, reflect: true }) narrow = false;

  static override styles = css`
    :host {
      display: none;
      align-items: center;
      justify-content: center;
    }
    :host([narrow]) {
      display: inline-flex;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 50%;
      color: inherit;
      cursor: pointer;
      transition: background 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    button:hover,
    button:focus-visible {
      background: color-mix(in srgb, currentColor 12%, transparent);
      outline: none;
    }
    svg {
      width: 24px;
      height: 24px;
      fill: currentColor;
    }
  `;

  protected override render(): unknown {
    return html`
      <button @click=${this._toggle} aria-label="Toggle menu" title="Toggle menu">
        <svg viewBox="0 0 24 24" aria-hidden="true">${svg`<path d=${mdiMenu} />`}</svg>
      </button>
    `;
  }

  private _toggle = (): void => {
    this.dispatchEvent(
      new CustomEvent("hass-toggle-menu", {
        bubbles: true,
        composed: true,
      })
    );
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "span-menu-button": SpanMenuButton;
  }
}
