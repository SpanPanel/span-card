import type { ErrorStore } from "./error-store.js";
import type { HomeAssistant } from "../types.js";
import { t } from "../i18n.js";
import { errorText } from "../helpers/error-text.js";

const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** How a `RetryManager` treats a rejection. */
export interface RetryPolicy {
  /**
   * Whether the caller answers this rejection itself. One it does is handed back as it came, at once: no retry, and no
   * error in the store. The card's first discovery and the sidebar dashboard's views take a refusal of a panel whose
   * config entry has not loaded this way (`isRefusedUntilEntryLoads`), and wait for the entry to load rather than retry on
   * a timer.
   */
  passThrough?: (err: unknown) => boolean;
}

export class RetryManager {
  private _store: ErrorStore;
  private readonly _passThrough: (err: unknown) => boolean;

  constructor(store: ErrorStore, { passThrough = () => false }: RetryPolicy = {}) {
    this._store = store;
    this._passThrough = passThrough;
  }

  async callWS<T>(hass: HomeAssistant, msg: Record<string, unknown>, opts?: { errorId?: string; errorMessage?: string; retries?: number }): Promise<T> {
    const maxRetries = opts?.retries ?? DEFAULT_RETRIES;
    const errorId = opts?.errorId ?? `ws:${String(msg.type ?? "unknown")}`;

    return this._withRetry(() => hass.callWS<T>(msg), maxRetries, errorId, opts?.errorMessage);
  }

  private async _withRetry<T>(fn: () => Promise<T>, maxRetries: number, errorId: string, errorMessage?: string): Promise<T> {
    // Short-circuit if any watched panel is offline — single attempt,
    // no retries. Uses ``hasAnyPanelOffline`` so it covers both the
    // legacy single-unnamed key and the per-entity keys used by the
    // Favorites multi-panel watch.
    if (this._store.hasAnyPanelOffline()) {
      try {
        const result = await fn();
        this._store.remove(errorId);
        return result;
      } catch (err) {
        if (this._passThrough(err)) throw err;
        const error = err instanceof Error ? err : new Error(errorText(err));
        this._store.add({
          key: errorId,
          level: "error",
          message: errorMessage ?? t("error.panel_offline"),
          persistent: false,
        });
        throw error;
      }
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        // Success after prior failure — clear the error
        this._store.remove(errorId);
        return result;
      } catch (err) {
        if (this._passThrough(err)) throw err;
        lastError = err instanceof Error ? err : new Error(errorText(err));
        if (attempt < maxRetries) {
          const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }

    // All retries exhausted — add error to store
    this._store.add({
      key: errorId,
      level: "error",
      message: errorMessage ?? lastError?.message ?? "Operation failed",
      persistent: false,
    });
    throw lastError ?? new Error(errorMessage ?? "Operation failed");
  }
}
