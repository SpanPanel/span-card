import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Drop-in replacement for HA's <ha-switch>. Track + thumb toggle that
 * mirrors HA's visual conventions (rounded pill, animated thumb, primary
 * accent on the on-state, muted track on off) so existing call sites in
 * side-panel.ts get the same look.
 *
 * Properties:
 *   checked  – on/off state (reflects to attribute for [checked] CSS)
 *   disabled – greys the control and blocks pointer events
 *
 * Fires a native `change` event with `bubbles: true, composed: true` so
 * shadow-root listeners and the existing addEventListener("change", ...)
 * handlers in side-panel.ts continue to work unchanged.
 */
@customElement("span-switch")
export class SpanSwitch extends LitElement {
  @property({ type: Boolean, reflect: true }) checked = false;
  @property({ type: Boolean, reflect: true }) disabled = false;

  static override styles = css`
    :host {
      --span-switch-on: var(--switch-checked-color, var(--primary-color, #4dd9af));
      --span-switch-off: var(--switch-unchecked-track-color, rgba(120, 120, 120, 0.45));
      --span-switch-thumb-on: var(--switch-checked-button-color, #fff);
      --span-switch-thumb-off: var(--switch-unchecked-button-color, #fafafa);
      --span-switch-track-w: 36px;
      --span-switch-track-h: 20px;
      --span-switch-thumb: 14px;
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      cursor: pointer;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    :host([disabled]) {
      cursor: not-allowed;
      opacity: 0.5;
    }
    .track {
      position: relative;
      width: var(--span-switch-track-w);
      height: var(--span-switch-track-h);
      border-radius: calc(var(--span-switch-track-h) / 2);
      background: var(--span-switch-off);
      transition: background 0.2s ease;
    }
    .thumb {
      position: absolute;
      top: 50%;
      left: 3px;
      width: var(--span-switch-thumb);
      height: var(--span-switch-thumb);
      border-radius: 50%;
      background: var(--span-switch-thumb-off);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      transform: translateY(-50%);
      transition:
        left 0.2s ease,
        background 0.2s ease;
    }
    :host([checked]) .track {
      background: var(--span-switch-on);
    }
    :host([checked]) .thumb {
      left: calc(var(--span-switch-track-w) - var(--span-switch-thumb) - 3px);
      background: var(--span-switch-thumb-on);
    }
    :host(:focus-visible) .track {
      outline: 2px solid var(--span-switch-on);
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
