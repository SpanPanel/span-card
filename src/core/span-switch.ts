import { LitElement, html, css } from "lit";
import { property } from "lit/decorators.js";

/**
 * Drop-in replacement for HA's <ha-switch>: a track and thumb toggle for the
 * call sites in side-panel.ts.
 *
 * The colors are <ha-switch>'s, as Home Assistant's frontend 20261028 draws
 * it: each part reads the theme token <ha-switch> reads, then the design token
 * <ha-switch> falls back to, so the default theme draws these as it draws its
 * own switches and a theme that styles <ha-switch> styles these too. That
 * covers the track and its 1px border, the thumb and its border and shadow,
 * each checked and unchecked, at rest and under hover or keyboard focus, and
 * the disabled opacity, which dims the control alone. The last value in each
 * chain applies only outside Home Assistant, where neither token is defined.
 *
 * The size is this card's own, 36 by 20 with a 14px thumb, not <ha-switch>'s
 * size tokens.
 *
 * Properties:
 *   checked  – on/off state (reflects to attribute for [checked] CSS)
 *   disabled – dims the control, and a click or key press leaves it as it is
 *
 * Fires a native `change` event with `bubbles: true, composed: true` so
 * shadow-root listeners and the existing addEventListener("change", ...)
 * handlers in side-panel.ts continue to work unchanged.
 */
export class SpanSwitch extends LitElement {
  @property({ type: Boolean, reflect: true }) checked = false;
  @property({ type: Boolean, reflect: true }) disabled = false;

  static override styles = css`
    :host {
      --span-switch-track-w: 36px;
      --span-switch-track-h: 20px;
      --span-switch-thumb: 14px;
      --span-switch-border: 1px;
      /* The thumb's gap to the inside of the track's border, the same on every side. */
      --span-switch-inset: calc((var(--span-switch-track-h) - 2 * var(--span-switch-border) - var(--span-switch-thumb)) / 2);
      --span-switch-track-color: var(--ha-switch-background-color, var(--ha-color-fill-disabled-quiet-resting, rgba(120, 120, 120, 0.45)));
      --span-switch-track-border-color: var(--ha-switch-border-color, var(--ha-color-border-neutral-normal, transparent));
      --span-switch-thumb-color: var(--ha-switch-thumb-background-color, var(--ha-color-on-neutral-normal, #fafafa));
      --span-switch-thumb-border-color: var(--ha-switch-thumb-border-color, var(--ha-color-on-neutral-normal, transparent));
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    :host(:not([checked]):not([disabled]):hover),
    :host(:not([checked]):not([disabled]):focus-visible) {
      --span-switch-track-color: var(
        --ha-switch-background-color-hover,
        var(--ha-switch-background-color, var(--ha-color-fill-disabled-quiet-hover, rgba(120, 120, 120, 0.45)))
      );
      --span-switch-thumb-color: var(
        --ha-switch-thumb-background-color-hover,
        var(--ha-switch-thumb-background-color, var(--ha-color-on-neutral-normal, #fafafa))
      );
      --span-switch-thumb-border-color: var(
        --ha-switch-thumb-border-color-hover,
        var(--ha-switch-thumb-border-color, var(--ha-color-on-neutral-normal, transparent))
      );
    }
    :host([checked]) {
      --span-switch-track-color: var(--ha-switch-checked-background-color, var(--ha-color-fill-primary-normal-resting, var(--primary-color, #4dd9af)));
      --span-switch-track-border-color: var(--ha-switch-checked-border-color, var(--ha-color-border-primary-loud, transparent));
      --span-switch-thumb-color: var(--ha-switch-checked-thumb-background-color, var(--ha-color-on-primary-normal, #fff));
      --span-switch-thumb-border-color: var(--ha-switch-checked-thumb-border-color, var(--ha-color-on-primary-normal, transparent));
    }
    :host([checked]:not([disabled]):hover),
    :host([checked]:not([disabled]):focus-visible) {
      --span-switch-track-color: var(
        --ha-switch-checked-background-color-hover,
        var(--ha-switch-checked-background-color, var(--ha-color-fill-primary-normal-hover, var(--primary-color, #4dd9af)))
      );
      --span-switch-track-border-color: var(
        --ha-switch-checked-border-color-hover,
        var(--ha-switch-checked-border-color, var(--ha-color-border-primary-loud, transparent))
      );
      --span-switch-thumb-color: var(
        --ha-switch-checked-thumb-background-color-hover,
        var(--ha-switch-checked-thumb-background-color, var(--ha-color-on-primary-normal, #fff))
      );
      --span-switch-thumb-border-color: var(
        --ha-switch-checked-thumb-border-color-hover,
        var(--ha-switch-checked-thumb-border-color, var(--ha-color-on-primary-normal, transparent))
      );
    }
    :host([disabled]) {
      cursor: not-allowed;
    }
    .track {
      position: relative;
      box-sizing: border-box;
      width: var(--span-switch-track-w);
      height: var(--span-switch-track-h);
      border: var(--span-switch-border) solid var(--span-switch-track-border-color);
      border-radius: calc(var(--span-switch-track-h) / 2);
      background: var(--span-switch-track-color);
      transition:
        background 0.2s ease,
        border-color 0.2s ease;
    }
    :host([disabled]) .track {
      opacity: var(--ha-switch-disabled-opacity, 0.3);
    }
    .thumb {
      position: absolute;
      top: 50%;
      left: var(--span-switch-inset);
      box-sizing: border-box;
      width: var(--span-switch-thumb);
      height: var(--span-switch-thumb);
      border: var(--span-switch-border) solid var(--span-switch-thumb-border-color);
      border-radius: 50%;
      background: var(--span-switch-thumb-color);
      box-shadow: var(--ha-switch-thumb-box-shadow, var(--ha-box-shadow-s, 0 1px 3px rgba(0, 0, 0, 0.35)));
      transform: translateY(-50%);
      transition:
        left 0.2s ease,
        background 0.2s ease,
        border-color 0.2s ease;
    }
    :host([checked]) .thumb {
      left: calc(var(--span-switch-track-w) - 2 * var(--span-switch-border) - var(--span-switch-inset) - var(--span-switch-thumb));
    }
    :host(:focus-visible) .track {
      outline: 2px solid var(--primary-color, #4dd9af);
      outline-offset: 2px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.hasAttribute("tabindex")) this.setAttribute("tabindex", "0");
    if (!this.hasAttribute("role")) this.setAttribute("role", "switch");
    this.setAttribute("aria-checked", String(this.checked));
    this.addEventListener("click", this._onActivate);
    this.addEventListener("keydown", this._onKeydown);
  }

  disconnectedCallback(): void {
    this.removeEventListener("click", this._onActivate);
    this.removeEventListener("keydown", this._onKeydown);
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("checked")) this.setAttribute("aria-checked", String(this.checked));
    if (changed.has("disabled")) this.setAttribute("aria-disabled", String(this.disabled));
  }

  protected override render(): unknown {
    return html`
      <div class="track">
        <div class="thumb"></div>
      </div>
    `;
  }

  private _onActivate = (ev: Event): void => {
    if (this.disabled) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    this.checked = !this.checked;
    this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };

  private _onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key !== " " && ev.key !== "Enter") return;
    ev.preventDefault();
    this._onActivate(ev);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "span-switch": SpanSwitch;
  }
}

// Guarded registration: see span-icon.ts for the rationale.
try {
  if (!customElements.get("span-switch")) {
    customElements.define("span-switch", SpanSwitch);
  }
} catch {
  // Scoped custom element registry may throw on duplicate registration after upgrade
}
