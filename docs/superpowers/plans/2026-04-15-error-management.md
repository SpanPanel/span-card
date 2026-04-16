# Error Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-facing error banners, retry logic, and panel offline detection to the span-card frontend so users see actionable status when the SPAN panel
is unreachable or service calls fail.

**Architecture:** A centralized ErrorStore singleton manages two lanes of errors (persistent and transient). A `<span-error-banner>` LitElement renders them at
the top of both the card and panel views. A RetryManager wraps service calls with exponential backoff. The backend adds the panel_status binary sensor entity ID
to the WebSocket topology response.

**Tech Stack:** TypeScript, Lit 3, Vitest, Home Assistant WebSocket API, Python (HA integration backend)

**Spec:** `docs/superpowers/specs/2026-04-15-error-management-design.md`

---

## File Structure

### New Files

| File                          | Responsibility                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `src/core/error-store.ts`     | ErrorStore singleton: two-lane error state, subscriptions, panel status watching |
| `src/core/retry-manager.ts`   | RetryManager: exponential backoff wrapper for callWS/callService                 |
| `src/core/error-banner.ts`    | `<span-error-banner>` LitElement component                                       |
| `tests/error-store.test.ts`   | ErrorStore unit tests                                                            |
| `tests/retry-manager.test.ts` | RetryManager unit tests                                                          |

### Backend Change

| File                                                                              | Change                                                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `custom_components/span_panel/websocket.py` (in `/Users/bflood/projects/HA/span`) | Add helper to resolve panel_status binary sensor, include in topology response |
| `tests/test_websocket.py` (in `/Users/bflood/projects/HA/span`)                   | Test the new panel_status field                                                |

### Modified Frontend Files

| File                               | Change                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `src/types.ts`                     | Add `panel_status?: string` to `PanelEntities`                               |
| `src/constants.ts`                 | Remove `ERROR_DISPLAY_MS`                                                    |
| `src/i18n.ts`                      | Add error keys for all 5 locales                                             |
| `src/card/span-panel-card.ts`      | Add banner, create ErrorStore, wire panel status watching                    |
| `src/panel/span-panel.ts`          | Add banner, create ErrorStore, wire panel status watching                    |
| `src/core/side-panel.ts`           | Remove `_showError()`, remove error-msg div, route errors through ErrorStore |
| `src/core/dashboard-controller.ts` | Replace silent catches with ErrorStore/RetryManager                          |
| `src/core/monitoring-status.ts`    | Dispatch error on fetch failure                                              |
| `src/core/graph-settings.ts`       | Dispatch error on fetch failure                                              |
| `src/core/favorites-store.ts`      | Dispatch error on fetch failure                                              |
| `src/core/area-resolver.ts`        | Dispatch warning on subscription failure                                     |
| `src/panel/tab-monitoring.ts`      | Replace silent catches with ErrorStore                                       |
| `src/card/card-discovery.ts`       | Wire retry into ErrorStore for discovery failures                            |

---

## Task 1: ErrorStore — Tests and Implementation

**Files:**

- Create: `src/core/error-store.ts`
- Create: `tests/error-store.test.ts`

- [ ] **Step 1: Write ErrorStore tests**

