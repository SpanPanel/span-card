import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { MonitoringStatusCache } from "../src/core/monitoring-status.js";

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

describe("MonitoringStatusCache", () => {
  let cache: MonitoringStatusCache;

  beforeEach(() => {
    cache = new MonitoringStatusCache();
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

  it("retries after an error — does not cache null as fresh", async () => {
    let firstCall = true;
    const callWS = vi.fn(async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error("transient");
      }
      return { response: { circuits: { c1: { utilization_pct: 10 } }, mains: {} } };
    });
    const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;

    const first = await cache.fetch(hass);
    expect(first).toBeNull();
    const second = await cache.fetch(hass);
    expect(second?.circuits?.c1?.utilization_pct).toBe(10);
  });
});
