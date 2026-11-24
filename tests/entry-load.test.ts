import { describe, it, expect, vi } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { discoverTopology } from "../src/card/card-discovery.js";
import {
  combinedEntryWait,
  entryLoadOf,
  entryWaitLine,
  entryWaitOf,
  isConnectionLost,
  isRefusedUntilEntryLoads,
  showEntryWait,
} from "../src/core/entry-load.js";
import { ErrorStore } from "../src/core/error-store.js";
import { RetryManager } from "../src/core/retry-manager.js";

/**
 * Until a panel's config entry has loaded, the integration refuses each of its
 * commands for one panel, `panel_topology` and `adopted/list` among them, with
 * `not_loaded`; Home Assistant answers `unknown_command` before the integration
 * has registered it, which it does as its first entry sets up; and
 * home-assistant-js-websocket rejects a call the lost connection cut off, with
 * an error result. Every other refusal is one that waiting does not end.
 *
 * The integration answers `not_loaded` too for an entry whose setup failed, and
 * for a disabled one. The entry subscription says which an entry is, from its
 * state and who disabled it, so a view tells a wait that ends by itself from
 * one that does not.
 */

const LOST_RESULT = { type: "result", success: false, error: { code: 3, message: "Connection lost" } };

describe("isConnectionLost", () => {
  it("holds for the error result the library rejects a call the lost connection cut off with", () => {
    expect(isConnectionLost(LOST_RESULT)).toBe(true);
  });

  it.each([
    ["the library's invalid authentication, as an error result", { type: "result", success: false, error: { code: 2, message: "Invalid auth" } }],
    ["the entry not loaded", { code: "not_loaded", message: "SPAN Panel integration is not loaded" }],
    ["null", null],
  ])("fails for %s", (_case, err) => {
    expect(isConnectionLost(err)).toBe(false);
  });
});

describe("isRefusedUntilEntryLoads", () => {
  it.each([
    ["the entry not loaded", { code: "not_loaded", message: "SPAN Panel integration is not loaded" }],
    ["a command Home Assistant does not know yet", { code: "unknown_command", message: "Unknown command." }],
    ["a connection lost, as the error result the library rejects with", LOST_RESULT],
  ])("holds for %s", (_case, err) => {
    expect(isRefusedUntilEntryLoads(err)).toBe(true);
  });

  it.each([
    ["a device the registry does not hold", { code: "device_not_found", message: "Device not found" }],
    ["a device no SPAN entry owns", { code: "not_span_panel", message: "Device is not a SPAN Panel device" }],
    ["a circuit's or a sub-device's device", { code: "not_panel_device", message: "Use the SPAN panel device registry ID" }],
    ["a user who is not an administrator, as `adopted/list` refuses one", { code: "unauthorized", message: "Unauthorized" }],
    ["any other error Home Assistant answers", { code: "unknown_error", message: "Unknown error" }],
    ["the library's invalid authentication, as an error result", { type: "result", success: false, error: { code: 2, message: "Invalid auth" } }],
    ["an Error whose message names a code", new Error("not_loaded")],
    ["a code as text, with no rejection object", "not_loaded"],
    ["null", null],
  ])("fails for %s", (_case, err) => {
    expect(isRefusedUntilEntryLoads(err)).toBe(false);
  });

  it.each([
    ["the entry not loaded", { code: "not_loaded", message: "SPAN Panel integration is not loaded" }],
    ["a connection lost", LOST_RESULT],
  ])("is, for %s, what a retry manager built to pass it through hands back from discoverTopology, after one ask", async (_case, refusal) => {
    const callWS = vi.fn(async () => {
      throw refusal;
    });
    const store = new ErrorStore();

    await expect(
      discoverTopology({ callWS } as unknown as HomeAssistant, "panel-now", new RetryManager(store, { passThrough: isRefusedUntilEntryLoads }))
    ).rejects.toBe(refusal);

    expect(callWS).toHaveBeenCalledTimes(1);
    expect(store.active).toEqual([]);
    store.dispose();
  });
});

describe("entryLoadOf", () => {
  it.each([
    ["loaded", "loaded"],
    ["not_loaded", "loading"],
    ["setup_in_progress", "loading"],
    ["setup_retry", "loading"],
    ["unload_in_progress", "loading"],
    ["setup_error", "setup_failed"],
    ["migration_error", "setup_failed"],
    ["failed_unload", "setup_failed"],
  ])("takes an entry in %s for %s", (state, load) => {
    expect(entryLoadOf({ state, disabled_by: null })).toBe(load);
  });

  it.each(["not_loaded", "unload_in_progress", "loaded"])("takes a disabled entry for disabled, in %s as in any state", state => {
    expect(entryLoadOf({ state, disabled_by: "user" })).toBe("disabled");
  });
});

describe("entryWaitOf", () => {
  it.each([
    [undefined, "waiting"],
    ["loading", "waiting"],
    ["loaded", "waiting"],
    ["setup_failed", "setup_failed"],
    ["disabled", "disabled"],
  ] as const)("says, of an entry that is %s, %s", (load, wait) => {
    expect(entryWaitOf(load)).toBe(wait);
  });
});

describe("combinedEntryWait", () => {
  it("waits while any of the entries can still load", () => {
    expect(combinedEntryWait(["setup_failed", "waiting", "disabled"])).toBe("waiting");
  });

  it("says set-up failed where none can load and one failed", () => {
    expect(combinedEntryWait(["disabled", "setup_failed"])).toBe("setup_failed");
  });

  it("says disabled where every entry is", () => {
    expect(combinedEntryWait(["disabled", "disabled"])).toBe("disabled");
  });
});

describe("entryWaitLine", () => {
  it("says it is waiting as a status, in the secondary text colour", () => {
    expect(entryWaitLine("waiting")).toEqual({ text: "Waiting for SPAN Panel to load...", role: "status", color: "var(--secondary-text-color)" });
  });

  it("says set-up failed, and where to look, as an alert in the error colour", () => {
    expect(entryWaitLine("setup_failed")).toEqual({
      text: "SPAN Panel could not be set up. Check Settings → Devices & services.",
      role: "alert",
      color: "var(--error-color)",
    });
  });

  it("says the panel is disabled, and where to enable it, as an alert in the error colour", () => {
    expect(entryWaitLine("disabled")).toEqual({
      text: "This SPAN Panel is disabled. Enable it in Settings → Devices & services.",
      role: "alert",
      color: "var(--error-color)",
    });
  });
});

describe("showEntryWait", () => {
  it("draws the line in place of what the container held", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>stale</p>";

    showEntryWait(container, "setup_failed");

    expect(container.children).toHaveLength(1);
    const line = container.firstElementChild as HTMLElement;
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.textContent).toBe("SPAN Panel could not be set up. Check Settings → Devices & services.");
    expect(line.style.color).toBe("var(--error-color)");
  });
});
