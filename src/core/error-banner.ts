import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { t } from "../i18n.js";
import type { ErrorStore, ErrorEntry } from "./error-store.js";

@customElement("span-error-banner")
export class SpanErrorBanner extends LitElement {
  private _store: ErrorStore | null = null;
  private _unsub: (() => void) | null = null;

  @state() private _errors: ErrorEntry[] = [];

  set store(store: ErrorStore) {
    if (this._store === store) return;
    this._unsub?.();
    this._store = store;
    this._errors = store.active;
    this._unsub = store.subscribe(() => {
      this._errors = this._store!.active;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsub?.();
    this._unsub = null;
  }

  static styles = css`
    :host {
      display: block;
    }
    .banner-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.4;
      transition: opacity 200ms ease;
    }
    .banner-row + .banner-row {
      border-top: 1px solid rgba(128, 128, 128, 0.2);
    }
    .banner-row.level-error {
      background: color-mix(in srgb, var(--error-color, #db4437) 15%, transparent);
      color: var(--error-color, #db4437);
    }
    .banner-row.level-warning {
      background: color-mix(in srgb, var(--warning-color, #ff9800) 15%, transparent);
      color: var(--warning-color, #ff9800);
    }
    .banner-row.level-info {
      background: color-mix(in srgb, var(--info-color, #4285f4) 15%, transparent);
      color: var(--info-color, #4285f4);
    }
    .icon {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      --mdc-icon-size: 18px;
    }
    .message {
      flex: 1;
      min-width: 0;
    }
    .retry-btn {
      flex-shrink: 0;
      background: none;
      border: 1px solid currentColor;
      border-radius: 4px;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      padding: 2px 8px;
    }
    .retry-btn:hover {
      opacity: 0.8;
    }
  `;

  protected render() {
    if (this._errors.length === 0) return nothing;

    return html`${this._errors.map(
      entry => html`
        <div class="banner-row level-${entry.level}">
          <ha-icon class="icon" .icon=${this._iconForLevel(entry.level)}></ha-icon>
          <span class="message">${entry.message}</span>
          ${entry.retryFn ? html`<button class="retry-btn" @click=${() => entry.retryFn!()}>${t("error.retry")}</button>` : nothing}
        </div>
      `
    )}`;
  }

  private _iconForLevel(level: string): string {
    switch (level) {
      case "error":
        return "mdi:alert-circle";
      case "warning":
        return "mdi:alert";
      default:
        return "mdi:information";
    }
  }
}