Create `tests/error-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorStore } from "../src/core/error-store.js";
import type { ErrorEntry } from "../src/core/error-store.js";

describe("ErrorStore", () => {
  let store: ErrorStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  describe("add / remove / active", () => {
    it("starts with no active errors", () => {
      expect(store.active).toEqual([]);
    });

    it("adds a persistent error", () => {
      store.add({
        key: "panel-offline",
        level: "error",
        message: "SPAN Panel unreachable",
        persistent: true,
      });
      expect(store.active).toHaveLength(1);
      expect(store.active[0]!.key).toBe("panel-offline");
    });

    it("adds a transient error with default TTL", () => {
      store.add({
        key: "service:relay",
        level: "error",
        message: "Relay toggle failed",
        persistent: false,
      });
      expect(store.active).toHaveLength(1);
    });

    it("auto-dismisses transient error after TTL", () => {
      store.add({
        key: "service:relay",
        level: "error",
        message: "Relay toggle failed",
        persistent: false,
        ttl: 3000,
      });
      expect(store.active).toHaveLength(1);
      vi.advanceTimersByTime(3000);
      expect(store.active).toEqual([]);
    });

    it("uses default TTL of 5000ms when ttl omitted", () => {
      store.add({
        key: "service:relay",
        level: "error",
        message: "Relay toggle failed",
        persistent: false,
      });
      vi.advanceTimersByTime(4999);
      expect(store.active).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(store.active).toEqual([]);
    });

    it("persistent errors are never auto-dismissed", () => {
      store.add({
        key: "panel-offline",
        level: "error",
        message: "SPAN Panel unreachable",
        persistent: true,
      });
      vi.advanceTimersByTime(60_000);
      expect(store.active).toHaveLength(1);
    });

    it("removes a specific error by key", () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.remove("panel-offline");
      expect(store.active).toHaveLength(1);
      expect(store.active[0]!.key).toBe("service:relay");
    });

    it("remove is a no-op for unknown key", () => {
      store.remove("nonexistent");
      expect(store.active).toEqual([]);
    });
  });

  describe("two-lane model", () => {
    it("persistent errors appear before transient errors", () => {
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      expect(store.active[0]!.key).toBe("panel-offline");
      expect(store.active[1]!.key).toBe("service:relay");
    });

    it("new transient error replaces previous transient error", () => {
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.add({ key: "service:shedding", level: "error", message: "shedding", persistent: false });
      const transient = store.active.filter(e => !e.persistent);
      expect(transient).toHaveLength(1);
      expect(transient[0]!.key).toBe("service:shedding");
    });

    it("replacing transient does not affect persistent errors", () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.add({ key: "service:shedding", level: "error", message: "shedding", persistent: false });
      expect(store.active).toHaveLength(2);
      expect(store.active[0]!.key).toBe("panel-offline");
    });

    it("multiple persistent errors can coexist", () => {
      store.add({ key: "panel-offline:panel1", level: "error", message: "Panel 1", persistent: true });
      store.add({ key: "panel-offline:panel2", level: "error", message: "Panel 2", persistent: true });
      expect(store.active.filter(e => e.persistent)).toHaveLength(2);
    });

    it("re-adding same transient key resets the TTL timer", () => {
      store.add({ key: "service:relay", level: "error", message: "first", persistent: false, ttl: 5000 });
      vi.advanceTimersByTime(4000);
      store.add({ key: "service:relay", level: "error", message: "second", persistent: false, ttl: 5000 });
      vi.advanceTimersByTime(4000);
      expect(store.active).toHaveLength(1);
      expect(store.active[0]!.message).toBe("second");
      vi.advanceTimersByTime(1000);
      expect(store.active).toEqual([]);
    });
  });

  describe("clear", () => {
    it("clears all errors when no filter", () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.clear();
      expect(store.active).toEqual([]);
    });

    it("clears only persistent errors when filtered", () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.clear({ persistent: true });
      expect(store.active).toHaveLength(1);
      expect(store.active[0]!.key).toBe("service:relay");
    });

    it("clears only transient errors when filtered", () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      store.clear({ persistent: false });
      expect(store.active).toHaveLength(1);
      expect(store.active[0]!.key).toBe("panel-offline");
    });
  });

  describe("subscribe", () => {
    it("notifies subscribers on add", () => {
      const cb = vi.fn();
      store.subscribe(cb);
      store.add({ key: "test", level: "error", message: "msg", persistent: false });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("notifies subscribers on remove", () => {
      store.add({ key: "test", level: "error", message: "msg", persistent: true });
      const cb = vi.fn();
      store.subscribe(cb);
      store.remove("test");
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("notifies on auto-dismiss", () => {
      const cb = vi.fn();
      store.subscribe(cb);
      store.add({ key: "test", level: "error", message: "msg", persistent: false, ttl: 1000 });
      cb.mockClear();
      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops notifications", () => {
      const cb = vi.fn();
      const unsub = store.subscribe(cb);
      unsub();
      store.add({ key: "test", level: "error", message: "msg", persistent: false });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("hasPersistent", () => {
    it("returns false when no persistent errors", () => {
      store.add({ key: "service:relay", level: "error", message: "relay", persistent: false });
      expect(store.hasPersistent("panel-offline")).toBe(false);
    });

    it("returns true when key exists as persistent", () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      expect(store.hasPersistent("panel-offline")).toBe(true);
    });
  });

  describe("panel status watching", () => {
    it("adds persistent error when entity state is off", () => {
      const hass = { states: { "binary_sensor.panel_status": { state: "off" } } } as any;
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass(hass);
      expect(store.hasPersistent("panel-offline")).toBe(true);
    });

    it("removes persistent error when entity state returns to on", () => {
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
      expect(store.hasPersistent("panel-offline")).toBe(true);
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "on" } } } as any);
      expect(store.hasPersistent("panel-offline")).toBe(false);
    });

    it("treats unavailable entity state as offline", () => {
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "unavailable" } } } as any);
      expect(store.hasPersistent("panel-offline")).toBe(true);
    });

    it("treats unknown entity state as offline", () => {
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "unknown" } } } as any);
      expect(store.hasPersistent("panel-offline")).toBe(true);
    });

    it("adds info message on reconnection", () => {
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "on" } } } as any);
      const info = store.active.find(e => e.level === "info");
      expect(info).toBeDefined();
      expect(info!.persistent).toBe(false);
    });

    it("does not add reconnection info on first online state", () => {
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass({ states: { "binary_sensor.panel_status": { state: "on" } } } as any);
      expect(store.active).toEqual([]);
    });

    it("handles missing entity gracefully", () => {
      store.watchPanelStatus("binary_sensor.panel_status");
      store.updateHass({ states: {} } as any);
      expect(store.hasPersistent("panel-offline")).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/error-store.test.ts`

Expected: FAIL — module `../src/core/error-store.js` not found.

- [ ] **Step 3: Implement ErrorStore**

Create `src/core/error-store.ts`:

