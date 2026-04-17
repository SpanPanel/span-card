import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { ErrorStore } from "../src/core/error-store.js";
import type { ErrorEntry } from "../src/core/error-store.js";
import { tf, setLanguage } from "../src/i18n.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHass(entityId: string, state: string): HomeAssistant {
  return {
    states: {
      [entityId]: {
        entity_id: entityId,
        state,
        attributes: {},
        last_changed: "",
        last_updated: "",
      },
    },
    services: {},
    language: "en",
    callService: vi.fn(),
    callWS: vi.fn(),
  } as unknown as HomeAssistant;
}

function makeEmptyHass(): HomeAssistant {
  return {
    states: {},
    services: {},
    language: "en",
    callService: vi.fn(),
    callWS: vi.fn(),
  } as unknown as HomeAssistant;
}

// ---------------------------------------------------------------------------
// add / remove / active
// ---------------------------------------------------------------------------

describe("ErrorStore — add/remove/active", () => {
  let store: ErrorStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("starts empty", () => {
    expect(store.active).toHaveLength(0);
  });

  it("adds a persistent error", () => {
    store.add({ key: "p1", level: "error", message: "Persistent", persistent: true });
    expect(store.active).toHaveLength(1);
    expect(store.active[0]?.key).toBe("p1");
    expect(store.active[0]?.persistent).toBe(true);
  });

  it("adds a transient error with default TTL and auto-dismisses after 5000ms", () => {
    store.add({ key: "t1", level: "warning", message: "Transient", persistent: false });
    expect(store.active).toHaveLength(1);

    vi.advanceTimersByTime(4999);
    expect(store.active).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(store.active).toHaveLength(0);
  });

  it("persistent errors are never auto-dismissed", () => {
    store.add({ key: "p1", level: "error", message: "Persistent", persistent: true });
    vi.advanceTimersByTime(60_000);
    expect(store.active).toHaveLength(1);
  });

  it("removes a persistent error by key", () => {
    store.add({ key: "p1", level: "error", message: "Persistent", persistent: true });
    store.remove("p1");
    expect(store.active).toHaveLength(0);
  });

  it("removes the transient error by key", () => {
    store.add({ key: "t1", level: "info", message: "Transient", persistent: false });
    store.remove("t1");
    expect(store.active).toHaveLength(0);
  });

  it("remove is a no-op for unknown key", () => {
    store.add({ key: "p1", level: "error", message: "Persistent", persistent: true });
    store.remove("unknown-key");
    expect(store.active).toHaveLength(1);
  });

  it("transient entry with custom TTL auto-dismisses after custom duration", () => {
    store.add({ key: "t1", level: "info", message: "Short", persistent: false, ttl: 1000 });
    vi.advanceTimersByTime(999);
    expect(store.active).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.active).toHaveLength(0);
  });

  it("active includes timestamp", () => {
    const before = Date.now();
    store.add({ key: "p1", level: "error", message: "M", persistent: true });
    const entry = store.active[0] as ErrorEntry;
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Two-lane model
// ---------------------------------------------------------------------------

describe("ErrorStore — two-lane model", () => {
  let store: ErrorStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("persistent appears before transient", () => {
    store.add({ key: "p1", level: "error", message: "Persistent", persistent: true });
    store.add({ key: "t1", level: "info", message: "Transient", persistent: false });
    const active = store.active;
    expect(active).toHaveLength(2);
    expect(active[0]?.key).toBe("p1");
    expect(active[1]?.key).toBe("t1");
  });

  it("new transient replaces previous transient", () => {
    store.add({ key: "t1", level: "info", message: "First", persistent: false });
    store.add({ key: "t2", level: "warning", message: "Second", persistent: false });
    const active = store.active;
    expect(active).toHaveLength(1);
    expect(active[0]?.key).toBe("t2");
  });

  it("replacing transient does not affect persistent", () => {
    store.add({ key: "p1", level: "error", message: "Persistent", persistent: true });
    store.add({ key: "t1", level: "info", message: "First transient", persistent: false });
    store.add({ key: "t2", level: "info", message: "Second transient", persistent: false });
    expect(store.active).toHaveLength(2);
    expect(store.active[0]?.key).toBe("p1");
    expect(store.active[1]?.key).toBe("t2");
  });

  it("multiple persistent can coexist", () => {
    store.add({ key: "p1", level: "error", message: "P1", persistent: true });
    store.add({ key: "p2", level: "warning", message: "P2", persistent: true });
    store.add({ key: "p3", level: "error", message: "P3", persistent: true });
    expect(store.active).toHaveLength(3);
    const keys = store.active.map(e => e.key);
    expect(keys).toContain("p1");
    expect(keys).toContain("p2");
    expect(keys).toContain("p3");
  });

  it("re-adding the same transient key resets TTL timer", () => {
    store.add({ key: "t1", level: "info", message: "Transient", persistent: false, ttl: 5000 });

    // Advance 4000ms — still alive
    vi.advanceTimersByTime(4000);
    expect(store.active).toHaveLength(1);

    // Re-add with same key — should reset timer
    store.add({ key: "t1", level: "info", message: "Transient", persistent: false, ttl: 5000 });

    // Another 4000ms — still alive because the timer was reset
    vi.advanceTimersByTime(4000);
    expect(store.active).toHaveLength(1);

    // The remaining 1000ms passes — now it dismisses
    vi.advanceTimersByTime(1001);
    expect(store.active).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("ErrorStore — clear", () => {
  let store: ErrorStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("clear with no filter clears everything", () => {
    store.add({ key: "p1", level: "error", message: "P1", persistent: true });
    store.add({ key: "p2", level: "warning", message: "P2", persistent: true });
    store.add({ key: "t1", level: "info", message: "T1", persistent: false });
    store.clear();
    expect(store.active).toHaveLength(0);
  });

  it("clear({ persistent: true }) clears only persistent", () => {
    store.add({ key: "p1", level: "error", message: "P1", persistent: true });
    store.add({ key: "t1", level: "info", message: "T1", persistent: false });
    store.clear({ persistent: true });
    expect(store.active).toHaveLength(1);
    expect(store.active[0]?.key).toBe("t1");
  });

  it("clear({ persistent: false }) clears only transient", () => {
    store.add({ key: "p1", level: "error", message: "P1", persistent: true });
    store.add({ key: "t1", level: "info", message: "T1", persistent: false });
    store.clear({ persistent: false });
    expect(store.active).toHaveLength(1);
    expect(store.active[0]?.key).toBe("p1");
  });

  it("resets panel status watching state on full clear", () => {
    store.watchPanelStatus("binary_sensor.panel_status");
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(true);

    store.clear();

    // After clear, updateHass should not re-add the panel-offline error
    // because the watched entity ID was reset.
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(false);
  });

  it("does not reset panel status watching on filtered clear", () => {
    store.watchPanelStatus("binary_sensor.panel_status");
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);

    store.clear({ persistent: true });

    // Watched entity is still set; re-firing updateHass re-adds panel-offline
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

describe("ErrorStore — subscribe", () => {
  let store: ErrorStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("notifies on add", () => {
    const cb = vi.fn();
    store.subscribe(cb);
    store.add({ key: "p1", level: "error", message: "M", persistent: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("notifies on remove", () => {
    const cb = vi.fn();
    store.add({ key: "p1", level: "error", message: "M", persistent: true });
    store.subscribe(cb);
    store.remove("p1");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("notifies on auto-dismiss of transient", () => {
    const cb = vi.fn();
    store.add({ key: "t1", level: "info", message: "T", persistent: false, ttl: 1000 });
    store.subscribe(cb);
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    unsub();
    store.add({ key: "p1", level: "error", message: "M", persistent: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("remove on unknown key does not notify", () => {
    const cb = vi.fn();
    store.subscribe(cb);
    store.remove("does-not-exist");
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hasPersistent
// ---------------------------------------------------------------------------

describe("ErrorStore — hasPersistent", () => {
  let store: ErrorStore;

  beforeEach(() => {
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
  });

  it("returns false when persistent error is not present", () => {
    expect(store.hasPersistent("panel-offline")).toBe(false);
  });

  it("returns true when persistent error is present", () => {
    store.add({ key: "panel-offline", level: "error", message: "Offline", persistent: true });
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });

  it("returns false after the error is removed", () => {
    store.add({ key: "panel-offline", level: "error", message: "Offline", persistent: true });
    store.remove("panel-offline");
    expect(store.hasPersistent("panel-offline")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// watchPanelStatus / updateHass
// ---------------------------------------------------------------------------

describe("ErrorStore — panel status watching", () => {
  const ENTITY_ID = "binary_sensor.span_panel_door";
  let store: ErrorStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
    store.watchPanelStatus(ENTITY_ID);
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("adds persistent panel-offline error when entity state is 'off'", () => {
    store.updateHass(makeHass(ENTITY_ID, "off"));
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });

  it("removes panel-offline error when entity state becomes 'on'", () => {
    store.updateHass(makeHass(ENTITY_ID, "off"));
    expect(store.hasPersistent("panel-offline")).toBe(true);
    store.updateHass(makeHass(ENTITY_ID, "on"));
    expect(store.hasPersistent("panel-offline")).toBe(false);
  });

  it("treats 'unavailable' as offline", () => {
    store.updateHass(makeHass(ENTITY_ID, "unavailable"));
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });

  it("treats 'unknown' as offline", () => {
    store.updateHass(makeHass(ENTITY_ID, "unknown"));
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });

  it("adds transient reconnection info message on reconnect (but not on first online)", () => {
    // First updateHass with "on" — should NOT add reconnection info
    store.updateHass(makeHass(ENTITY_ID, "on"));
    const afterFirstOnline = store.active.filter(e => e.key === "panel-reconnected");
    expect(afterFirstOnline).toHaveLength(0);

    // Now go offline and then online — reconnection info should appear
    store.updateHass(makeHass(ENTITY_ID, "off"));
    store.updateHass(makeHass(ENTITY_ID, "on"));
    const afterReconnect = store.active.filter(e => e.key === "panel-reconnected");
    expect(afterReconnect).toHaveLength(1);
    expect(afterReconnect[0]?.level).toBe("info");
    expect(afterReconnect[0]?.persistent).toBe(false);
  });

  it("handles missing entity gracefully (no error entity_id → treated as offline)", () => {
    store.updateHass(makeEmptyHass());
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });

  it("does not add reconnection info when online has always been online", () => {
    store.updateHass(makeHass(ENTITY_ID, "on"));
    store.updateHass(makeHass(ENTITY_ID, "on"));
    const reconnected = store.active.filter(e => e.key === "panel-reconnected");
    expect(reconnected).toHaveLength(0);
  });

  it("resets was-offline state when switching watched entity", () => {
    store.watchPanelStatus("binary_sensor.panel_a");
    store.updateHass({ states: { "binary_sensor.panel_a": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(true);

    // Switch to a different panel that is online
    store.watchPanelStatus("binary_sensor.panel_b");
    store.updateHass({ states: { "binary_sensor.panel_b": { state: "on" } } } as any);

    // No spurious "reconnected" info should appear for panel B
    expect(store.hasPersistent("panel-offline")).toBe(false);
    expect(store.active.filter(e => e.level === "info")).toHaveLength(0);
  });

  it("clearPanelStatusWatch resets state", () => {
    store.watchPanelStatus("binary_sensor.panel_a");
    store.updateHass({ states: { "binary_sensor.panel_a": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(true);

    store.clearPanelStatusWatch();
    expect(store.hasPersistent("panel-offline")).toBe(false);

    // Further updateHass should be a no-op
    store.updateHass({ states: { "binary_sensor.panel_a": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(false);
  });

  it("clear() with no filter resets panel status watching state", () => {
    store.watchPanelStatus("binary_sensor.panel_status");
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(true);

    store.clear();

    // After full clear, updateHass should be a no-op (no watched entity)
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(false);
  });

  it("clear({persistent: true}) preserves panel status watching state", () => {
    store.watchPanelStatus("binary_sensor.panel_status");
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "on" } } } as any);

    // Add a persistent error of a different key
    store.add({ key: "discovery-failed", level: "error", message: "x", persistent: true });
    store.clear({ persistent: true });

    // Watch is preserved — updateHass with off state re-adds panel-offline
    store.updateHass({ states: { "binary_sensor.panel_status": { state: "off" } } } as any);
    expect(store.hasPersistent("panel-offline")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// watchPanelStatuses — multi-panel status watching
// ---------------------------------------------------------------------------

describe("ErrorStore — multi-panel status watching", () => {
  const ENTITY_A = "binary_sensor.span_panel_1_panel_status";
  const ENTITY_B = "binary_sensor.span_panel_2_panel_status";
  let store: ErrorStore;

  function makeMultiHass(states: Record<string, string>): HomeAssistant {
    const built: Record<string, { entity_id: string; state: string; attributes: object; last_changed: string; last_updated: string }> = {};
    for (const [entityId, state] of Object.entries(states)) {
      built[entityId] = {
        entity_id: entityId,
        state,
        attributes: {},
        last_changed: "",
        last_updated: "",
      };
    }
    return {
      states: built,
      services: {},
      language: "en",
      callService: vi.fn(),
      callWS: vi.fn(),
    } as unknown as HomeAssistant;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ErrorStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("adds one named persistent row per offline entity", () => {
    store.watchPanelStatuses([
      { entityId: ENTITY_A, panelName: "Panel A" },
      { entityId: ENTITY_B, panelName: "Panel B" },
    ]);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off", [ENTITY_B]: "off" }));

    const rows = store.active.filter(e => e.key.startsWith("panel-offline"));
    expect(rows).toHaveLength(2);
    const messages = rows.map(r => r.message).sort();
    expect(messages).toEqual(["Panel A unreachable", "Panel B unreachable"]);

    // Legacy unnamed key must NOT be present when named entries are used.
    expect(store.hasPersistent("panel-offline")).toBe(false);
    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(true);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(true);
  });

  it("transitioning single-unnamed → multi-named clears the legacy key", () => {
    store.watchPanelStatus(ENTITY_A);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off" }));
    expect(store.hasPersistent("panel-offline")).toBe(true);

    store.watchPanelStatuses([{ entityId: ENTITY_A, panelName: "Panel A" }]);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off" }));

    expect(store.hasPersistent("panel-offline")).toBe(false);
    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(true);
    const row = store.active.find(e => e.key === `panel-offline:${ENTITY_A}`);
    expect(row?.message).toBe("Panel A unreachable");
  });

  it("transitioning multi-named → single-unnamed clears named keys", () => {
    store.watchPanelStatuses([
      { entityId: ENTITY_A, panelName: "Panel A" },
      { entityId: ENTITY_B, panelName: "Panel B" },
    ]);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off", [ENTITY_B]: "off" }));
    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(true);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(true);

    store.watchPanelStatus(ENTITY_A);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off" }));

    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(false);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(false);
    expect(store.hasPersistent("panel-offline")).toBe(true);
    const row = store.active.find(e => e.key === "panel-offline");
    expect(row?.message).toBe("SPAN Panel unreachable");
  });

  it("named reconnect emits a scoped transient toast", () => {
    store.watchPanelStatuses([
      { entityId: ENTITY_A, panelName: "Panel A" },
      { entityId: ENTITY_B, panelName: "Panel B" },
    ]);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off", [ENTITY_B]: "off" }));

    // Panel A reconnects; Panel B still offline.
    store.updateHass(makeMultiHass({ [ENTITY_A]: "on", [ENTITY_B]: "off" }));

    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(false);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(true);

    const reconnect = store.active.find(e => e.key === `panel-reconnected:${ENTITY_A}`);
    expect(reconnect).toBeDefined();
    expect(reconnect?.level).toBe("info");
    expect(reconnect?.persistent).toBe(false);
    expect(reconnect?.message).toBe("Panel A reconnected");
  });

  it("re-calling watchPanelStatuses with a carry-over entity preserves wasOffline", () => {
    // First call: A is offline.
    store.watchPanelStatuses([{ entityId: ENTITY_A, panelName: "Panel A" }]);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off" }));

    // Second call: add B. A is still being watched; its wasOffline should carry.
    store.watchPanelStatuses([
      { entityId: ENTITY_A, panelName: "Panel A" },
      { entityId: ENTITY_B, panelName: "Panel B" },
    ]);

    // Now A comes online. Because wasOffline carried, we expect a reconnect toast.
    store.updateHass(makeMultiHass({ [ENTITY_A]: "on", [ENTITY_B]: "on" }));

    const reconnect = store.active.find(e => e.key === `panel-reconnected:${ENTITY_A}`);
    expect(reconnect).toBeDefined();
    expect(reconnect?.message).toBe("Panel A reconnected");

    // B was never offline, so no reconnect toast for B.
    expect(store.active.find(e => e.key === `panel-reconnected:${ENTITY_B}`)).toBeUndefined();
  });

  it("carries wasOffline across single-unnamed → multi-named transition for same entity", () => {
    // Start with legacy single-unnamed watch; go offline.
    store.watchPanelStatus(ENTITY_A);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off" }));
    expect(store.hasPersistent("panel-offline")).toBe(true);

    // Upgrade to named watch for the same entity id. The wasOffline flag
    // must carry even across the naming-mode change.
    store.watchPanelStatuses([{ entityId: ENTITY_A, panelName: "Panel A" }]);

    // Now come online. Because wasOffline carried, the named reconnect
    // toast must fire.
    store.updateHass(makeMultiHass({ [ENTITY_A]: "on" }));
    const reconnect = store.active.find(e => e.key === `panel-reconnected:${ENTITY_A}`);
    expect(reconnect).toBeDefined();
    expect(reconnect?.message).toBe("Panel A reconnected");
  });

  it("clearPanelStatusWatch removes all watched entries (single and multi)", () => {
    store.watchPanelStatuses([
      { entityId: ENTITY_A, panelName: "Panel A" },
      { entityId: ENTITY_B, panelName: "Panel B" },
    ]);
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off", [ENTITY_B]: "off" }));
    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(true);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(true);

    store.clearPanelStatusWatch();

    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(false);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(false);
    // After clear, updateHass is a no-op
    store.updateHass(makeMultiHass({ [ENTITY_A]: "off", [ENTITY_B]: "off" }));
    expect(store.hasPersistent(`panel-offline:${ENTITY_A}`)).toBe(false);
    expect(store.hasPersistent(`panel-offline:${ENTITY_B}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tf() — translation with placeholder substitution
// ---------------------------------------------------------------------------

describe("tf — translation with {placeholder} substitution", () => {
  beforeEach(() => {
    setLanguage("en");
  });

  it("substitutes {name} in error.panel_offline_named", () => {
    expect(tf("error.panel_offline_named", { name: "Span Panel 2" })).toBe("Span Panel 2 unreachable");
  });

  it("renders {name} as a literal token when the variable is missing", () => {
    expect(tf("error.panel_offline_named", {})).toBe("{name} unreachable");
  });

  it("substitutes {name} in error.panel_reconnected_named", () => {
    expect(tf("error.panel_reconnected_named", { name: "Span Panel 2" })).toBe("Span Panel 2 reconnected");
  });

  it("falls back to English template when key is missing in active language", () => {
    setLanguage("es");
    // Spanish template: "{name} inaccesible"
    expect(tf("error.panel_offline_named", { name: "X" })).toBe("X inaccesible");
  });
});
