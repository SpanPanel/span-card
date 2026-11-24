import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { ErrorStore } from "../src/core/error-store.js";
import { MonitoringStatusCache, MonitoringStatusMultiCache } from "../src/core/monitoring-status.js";

function makeHass(responses: Array<unknown>): { hass: HomeAssistant; calls: () => number } {
  let i = 0;
  const callWS = vi.fn(async () => {
    const next = responses[i];
    i += 1;
    return { response: next };
  });
  const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
  return { hass, calls: () => i };
}

/** A cache as its controller builds it: with the error store of the view it reads for. */
function cacheWithStore(): MonitoringStatusCache {
  return new MonitoringStatusCache(new ErrorStore());
}

describe("MonitoringStatusCache", () => {
  let cache: MonitoringStatusCache;

  beforeEach(() => {
    cache = cacheWithStore();
  });

  it("coalesces concurrent in-flight fetches onto a single request", async () => {
    const { hass, calls } = makeHass([{ circuits: { c1: { utilization_pct: 50 } }, mains: {} }]);
    const [a, b, c] = await Promise.all([cache.fetch(hass), cache.fetch(hass), cache.fetch(hass)]);
    expect(calls()).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("invalidate() supersedes an in-flight fetch so stale data is not cached", async () => {
    const { hass } = makeHass([
      { circuits: { c1: { utilization_pct: 50 } }, mains: {} },
      { circuits: { c1: { utilization_pct: 95 } }, mains: {} },
    ]);
    const first = cache.fetch(hass);
    cache.invalidate();
    await first;
    // Next fetch must re-query because the invalidate superseded the
    // in-flight result and the generation counter moved forward.
    const second = await cache.fetch(hass);
    expect(second?.circuits?.c1?.utilization_pct).toBe(95);
  });

  it("asks again on the next read after one whose every retry failed — does not cache null as fresh", async () => {
    vi.useFakeTimers();
    try {
      let failing = true;
      const callWS = vi.fn(async () => {
        if (failing) throw new Error("transient");
        return { response: { circuits: { c1: { utilization_pct: 10 } }, mains: {} } };
      });
      const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;

      const first = cache.fetch(hass);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await first).toBeNull();
      failing = false;
      const second = await cache.fetch(hass);
      expect(second?.circuits?.c1?.utilization_pct).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MonitoringStatusCache with monitoring off", () => {
  it("holds no status, rather than a status of no circuits", async () => {
    const cache = cacheWithStore();
    const { hass } = makeHass([{ enabled: false }]);
    expect(await cache.fetch(hass)).toBeNull();
    expect(cache.status).toBeNull();
  });
});

describe("MonitoringStatusCache, for a panel whose config entry has not loaded", () => {
  /** What the integration answers `get_monitoring_status` with for a panel whose entry has not loaded. */
  const NOT_LOADED = {
    code: "service_validation_error",
    message: "Validation error: SPAN Panel is not loaded.",
    translation_key: "monitoring_panel_not_loaded",
    translation_placeholders: null,
    translation_domain: "span_panel",
  };

  it("takes the refusal at once, with no retry and no error, holds no status, and says it waits for the entry to load", async () => {
    const store = new ErrorStore();
    const added = vi.spyOn(store, "add");
    const callWS = vi.fn(async () => {
      throw NOT_LOADED;
    });
    const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
    const cache = new MonitoringStatusCache(store);

    expect(await cache.fetch(hass, "entry-1")).toBeNull();

    expect(callWS).toHaveBeenCalledTimes(1);
    expect(added).not.toHaveBeenCalled();
    expect(cache.status).toBeNull();
    expect(cache.awaitingLoad).toBe(true);
    store.dispose();
  });

  it("asks again on the next read, and waits no more once the entry answers", async () => {
    const store = new ErrorStore();
    let loaded = false;
    const callWS = vi.fn(async () => {
      if (!loaded) throw NOT_LOADED;
      return { response: { enabled: true, circuits: { c1: { utilization_pct: 40 } }, mains: {} } };
    });
    const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
    const cache = new MonitoringStatusCache(store);
    await cache.fetch(hass, "entry-1");

    loaded = true;
    const status = await cache.fetch(hass, "entry-1");

    expect(status?.circuits?.c1?.utilization_pct).toBe(40);
    expect(cache.awaitingLoad).toBe(false);
    store.dispose();
  });

  it("says, per entry, which entry's read waits for it to load", async () => {
    const store = new ErrorStore();
    const callWS = vi.fn(async (msg: { service_data: { config_entry_id: string } }) => {
      if (msg.service_data.config_entry_id === "entry-1") throw NOT_LOADED;
      return { response: { enabled: true, circuits: {}, mains: {} } };
    });
    const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
    const caches = new MonitoringStatusMultiCache(store);

    await Promise.all([caches.fetchOne(hass, "entry-1"), caches.fetchOne(hass, "entry-2")]);

    expect(caches.awaitingLoad("entry-1")).toBe(true);
    expect(caches.awaitingLoad("entry-2")).toBe(false);
    store.dispose();
  });
});