```typescript
import { t } from "../i18n.js";
import type { HomeAssistant } from "../types.js";

const DEFAULT_ERROR_TTL = 5_000;

export interface ErrorEntry {
  key: string;
  level: "info" | "warning" | "error";
  message: string;
  persistent: boolean;
  ttl?: number;
  retryFn?: () => void;
  timestamp: number;
}

type AddInput = Omit<ErrorEntry, "timestamp">;

export class ErrorStore {
  private _persistent = new Map<string, ErrorEntry>();
  private _transient: ErrorEntry | null = null;
  private _transientTimer: ReturnType<typeof setTimeout> | null = null;
  private _subscribers = new Set<() => void>();
  private _panelStatusEntityId: string | null = null;
  private _wasOffline = false;

  add(input: AddInput): void {
    const entry: ErrorEntry = { ...input, timestamp: Date.now() };

    if (entry.persistent) {
      this._persistent.set(entry.key, entry);
    } else {
      // New transient replaces previous transient
      if (this._transientTimer !== null) {
        clearTimeout(this._transientTimer);
        this._transientTimer = null;
      }
      this._transient = entry;
      const ttl = entry.ttl ?? DEFAULT_ERROR_TTL;
      this._transientTimer = setTimeout(() => {
        this._transient = null;
        this._transientTimer = null;
        this._notify();
      }, ttl);
    }
    this._notify();
  }

  remove(key: string): void {
    const hadPersistent = this._persistent.delete(key);
    const hadTransient = this._transient?.key === key;
    if (hadTransient) {
      if (this._transientTimer !== null) {
        clearTimeout(this._transientTimer);
        this._transientTimer = null;
      }
      this._transient = null;
    }
    if (hadPersistent || hadTransient) {
      this._notify();
    }
  }

  clear(filter?: { persistent?: boolean }): void {
    if (filter === undefined) {
      this._persistent.clear();
      this._clearTransient();
    } else if (filter.persistent === true) {
      this._persistent.clear();
    } else if (filter.persistent === false) {
      this._clearTransient();
    }
    this._notify();
  }

  get active(): ErrorEntry[] {
    const result: ErrorEntry[] = [...this._persistent.values()];
    if (this._transient) {
      result.push(this._transient);
    }
    return result;
  }

  hasPersistent(key: string): boolean {
    return this._persistent.has(key);
  }

  subscribe(cb: () => void): () => void {
    this._subscribers.add(cb);
    return () => {
      this._subscribers.delete(cb);
    };
  }

  watchPanelStatus(entityId: string): void {
    this._panelStatusEntityId = entityId;
  }

  updateHass(hass: HomeAssistant): void {
    if (!this._panelStatusEntityId) return;

    const entity = hass.states[this._panelStatusEntityId];
    const isOffline = !entity || entity.state === "off" || entity.state === "unavailable" || entity.state === "unknown";

    if (isOffline && !this.hasPersistent("panel-offline")) {
      this.add({
        key: "panel-offline",
        level: "error",
        message: t("error.panel_offline"),
        persistent: true,
      });
      this._wasOffline = true;
    } else if (!isOffline && this.hasPersistent("panel-offline")) {
      this.remove("panel-offline");
      if (this._wasOffline) {
        this.add({
          key: "panel-reconnected",
          level: "info",
          message: t("error.panel_reconnected"),
          persistent: false,
        });
      }
      this._wasOffline = false;
    } else if (isOffline) {
      this._wasOffline = true;
    }
  }

  dispose(): void {
    if (this._transientTimer !== null) {
      clearTimeout(this._transientTimer);
      this._transientTimer = null;
    }
    this._subscribers.clear();
    this._persistent.clear();
    this._transient = null;
  }

  private _clearTransient(): void {
    if (this._transientTimer !== null) {
      clearTimeout(this._transientTimer);
      this._transientTimer = null;
    }
    this._transient = null;
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      cb();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/error-store.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/error-store.ts tests/error-store.test.ts
git commit -m "feat: add ErrorStore with two-lane persistent/transient error management"
```

---

## Task 2: RetryManager — Tests and Implementation

**Files:**

- Create: `src/core/retry-manager.ts`
- Create: `tests/retry-manager.test.ts`

- [ ] **Step 1: Write RetryManager tests**

Create `tests/retry-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ErrorStore } from "../src/core/error-store.js";
import { RetryManager } from "../src/core/retry-manager.js";

function makeHass(overrides: Record<string, unknown> = {}) {
  return {
    states: {},
    callWS: vi.fn(),
    callService: vi.fn(),
    ...overrides,
  } as any;
}

describe("RetryManager", () => {
  let store: ErrorStore;
  let retry: RetryManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
    retry = new RetryManager(store);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  describe("callWS", () => {
    it("returns result on first success", async () => {
      const hass = makeHass({ callWS: vi.fn().mockResolvedValue({ data: 42 }) });
      const result = await retry.callWS(hass, { type: "test" });
      expect(result).toEqual({ data: 42 });
      expect(hass.callWS).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and succeeds on second attempt", async () => {
      const hass = makeHass({
        callWS: vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ ok: true }),
      });
      const promise = retry.callWS(hass, { type: "test" });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(hass.callWS).toHaveBeenCalledTimes(2);
    });

    it("adds error to store after all retries exhausted", async () => {
      const hass = makeHass({
        callWS: vi.fn().mockRejectedValue(new Error("fail")),
      });
      await expect(async () => {
        const promise = retry.callWS(hass, { type: "test" }, { errorId: "ws:test", errorMessage: "Test failed" });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(4000);
        return promise;
      }).rejects.toThrow("fail");
      expect(hass.callWS).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      expect(store.active.some(e => e.key === "ws:test")).toBe(true);
    });

    it("removes error from store on success after prior failure", async () => {
      const hass = makeHass({
        callWS: vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok"),
      });
      // First call with prior error in store
      store.add({ key: "ws:test", level: "error", message: "old", persistent: false, ttl: 60_000 });
      const promise = retry.callWS(hass, { type: "test" }, { errorId: "ws:test" });
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      expect(store.active.some(e => e.key === "ws:test")).toBe(false);
    });

    it("respects custom retry count", async () => {
      const hass = makeHass({ callWS: vi.fn().mockRejectedValue(new Error("fail")) });
      const promise = retry.callWS(hass, { type: "test" }, { retries: 1 }).catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
      expect(hass.callWS).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    });
  });

  describe("callService", () => {
    it("returns on first success", async () => {
      const hass = makeHass({ callService: vi.fn().mockResolvedValue(undefined) });
      await retry.callService(hass, "switch", "turn_on", {}, { entity_id: "switch.test" });
      expect(hass.callService).toHaveBeenCalledTimes(1);
    });

    it("adds error to store after exhaustion", async () => {
      const hass = makeHass({ callService: vi.fn().mockRejectedValue(new Error("offline")) });
      const promise = retry.callService(hass, "switch", "turn_on", {}, {}, { errorId: "svc:relay", errorMessage: "Relay failed" }).catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await promise;
      expect(store.active.some(e => e.key === "svc:relay")).toBe(true);
    });
  });

  describe("panel offline short-circuit", () => {
    it("skips retries when panel-offline is active", async () => {
      store.add({ key: "panel-offline", level: "error", message: "offline", persistent: true });
      const hass = makeHass({ callService: vi.fn().mockRejectedValue(new Error("fail")) });
      await retry.callService(hass, "switch", "turn_on", {}, {}, { errorId: "svc:relay" }).catch(() => {});
      // Should not retry — immediate failure
      expect(hass.callService).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/retry-manager.test.ts`

