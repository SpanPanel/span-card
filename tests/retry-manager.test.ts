import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { ErrorStore } from "../src/core/error-store.js";
import { RetryManager } from "../src/core/retry-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHass(): HomeAssistant {
  return {
    states: {},
    services: {},
    language: "en",
    callService: vi.fn(),
    callWS: vi.fn(),
  } as unknown as HomeAssistant;
}

// ---------------------------------------------------------------------------
// callWS
// ---------------------------------------------------------------------------

describe("RetryManager — callWS", () => {
  let store: ErrorStore;
  let manager: RetryManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
    manager = new RetryManager(store);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("returns result on first success (1 call)", async () => {
    const hass = makeHass();
    vi.mocked(hass.callWS).mockResolvedValueOnce({ ok: true });

    const result = await manager.callWS(hass, { type: "span/get_panel" });

    expect(result).toEqual({ ok: true });
    expect(hass.callWS).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds on second attempt", async () => {
    const hass = makeHass();
    vi.mocked(hass.callWS).mockRejectedValueOnce(new Error("transient error")).mockResolvedValueOnce({ ok: true });

    const promise = manager.callWS(hass, { type: "span/get_panel" });
    await vi.advanceTimersByTimeAsync(1000); // backoff for attempt 0
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(hass.callWS).toHaveBeenCalledTimes(2);
  });

  it("adds error to store after all retries exhausted", async () => {
    const hass = makeHass();
    vi.mocked(hass.callWS).mockRejectedValue(new Error("persistent error"));

    const promise = manager.callWS(
      hass,
      {
        type: "span/get_panel",
      },
      {
        errorId: "test-ws-error",
        retries: 3,
      }
    );
    // Attach rejection handler immediately so it is never unhandled
    const caught = promise.catch(() => null);

    // Advance through all backoffs: 1000ms, 2000ms, 4000ms
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(promise).rejects.toThrow("persistent error");
    await caught;

    // 1 initial + 3 retries = 4 total calls
    expect(hass.callWS).toHaveBeenCalledTimes(4);
    expect(store.active.some(e => e.key === "test-ws-error")).toBe(true);
  });

  it("removes error from store on success after prior failure", async () => {
    const hass = makeHass();
    const errorId = "ws:span/get_panel";

    // Prime the store with a prior error for this errorId
    store.add({ key: errorId, level: "error", message: "Prior failure", persistent: false });
    expect(store.active.some(e => e.key === errorId)).toBe(true);

    vi.mocked(hass.callWS).mockResolvedValueOnce({ ok: true });

    await manager.callWS(hass, { type: "span/get_panel" });

    // Success should clear the prior error
    expect(store.active.some(e => e.key === errorId)).toBe(false);
  });

  it("respects custom retry count (retries: 1 → 2 total calls)", async () => {
    const hass = makeHass();
    vi.mocked(hass.callWS).mockRejectedValue(new Error("fail"));

    const promise = manager.callWS(hass, { type: "span/get_panel" }, { retries: 1 });
    // Attach rejection handler immediately so it is never unhandled
    const caught = promise.catch(() => null);

    await vi.advanceTimersByTimeAsync(1000); // single backoff for attempt 0
    await expect(promise).rejects.toThrow("fail");
    await caught;

    expect(hass.callWS).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });
});

// ---------------------------------------------------------------------------
// callService
// ---------------------------------------------------------------------------

describe("RetryManager — callService", () => {
  let store: ErrorStore;
  let manager: RetryManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
    manager = new RetryManager(store);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("returns on first success", async () => {
    const hass = makeHass();
    vi.mocked(hass.callService).mockResolvedValueOnce(undefined);

    await manager.callService(hass, "switch", "turn_on", { entity_id: "switch.circuit_1" });

    expect(hass.callService).toHaveBeenCalledTimes(1);
  });

  it("adds error to store after all retries exhausted", async () => {
    const hass = makeHass();
    vi.mocked(hass.callService).mockRejectedValue(new Error("service error"));

    const promise = manager.callService(hass, "switch", "turn_on", { entity_id: "switch.circuit_1" }, undefined, { errorId: "test-svc-error", retries: 3 });
    // Attach rejection handler immediately so it is never unhandled
    const caught = promise.catch(() => null);

    // Advance through all backoffs: 1000ms, 2000ms, 4000ms
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(promise).rejects.toThrow("service error");
    await caught;

    expect(store.active.some(e => e.key === "test-svc-error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// panel offline short-circuit
// ---------------------------------------------------------------------------

describe("RetryManager — panel offline short-circuit", () => {
  let store: ErrorStore;
  let manager: RetryManager;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
    manager = new RetryManager(store);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("skips retries when panel-offline is persistent — single attempt only", async () => {
    const hass = makeHass();
    // Mark panel as offline in the store
    store.add({ key: "panel-offline", level: "error", message: "Panel offline", persistent: true });

    vi.mocked(hass.callWS).mockRejectedValueOnce(new Error("offline"));

    await expect(manager.callWS(hass, { type: "span/get_panel" }, { errorId: "test-offline-ws" })).rejects.toThrow("offline");

    // Only 1 attempt — no retries
    expect(hass.callWS).toHaveBeenCalledTimes(1);
  });

  it("dispatches a transient error with 'Panel offline' message when short-circuiting", async () => {
    const hass = makeHass();
    store.add({ key: "panel-offline", level: "error", message: "Panel offline", persistent: true });

    vi.mocked(hass.callWS).mockRejectedValueOnce(new Error("offline"));

    await expect(manager.callWS(hass, { type: "span/get_panel" }, { errorId: "test-offline-ws" })).rejects.toThrow();

    const transient = store.active.find(e => e.key === "test-offline-ws");
    expect(transient).toBeDefined();
    expect(transient?.persistent).toBe(false);
    expect(transient?.message).toMatch(/Panel offline/i);
  });
});
