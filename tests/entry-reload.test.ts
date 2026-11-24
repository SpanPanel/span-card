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

function entry(entry_id: string, state: string, domain = "span_panel", disabled_by: string | null = null): ConfigEntrySummary {
  return { entry_id, domain, state, disabled_by };
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

  it("ignores a re-seed that no longer lists an entry, and reports the load of one added after it", async () => {
    const connection = new FakeConnection();
    const { loaded } = await subscribe(connection);
    connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));

    connection.emit(ENTRY_RELOADS, batch());
    expect(loaded).not.toHaveBeenCalled();

    // Core gives every entry an id of its own and never reuses one.
    connection.emit(ENTRY_RELOADS, change("added", entry("entry-3", "not_loaded")));
    connection.emit(ENTRY_RELOADS, change("updated", entry("entry-3", "loaded")));
    expect(loaded.mock.calls).toEqual([["entry-3"]]);
  });

  describe("what each accepted entry says of itself", () => {
    async function watch(connection: FakeConnection) {
      const onStatus = vi.fn();
      await subscribeEntryReloads(
        hassWith(connection),
        e => e.domain === "span_panel",
        () => {},
        { initialIsReseed: false, onStatus }
      );
      return onStatus;
    }

    it("reports it for each entry of the first batch, and again only as it changes", async () => {
      const connection = new FakeConnection();
      const onStatus = await watch(connection);

      connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "setup_in_progress"), entry("entry-2", "loaded"), entry("other-1", "setup_error", "hue")));
      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "setup_retry")));
      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "setup_error")));
      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "setup_in_progress")));
      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "loaded")));

      expect(onStatus.mock.calls).toEqual([
        ["entry-1", "loading"],
        ["entry-2", "loaded"],
        ["entry-1", "setup_failed"],
        ["entry-1", "loading"],
        ["entry-1", "loaded"],
      ]);
    });

    it("reports a disabled entry as disabled, in whatever state it is", async () => {
      const connection = new FakeConnection();
      const onStatus = await watch(connection);
      connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));

      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "loaded", "span_panel", "user")));
      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "not_loaded", "span_panel", "user")));

      expect(onStatus.mock.calls).toEqual([
        ["entry-1", "loaded"],
        ["entry-1", "disabled"],
      ]);
    });

    it("reports an entry removed, or missing from a re-seed, as null, and one added as it then is", async () => {
      const connection = new FakeConnection();
      const onStatus = await watch(connection);
      connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded"), entry("entry-2", "setup_retry")));

      connection.emit(ENTRY_RELOADS, change("removed", entry("entry-2", "not_loaded")));
      connection.emit(ENTRY_RELOADS, batch());
      connection.emit(ENTRY_RELOADS, change("added", entry("entry-3", "not_loaded")));

      expect(onStatus.mock.calls).toEqual([
        ["entry-1", "loaded"],
        ["entry-2", "loading"],
        ["entry-2", null],
        ["entry-1", null],
        ["entry-3", "loading"],
      ]);
    });

    it("hears each batch of the current entries, the first one and each re-seed, and no change", async () => {
      const connection = new FakeConnection();
      const onSeed = vi.fn();
      await subscribeEntryReloads(
        hassWith(connection),
        e => e.domain === "span_panel",
        () => {},
        { initialIsReseed: false, onSeed }
      );

      connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "setup_retry")));
      connection.emit(ENTRY_RELOADS, change("updated", entry("entry-1", "loaded")));
      connection.emit(ENTRY_RELOADS, batch(entry("entry-1", "loaded")));

      expect(onSeed).toHaveBeenCalledTimes(2);
    });
  });

  it("hands back an unsubscribe that can be awaited", async () => {
    const connection = new FakeConnection();
    const { unsubscribe } = await subscribe(connection);
    await unsubscribe();
    expect(connection.live(ENTRY_RELOADS)).toBe(0);
  });
});