Expected: FAIL — module `../src/core/retry-manager.js` not found.

- [ ] **Step 3: Implement RetryManager**

Create `src/core/retry-manager.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run tests/retry-manager.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/retry-manager.ts tests/retry-manager.test.ts
git commit -m "feat: add RetryManager with exponential backoff and panel-offline short-circuit"
```

---

## Task 3: i18n Keys and Type Updates

**Files:**

- Modify: `src/i18n.ts`
- Modify: `src/types.ts` (lines 58-65, `PanelEntities` interface)
- Modify: `src/constants.ts` (line 56, `ERROR_DISPLAY_MS`)

- [ ] **Step 1: Add error i18n keys to all 5 locales in `src/i18n.ts`**

Add the following keys to the `en` section (after the existing `"card.*"` keys block). Then add translated equivalents to the `es`, `fr`, `ja`, and `pt`
sections in the same position.

English keys to add:

```typescript
// Error banners
"error.panel_offline": "SPAN Panel unreachable",
"error.panel_offline_named": "SPAN Panel '{name}' unreachable",
"error.discovery_failed": "Unable to connect to SPAN Panel",
"error.service_failed": "Action failed",
"error.relay_failed": "Unable to toggle relay",
"error.shedding_failed": "Unable to update shedding priority",
"error.threshold_failed": "Unable to save threshold",
"error.graph_horizon_failed": "Unable to update graph time horizon",
"error.favorites_fetch_failed": "Unable to load favorites",
"error.favorites_toggle_failed": "Unable to update favorite",
"error.history_failed": "Unable to load historical data",
"error.monitoring_failed": "Unable to load monitoring status",
"error.graph_settings_failed": "Unable to load graph settings",
"error.panel_reconnected": "SPAN Panel reconnected",
"error.retry": "Retry",
"card.connecting": "Connecting to SPAN Panel...",
```

Spanish (`es`) translations:

```typescript
"error.panel_offline": "SPAN Panel inaccesible",
"error.panel_offline_named": "SPAN Panel '{name}' inaccesible",
"error.discovery_failed": "No se puede conectar al SPAN Panel",
"error.service_failed": "Acción fallida",
"error.relay_failed": "No se pudo cambiar el relé",
"error.shedding_failed": "No se pudo actualizar la prioridad de desconexión",
"error.threshold_failed": "No se pudo guardar el umbral",
"error.graph_horizon_failed": "No se pudo actualizar el horizonte temporal del gráfico",
"error.favorites_fetch_failed": "No se pudieron cargar los favoritos",
"error.favorites_toggle_failed": "No se pudo actualizar el favorito",
"error.history_failed": "No se pudieron cargar los datos históricos",
"error.monitoring_failed": "No se pudo cargar el estado de monitoreo",
"error.graph_settings_failed": "No se pudo cargar la configuración del gráfico",
"error.panel_reconnected": "SPAN Panel reconectado",
"error.retry": "Reintentar",
"card.connecting": "Conectando al SPAN Panel...",
```

French (`fr`) translations:

```typescript
"error.panel_offline": "SPAN Panel inaccessible",
"error.panel_offline_named": "SPAN Panel '{name}' inaccessible",
"error.discovery_failed": "Impossible de se connecter au SPAN Panel",
"error.service_failed": "Action échouée",
"error.relay_failed": "Impossible de basculer le relais",
"error.shedding_failed": "Impossible de mettre à jour la priorité de délestage",
"error.threshold_failed": "Impossible d'enregistrer le seuil",
"error.graph_horizon_failed": "Impossible de mettre à jour l'horizon temporel du graphique",
"error.favorites_fetch_failed": "Impossible de charger les favoris",
"error.favorites_toggle_failed": "Impossible de mettre à jour le favori",
"error.history_failed": "Impossible de charger les données historiques",
"error.monitoring_failed": "Impossible de charger l'état de surveillance",
"error.graph_settings_failed": "Impossible de charger les paramètres du graphique",
"error.panel_reconnected": "SPAN Panel reconnecté",
"error.retry": "Réessayer",
"card.connecting": "Connexion au SPAN Panel...",
```

Japanese (`ja`) translations:

```typescript
"error.panel_offline": "SPANパネルに接続できません",
"error.panel_offline_named": "SPANパネル '{name}' に接続できません",
"error.discovery_failed": "SPANパネルへの接続に失敗しました",
"error.service_failed": "操作に失敗しました",
"error.relay_failed": "リレーの切り替えに失敗しました",
"error.shedding_failed": "シェディング優先度の更新に失敗しました",
"error.threshold_failed": "しきい値の保存に失敗しました",
"error.graph_horizon_failed": "グラフの時間範囲の更新に失敗しました",
"error.favorites_fetch_failed": "お気に入りの読み込みに失敗しました",
"error.favorites_toggle_failed": "お気に入りの更新に失敗しました",
"error.history_failed": "履歴データの読み込みに失敗しました",
"error.monitoring_failed": "監視ステータスの読み込みに失敗しました",
"error.graph_settings_failed": "グラフ設定の読み込みに失敗しました",
"error.panel_reconnected": "SPANパネルが再接続されました",
"error.retry": "再試行",
"card.connecting": "SPANパネルに接続中...",
```

Portuguese (`pt`) translations:

