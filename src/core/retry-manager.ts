import type { ErrorStore } from "./error-store.js";
import type { HomeAssistant } from "../types.js";

const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RetryManager {
  private _store: ErrorStore;

  constructor(store: ErrorStore) {
    this._store = store;
  }

  async callWS<T>(hass: HomeAssistant, msg: Record<string, unknown>, opts?: { errorId?: string; errorMessage?: string; retries?: number }): Promise<T> {
    const maxRetries = opts?.retries ?? DEFAULT_RETRIES;
    const errorId = opts?.errorId ?? `ws:${String(msg.type ?? "unknown")}`;

    return this._withRetry(() => hass.callWS<T>(msg), maxRetries, errorId, opts?.errorMessage);
  }

  async callService(
    hass: HomeAssistant,
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
    opts?: { errorId?: string; errorMessage?: string; retries?: number }
  ): Promise<void> {
    const maxRetries = opts?.retries ?? DEFAULT_RETRIES;
    const errorId = opts?.errorId ?? `svc:${domain}.${service}`;

    return this._withRetry(() => hass.callService(domain, service, data, target), maxRetries, errorId, opts?.errorMessage);
  }

  private async _withRetry<T>(fn: () => Promise<T>, maxRetries: number, errorId: string, errorMessage?: string): Promise<T> {
    // Short-circuit if panel is offline
    if (this._store.hasPersistent("panel-offline")) {
      this._store.add({
        key: errorId,
        level: "error",
        message: errorMessage ?? "Panel offline — action unavailable",
        persistent: false,
      });
      return fn(); // Single attempt, no retries
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        // Success after prior failure — clear the error
        this._store.remove(errorId);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
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
    throw lastError!;
  }
}
