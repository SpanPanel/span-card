import { describe, it, expect, vi } from "vitest";
import { subscribeEntryReloads, type ConfigEntrySummary } from "../src/core/entry-reload.js";
import { ENTRY_RELOADS, FakeConnection, hassWith } from "./fake-connection.js";

/**
 * A reload is how the integration adds or removes a circuit's controls, and an
 * entry reaching `loaded` is the first moment its registry is complete. Every
 * `type: null` batch after the first is a re-seed: it follows a reconnect, and
 * across a Home Assistant restart an entry goes loaded → gone → loaded without
 * any transition being reported.
 */

function entry(entry_id: string, state: string, domain = "span_panel"): ConfigEntrySummary {
  return { entry_id, domain, state };
}

function batch(...entries: ConfigEntrySummary[]): unknown {
  return entries.map(e => ({ type: null, entry: e }));
}

function change(type: "added" | "removed" | "updated", e: ConfigEntrySummary): unknown {
  return [{ type, entry: e }];
}

async function subscribe(connection: FakeConnection, initialIsReseed = false) {
  const loaded = vi.fn();
  const unsubscribe = await subscribeEntryReloads(hassWith(connection), e => e.domain === "span_panel", loaded, { initialIsReseed });
  return { loaded, unsubscribe };
}

describe("subscribeEntryReloads", () => {
  it("subscribes to device integrations' entry changes", async () => {
    const connection = new FakeConnection();
    await subscribe(connection);
    expect(connection.subscriptions[0]?.message).toEqual({ type: ENTRY_RELOADS, type_filter: ["device"] });
  });

  it("only seeds from the first batch by default", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection);
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));
    expect(loaded).not.toHaveBeenCalled();
  });

  it("reports the first batch's loaded entries when told it is a re-seed", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection, true);
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded"), entry("entry-2", "setup_retry")));
    expect(loaded.mock.calls).toEqual([["entry-1"]]);
  });

  it("treats every later batch as a re-seed (a reconnect or a Home Assistant restart)", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection);
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));
    expect(loaded.mock.calls).toEqual([["entry-1"]]);
  });

  it("reports a transition into loaded, and nothing else", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection);
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));

    connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "not_loaded")));
    connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "setup_in_progress")));
    expect(loaded).not.toHaveBeenCalled();
    connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "loaded")));
    expect(loaded.mock.calls).toEqual([["entry-1"]]);
    // A title change stays loaded.
    connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "loaded")));
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it("ignores entries it does not accept", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection, true);
    connection.emit(ENTRY_RELOADS, batch(entry("other-1", "loaded", "hue")));
    connection.emit(ENTRY_RELOADS, change("updated", entry("other-1", "loaded", "hue")));
    expect(loaded).not.toHaveBeenCalled();
  });

  it("ignores a re-seed that no longer lists the entry, and still reports its later load", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection);
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));

    connection.emit(ENTRY_RELOADS, batch());
    expect(loaded).not.toHaveBeenCalled();

    connection.emit(ENTRY_RELOADS, change("added", entry("entry-1", "not_loaded")));
    connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "loaded")));
    expect(loaded.mock.calls).toEqual([["entry-1"]]);
  });

  it("hands back an unsubscribe that can be awaited", async () => {
    const connection = new FakeConnection();
    const { unsubscribe } = await subscribe(connection);
    await unsubscribe();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
  });
});