```typescript
"error.panel_offline": "SPAN Panel inacessível",
"error.panel_offline_named": "SPAN Panel '{name}' inacessível",
"error.discovery_failed": "Não foi possível conectar ao SPAN Panel",
"error.service_failed": "Ação falhou",
"error.relay_failed": "Não foi possível alternar o relé",
"error.shedding_failed": "Não foi possível atualizar a prioridade de desligamento",
"error.threshold_failed": "Não foi possível salvar o limite",
"error.graph_horizon_failed": "Não foi possível atualizar o horizonte temporal do gráfico",
"error.favorites_fetch_failed": "Não foi possível carregar os favoritos",
"error.favorites_toggle_failed": "Não foi possível atualizar o favorito",
"error.history_failed": "Não foi possível carregar os dados históricos",
"error.monitoring_failed": "Não foi possível carregar o status de monitoramento",
"error.graph_settings_failed": "Não foi possível carregar as configurações do gráfico",
"error.panel_reconnected": "SPAN Panel reconectado",
"error.retry": "Tentar novamente",
"card.connecting": "Conectando ao SPAN Panel...",
```

- [ ] **Step 2: Add `panel_status` to `PanelEntities` in `src/types.ts`**

In `src/types.ts`, find the `PanelEntities` interface (lines 58-65) and add:

```typescript
export interface PanelEntities {
  site_power?: string;
  current_power?: string;
  feedthrough_power?: string;
  pv_power?: string;
  battery_level?: string;
  dsm_state?: string;
  panel_status?: string; // binary_sensor entity for online/offline
}
```

- [ ] **Step 3: Remove `ERROR_DISPLAY_MS` from `src/constants.ts`**

In `src/constants.ts`, remove line 56:

```typescript
export const ERROR_DISPLAY_MS = 5_000;
```

Also remove any other import of `ERROR_DISPLAY_MS` in other files. The only current consumer is `side-panel.ts` (line 4 import), which will be updated in
Task 6.

- [ ] **Step 4: Run the full test suite**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run`

Expected: All tests PASS. The i18n-validate hook (lefthook) will also check key consistency.

- [ ] **Step 5: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/i18n.ts src/types.ts src/constants.ts
git commit -m "feat: add error i18n keys, panel_status type, remove ERROR_DISPLAY_MS"
```

---

## Task 4: `<span-error-banner>` Component

**Files:**

- Create: `src/core/error-banner.ts`

- [ ] **Step 1: Implement the banner component**

Create `src/core/error-banner.ts`:

```typescript
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
    :host(:empty) {
      display: none;
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
```

- [ ] **Step 2: Verify the component type-checks**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/error-banner.ts
git commit -m "feat: add span-error-banner LitElement component"
```

---

## Task 5: Backend — Add panel_status to Topology Response

**Files:**

- Modify: `/Users/bflood/projects/HA/span/custom_components/span_panel/websocket.py`
- Modify: `/Users/bflood/projects/HA/span/tests/test_websocket.py`

- [ ] **Step 1: Write the backend test**

In `/Users/bflood/projects/HA/span/tests/test_websocket.py`, add a test that verifies the `panel_status` binary sensor entity is included in the topology
response's `panel_entities` map. Add this test to the existing integration test class that tests `handle_panel_topology`.

The test should:

1. Register a panel device
2. Register a `binary_sensor` entity with unique_id `span_sp3-242424-001_panel_status` and domain `binary_sensor`
3. Call `handle_panel_topology`
4. Assert the result's `panel_entities` contains `"panel_status"` pointing to the registered binary sensor entity_id

```python
async def test_panel_topology_includes_panel_status_entity(
    self,
    hass: HomeAssistant,
):
    """Test that panel_status binary sensor is included in panel_entities."""
    config_entry = MockConfigEntry(domain=DOMAIN, data={}, entry_id="test_entry")
    config_entry.add_to_hass(hass)

    serial = "sp3-242424-001"
    snapshot = SpanPanelSnapshotFactory(serial_number=serial, circuits={})
    coordinator = _make_coordinator(snapshot)
    config_entry.runtime_data = SpanPanelRuntimeData(coordinator=coordinator)
    hass.config_entries.async_update_entry(config_entry, state=ConfigEntryState.LOADED)

    panel_device = _register_panel_device(hass, config_entry.entry_id, serial)
    _register_entity(
        hass,
        config_entry.entry_id,
        panel_device.id,
        "binary_sensor",
        f"span_{serial}_panel_status",
        "binary_sensor.span_panel_test_panel_status",
        original_name="Panel Status",
    )

    connection = _make_mock_connection()
    await _handle_panel_topology_inner(
        hass, connection, {"id": 1, "device_id": panel_device.id}
    )
    connection.send_result.assert_called_once()
    result = connection.send_result.call_args[0][1]
    assert result["panel_entities"]["panel_status"] == "binary_sensor.span_panel_test_panel_status"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/bflood/projects/HA/span && python -m pytest tests/test_websocket.py -k "panel_status" -v`

Expected: FAIL — `panel_status` key not in `panel_entities`.

- [ ] **Step 3: Add the helper and wire it into the topology response**

In `/Users/bflood/projects/HA/span/custom_components/span_panel/websocket.py`:

1. Add the import for `build_binary_sensor_unique_id` from `id_builder`:

```python
from .id_builder import build_binary_sensor_unique_id
```

(Add alongside the existing `from .helpers import build_panel_unique_id` import.)

1. Add a helper function after `_build_panel_entity_map`:

```python
def _resolve_panel_status_entity(
    serial: str,
    entity_registry: er.EntityRegistry,
) -> str | None:
    """Resolve the panel_status binary sensor entity_id."""
    unique_id = build_binary_sensor_unique_id(serial.lower(), "panel_status")
    return entity_registry.async_get_entity_id("binary_sensor", DOMAIN, unique_id)
