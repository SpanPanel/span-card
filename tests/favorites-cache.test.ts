import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { FavoritesCache } from "../src/core/favorites-store.js";

function makeHass(responses: Array<Record<string, string[]>>): { hass: HomeAssistant; callCount: () => number } {
  let i = 0;
  const callWS = vi.fn(async () => {
    const favorites = responses[i] ?? {};
    i += 1;
    return { response: { favorites } };
  });
  const hass = { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
  return { hass, callCount: () => i };
}

describe("FavoritesCache", () => {
  let cache: FavoritesCache;

  beforeEach(() => {
    cache = new FavoritesCache();
  });

  it("returns fresh data on first fetch", async () => {
    const { hass } = makeHass([{ panelA: { circuits: ["c1"], sub_devices: [] } }]);
    const map = await cache.fetch(hass);
    expect(map).toEqual({ panelA: { circuits: ["c1"], sub_devices: [] } });
  });

  it("deduplicates concurrent in-flight fetches", async () => {
    const { hass, callCount } = makeHass([{ panelA: { circuits: ["c1"], sub_devices: [] } }]);
    const [a, b] = await Promise.all([cache.fetch(hass), cache.fetch(hass)]);
    expect(callCount()).toBe(1);
    expect(a).toEqual(b);
  });

  it("invalidate() supersedes an in-flight fetch so stale data is not cached", async () => {
    // Two different backend states: pre-toggle and post-toggle.
    const { hass } = makeHass([{ panelA: { circuits: ["c1"], sub_devices: [] } }, { panelA: { circuits: ["c1", "c2"], sub_devices: [] } }]);

    const firstPromise = cache.fetch(hass);
    // User toggles a favorite → event handler invalidates the cache while
    // ``firstPromise`` is still pending. The first fetch's result must not
    // be committed to the cache as "fresh".
    cache.invalidate();
    await firstPromise;

    // A follow-up fetch must re-query the backend rather than returning
    // the now-stale pre-invalidate map from cache.
    const second = await cache.fetch(hass);
    expect(second).toEqual({ panelA: { circuits: ["c1", "c2"], sub_devices: [] } });
  });

  it("returns cached map within TTL when not invalidated", async () => {
    const { hass, callCount } = makeHass([{ panelA: { circuits: ["c1"], sub_devices: [] } }]);
    await cache.fetch(hass);
    const second = await cache.fetch(hass);
    expect(callCount()).toBe(1);
    expect(second).toEqual({ panelA: { circuits: ["c1"], sub_devices: [] } });
  });

  it("clear() drops the cached map and bumps generation", async () => {
    const { hass } = makeHass([{ panelA: { circuits: ["c1"], sub_devices: [] } }, { panelA: { circuits: [], sub_devices: [] } }]);
    await cache.fetch(hass);
    cache.clear();
    const second = await cache.fetch(hass);
    expect(second).toEqual({ panelA: { circuits: [], sub_devices: [] } });
  });
});