```

1. In `handle_panel_topology`, after the line that calls `_build_panel_entity_map` (line 135), add:

```python
panel_status_entity = _resolve_panel_status_entity(snapshot.serial_number, entity_registry)
if panel_status_entity:
    panel_entities["panel_status"] = panel_status_entity
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/bflood/projects/HA/span && python -m pytest tests/test_websocket.py -k "panel_status" -v`

Expected: PASS.

- [ ] **Step 5: Run the full backend test suite**

Run: `cd /Users/bflood/projects/HA/span && python -m pytest tests/ -q`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/bflood/projects/HA/span
git add custom_components/span_panel/websocket.py tests/test_websocket.py
git commit -m "feat: include panel_status binary sensor in topology response"
```

---

## Task 6: Wire Banner into Card (`span-panel-card.ts`)

**Files:**

- Modify: `src/card/span-panel-card.ts`

- [ ] **Step 1: Add imports**

At the top of `src/card/span-panel-card.ts`, add:

```typescript
import { ErrorStore } from "../core/error-store.js";
import "../core/error-banner.js";
```

- [ ] **Step 2: Add ErrorStore instance as a class property**

In the state properties section (around line 49-66), add:

```typescript
private _errorStore = new ErrorStore();
```

- [ ] **Step 3: Add banner to render output**

In the render method, find the State 3 branch that renders the discovered card (the `<ha-card>` return around line 164). Add the banner element as the first
child inside `<ha-card>`, above the tab bar:

```typescript
<ha-card ...>
  <span-error-banner .store=${this._errorStore}></span-error-banner>
  <!-- existing tab bar and content -->
```

- [ ] **Step 4: Wire panel status watching after discovery**

In the discovery completion code (after topology is successfully fetched), add:

```typescript
if (this._topology?.panel_entities?.panel_status) {
  this._errorStore.watchPanelStatus(this._topology.panel_entities.panel_status);
}
```

- [ ] **Step 5: Call updateHass on each hass property change**

In the `updated()` lifecycle method (around line 179), after `this._ctrl.hass = this.hass;`, add:

```typescript
this._errorStore.updateHass(this.hass);
```

- [ ] **Step 6: Wire ErrorStore into the dashboard controller**

Pass the error store to the controller so it can dispatch errors. Add a property on the controller or pass the store reference where it's constructed.

- [ ] **Step 7: Replace discovery error static div with ErrorStore**

In the `_discoverTopology()` method, replace the `this._discoveryError = ...` line with an ErrorStore persistent error:

```typescript
} catch (fallbackErr) {
  console.error("SPAN Panel: fallback discovery also failed", fallbackErr);
  this._errorStore.add({
    key: "discovery-failed",
    level: "error",
    message: t("error.discovery_failed"),
    persistent: true,
    retryFn: () => {
      this._errorStore.remove("discovery-failed");
      this._discover();
    },
  });
}
```

Update the render method to also show the banner in the not-yet-discovered state (remove the `_discoveryError` static div, use the banner instead):

```typescript
if (!this._discovered) {
  return html`
    <ha-card>
      <span-error-banner .store=${this._errorStore}></span-error-banner>
      ${this._errorStore.active.length === 0
        ? html`<div style="padding: 24px; color: var(--secondary-text-color);">${escapeHtml(t("card.connecting"))}</div>`
        : nothing}
    </ha-card>
  `;
}
```

Remove the `_discoveryError` state property if no longer needed.

- [ ] **Step 8: Dispose ErrorStore on disconnect**

Add cleanup in `disconnectedCallback`:

```typescript
disconnectedCallback(): void {
  super.disconnectedCallback();
  this._errorStore.dispose();
}
```

- [ ] **Step 9: Verify type-checks pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/card/span-panel-card.ts
git commit -m "feat: wire error banner and panel status watching into card"
```

---

## Task 7: Wire Banner into Panel (`span-panel.ts`)

**Files:**

- Modify: `src/panel/span-panel.ts`

- [ ] **Step 1: Add imports**

```typescript
import { ErrorStore } from "../core/error-store.js";
import "../core/error-banner.js";
```

- [ ] **Step 2: Add ErrorStore instance**

```typescript
private _errorStore = new ErrorStore();
```

- [ ] **Step 3: Add banner to render output**

Place `<span-error-banner .store=${this._errorStore}></span-error-banner>` below the header/panel selector and above the tab content in the render method.

- [ ] **Step 4: Wire panel status watching after discovery**

After device discovery completes, for each panel's topology, call:

```typescript
if (topology?.panel_entities?.panel_status) {
  this._errorStore.watchPanelStatus(topology.panel_entities.panel_status);
}
```

- [ ] **Step 5: Call updateHass on hass property changes**

In the `updated()` method (around line 240), add:

```typescript
this._errorStore.updateHass(this.hass);
```

- [ ] **Step 6: Surface favorites fetch errors**

In `_loadFavorites()` (around line 605), replace the silent catch:

```typescript
} catch (err) {
  console.warn("SPAN Panel: favorites fetch failed", err);
  this._errorStore.add({
    key: "fetch:favorites",
    level: "warning",
    message: t("error.favorites_fetch_failed"),
    persistent: false,
  });
  return {};
}
```

- [ ] **Step 7: Surface device discovery errors**

In the discovery error catch block, add:

```typescript
this._errorStore.add({
  key: "discovery-failed",
  level: "error",
  message: t("error.discovery_failed"),
  persistent: true,
  retryFn: () => {
    this._errorStore.remove("discovery-failed");
    this._discoverPanels();
  },
});
```

- [ ] **Step 8: Dispose on disconnect**

```typescript
disconnectedCallback(): void {
  super.disconnectedCallback();
  this._errorStore.dispose();
}
```

- [ ] **Step 9: Verify type-checks pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/panel/span-panel.ts
git commit -m "feat: wire error banner and panel status watching into panel"
```

---

## Task 8: Replace Side Panel Error Handling

**Files:**

- Modify: `src/core/side-panel.ts`

- [ ] **Step 1: Add ErrorStore property and remove old error machinery**

1. Remove `ERROR_DISPLAY_MS` from the import on line 4.
2. Add a public `errorStore` property:

```typescript
errorStore: ErrorStore | null = null;
```

1. Remove the `_showError()` method (lines 1393-1402).
2. Remove all three `error-msg` div creation blocks (in `_buildPanelMode` ~line 666, `_buildCircuitMode` ~line 415, `_buildSubDeviceMode` ~line 873). Remove the
   div element creation (5 lines each: createElement, className, id, style.display, appendChild).

- [ ] **Step 2: Replace all `_showError()` call sites with ErrorStore**

Replace each `.catch((err: Error) => this._showError(...))` pattern. For example:

**Relay toggle** (around line 1011):

Before:

```typescript
.catch((err: Error) => this._showError(`${t("sidepanel.relay_failed")} ${err.message ?? err}`))
```

After:

```typescript
.catch((err: Error) => {
  this.errorStore?.add({
    key: "service:relay",
    level: "error",
    message: `${t("error.relay_failed")}`,
    persistent: false,
  });
})
```

**Graph horizon changes** (around lines 465, 523, 551, 615, 643, 948, 955, 1122, 1132):

Replace each `_showError(...)` with:

```typescript
this.errorStore?.add({
  key: "service:graph_horizon",
  level: "error",
  message: t("error.graph_horizon_failed"),
  persistent: false,
});
```

**Shedding** (around line 1057):

```typescript
this.errorStore?.add({
  key: "service:shedding",
  level: "error",
  message: t("error.shedding_failed"),
  persistent: false,
});
```

**Monitoring** (around lines 1213, 1228, 1270, 1331):

```typescript
this.errorStore?.add({
  key: "service:monitoring",
  level: "error",
  message: t("error.threshold_failed"),
  persistent: false,
});
```

**Favorites** (around line 830):

```typescript
this.errorStore?.add({
  key: "service:favorites",
  level: "error",
  message: t("error.favorites_toggle_failed"),
  persistent: false,
});
```

- [ ] **Step 3: Pass errorStore from card and panel components**

In `span-panel-card.ts`, wherever the side panel is constructed or accessed, set its errorStore property:

```typescript
sidePanel.errorStore = this._errorStore;
```

Same in `span-panel.ts`.

- [ ] **Step 4: Remove error-msg CSS if it exists in card-styles**

Search for `.error-msg` CSS rules in the styles and remove them since the div no longer exists.

- [ ] **Step 5: Verify type-checks pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/side-panel.ts src/card/span-panel-card.ts src/panel/span-panel.ts
git commit -m "refactor: replace side panel _showError with ErrorStore dispatch"
```

---

## Task 9: Replace Dashboard Controller Silent Catches

**Files:**

- Modify: `src/core/dashboard-controller.ts`

- [ ] **Step 1: Add ErrorStore and RetryManager properties**

Add imports and a property for the store:

```typescript
import type { ErrorStore } from "./error-store.js";
import { RetryManager } from "./retry-manager.js";
```

Add properties to the class:

```typescript
private _errorStore: ErrorStore | null = null;
private _retryManager: RetryManager | null = null;

set errorStore(store: ErrorStore) {
  this._errorStore = store;
  this._retryManager = new RetryManager(store);
}
```

- [ ] **Step 2: Replace switch toggle catch (line 367)**

Before:

```typescript
this._hass.callService("switch", service, {}, { entity_id: switchEntity }).catch(err => {
  console.error("SPAN Panel: switch service call failed:", err);
});
```

After:

```typescript
if (this._retryManager) {
  this._retryManager
    .callService(
      this._hass,
      "switch",
      service,
      {},
      { entity_id: switchEntity },
      {
        errorId: "service:relay",
        errorMessage: t("error.relay_failed"),
      }
    )
    .catch(() => {});
} else {
  this._hass.callService("switch", service, {}, { entity_id: switchEntity }).catch(() => {});
}
```

Add `import { t } from "../i18n.js";` if not already imported.

- [ ] **Step 3: Replace history refresh catch (line 314)**

Before:

```typescript
} catch {
  // Will refresh on next interval
}
```

After:

```typescript
} catch {
  this._errorStore?.add({
    key: "fetch:history",
    level: "warning",
    message: t("error.history_failed"),
    persistent: false,
  });
}
```

- [ ] **Step 4: Replace graph settings fetch catch (line 148-159)**

Before:

```typescript
} catch {
  // Graph settings unavailable -- use defaults
}
```

After:

```typescript
} catch {
  this._errorStore?.add({
    key: "fetch:graph_settings",
    level: "warning",
    message: t("error.graph_settings_failed"),
    persistent: false,
  });
}
```

- [ ] **Step 5: Wire errorStore from card**

In `span-panel-card.ts`, after creating the controller, set:

```typescript
this._ctrl.errorStore = this._errorStore;
```

Same in `span-panel.ts` for its controller instances.

- [ ] **Step 6: Verify type-checks pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/dashboard-controller.ts src/card/span-panel-card.ts src/panel/span-panel.ts
git commit -m "feat: replace dashboard controller silent catches with ErrorStore"
```

---

## Task 10: Surface Errors in Cache Stores and Area Resolver

**Files:**

- Modify: `src/core/monitoring-status.ts`
- Modify: `src/core/graph-settings.ts`
- Modify: `src/core/favorites-store.ts`
- Modify: `src/core/area-resolver.ts`

Each cache store needs an optional `errorStore` property. When a fetch fails, dispatch a transient error in addition to the existing fallback behavior.

- [ ] **Step 1: Add errorStore to MonitoringStatusCache**

In `src/core/monitoring-status.ts`, add to the `MonitoringStatusCache` class:

```typescript
errorStore: ErrorStore | null = null;
```

Add import:

```typescript
import type { ErrorStore } from "./error-store.js";
```

In the `fetch()` method's catch block (line 43), add:

```typescript
} catch {
  this._status = null;
  this.errorStore?.add({
    key: "fetch:monitoring",
    level: "warning",
    message: t("error.monitoring_failed"),
    persistent: false,
  });
}
```

- [ ] **Step 2: Add errorStore to GraphSettingsCache**

In `src/core/graph-settings.ts`, add to the `GraphSettingsCache` class:

```typescript
errorStore: ErrorStore | null = null;
```

Add import:

```typescript
import type { ErrorStore } from "./error-store.js";
import { t } from "../i18n.js";
```

(Note: `t` may not yet be imported in this file — add it.)

In the `fetch()` method's catch block (line 49), add:

```typescript
} catch {
  this._settings = null;
  this.errorStore?.add({
    key: "fetch:graph_settings",
    level: "warning",
    message: t("error.graph_settings_failed"),
    persistent: false,
  });
}
```

- [ ] **Step 3: Add errorStore to FavoritesCache**

In `src/core/favorites-store.ts`, add to the `FavoritesCache` class:

```typescript
errorStore: ErrorStore | null = null;
```

Add import:

```typescript
import type { ErrorStore } from "./error-store.js";
import { t } from "../i18n.js";
```

In the `fetch()` method's catch block (line 98), add:

```typescript
} catch {
  this.errorStore?.add({
    key: "fetch:favorites",
    level: "warning",
    message: t("error.favorites_fetch_failed"),
    persistent: false,
  });
  return this._map ?? {};
}
```

- [ ] **Step 4: Update area-resolver.ts**

In `src/core/area-resolver.ts`, add an optional errorStore parameter to `subscribeAreaUpdates`:

```typescript
export async function subscribeAreaUpdates(
  hass: HomeAssistant,
  topology: PanelTopology,
  callback: () => void,
  errorStore?: ErrorStore | null,
): Promise<() => void> {
```

Add import:

```typescript
import type { ErrorStore } from "./error-store.js";
import { t } from "../i18n.js";
```

In the handler's catch block (line 114), add alongside the console.warn:

```typescript
} catch (err) {
  console.warn("[span-panel] area registry update failed:", err);
  errorStore?.add({
    key: "fetch:areas",
    level: "warning",
    message: "Unable to update area assignments",
    persistent: false,
  });
}
```

- [ ] **Step 5: Wire errorStore into cache instances from controllers**

In `dashboard-controller.ts`, when `errorStore` is set, propagate to caches:

```typescript
set errorStore(store: ErrorStore) {
  this._errorStore = store;
  this._retryManager = new RetryManager(store);
  this.monitoringCache.errorStore = store;
  this.graphSettingsCache.errorStore = store;
}
```

In `span-panel-card.ts` and `span-panel.ts`, pass errorStore to any `FavoritesCache` instances and `subscribeAreaUpdates` calls.

- [ ] **Step 6: Verify type-checks pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 7: Run full test suite**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run`

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/core/monitoring-status.ts src/core/graph-settings.ts \
  src/core/favorites-store.ts src/core/area-resolver.ts \
  src/core/dashboard-controller.ts src/card/span-panel-card.ts \
  src/panel/span-panel.ts
git commit -m "feat: surface cache fetch and area resolver errors via ErrorStore"
```

---

## Task 11: Replace Tab Monitoring Silent Catches

**Files:**

- Modify: `src/panel/tab-monitoring.ts`

- [ ] **Step 1: Add ErrorStore property**

```typescript
errorStore: ErrorStore | null = null;
```

Add import:

```typescript
import type { ErrorStore } from "../core/error-store.js";
import { t } from "../i18n.js";
```

- [ ] **Step 2: Replace silent catches (lines 669, 679)**

Replace each `.catch(() => {})` with:

```typescript
.catch(() => {
  this.errorStore?.add({
    key: "service:monitoring",
    level: "error",
    message: t("error.threshold_failed"),
    persistent: false,
  });
})
```

- [ ] **Step 3: Wire errorStore from parent**

In `span-panel.ts`, wherever `tab-monitoring` is constructed/accessed, pass:

```typescript
tabMonitoring.errorStore = this._errorStore;
```

- [ ] **Step 4: Verify type-checks pass**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add src/panel/tab-monitoring.ts src/panel/span-panel.ts
git commit -m "feat: replace tab-monitoring silent catches with ErrorStore"
```

---

## Task 12: Final Verification and Build

**Files:** None new — verification only.

- [ ] **Step 1: Run full frontend test suite**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx vitest run`

Expected: All tests PASS.

- [ ] **Step 2: Run type-check**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Run ESLint**

Run: `cd /Users/bflood/projects/HA/cards/span-card && npx eslint src/ --ext .ts`

Expected: No errors.

- [ ] **Step 4: Run full backend test suite**

Run: `cd /Users/bflood/projects/HA/span && python -m pytest tests/ -q`

Expected: All tests PASS.

- [ ] **Step 5: Build and sync frontend**

Run: `/sync-frontend` skill or:

```bash
cd /Users/bflood/projects/HA/cards/span-card && ./scripts/build-frontend.sh
```

Expected: Build succeeds. Dist files updated.

- [ ] **Step 6: Verify in browser**

Start HA dev server and verify:

1. With panel online: no banner visible
2. Simulate panel offline (stop SPAN panel or mock entity state): red banner appears "SPAN Panel unreachable"
3. Attempt relay toggle while offline: transient error appears below persistent banner
4. Restore panel online: persistent banner disappears, brief "SPAN Panel reconnected" info appears
5. Trigger a service call error: transient error appears with auto-dismiss

- [ ] **Step 7: Commit build artifacts if needed**

```bash
cd /Users/bflood/projects/HA/cards/span-card
git add -A
git commit -m "build: sync frontend dist with error management changes"
```
