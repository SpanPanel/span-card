import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canEditMonitoring,
  monitoringFailureText,
  monitoringWrites,
  MonitoringChangeRefused,
  reportMonitoringFailure,
  type MonitoringWrites,
} from "../src/core/monitoring-access.js";
import { ErrorStore } from "../src/core/error-store.js";
import { setLanguage } from "../src/i18n.js";
import type { HomeAssistant } from "../src/types.js";

type Message = Record<string, unknown>;

/**
 * Every monitoring service of the integration's that changes something, each of
 * which it refuses a logged-in user who is not a Home Assistant administrator.
 */
const WRITE_SERVICES = [
  "set_global_monitoring",
  "set_circuit_threshold",
  "clear_circuit_threshold",
  "set_mains_threshold",
  "clear_mains_threshold",
  "set_circuit_package_ratings",
  "clear_circuit_package_ratings",
  "test_notification",
] as const;

/** The module that alone sends them, each only for a user who may change monitoring. */
const ACCESS_MODULE = "core/monitoring-access.ts";

const ADMIN_ONLY = "Only an administrator can change monitoring.";

/** The card's source files, by their path under `src/`. The path is taken apart by hand: happy-dom's `URL` reads no file URL. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SOURCES: ReadonlyArray<readonly [string, string]> = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter(path => path.endsWith(".ts"))
  .map(path => [path.split(sep).join("/"), readFileSync(join(SRC, path), "utf8")] as const);

/** A Home Assistant whose user is `user`, recording every message sent, which `answer` answers. */
function recording(user: HomeAssistant["user"], answer: (msg: Message) => Promise<unknown> = async () => ({})): { hass: HomeAssistant; sent: Message[] } {
  const sent: Message[] = [];
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    sent.push(msg);
    return answer(msg);
  });
  const hass = { states: {}, services: {}, language: "en", user, callService: async () => undefined, callWS } as unknown as HomeAssistant;
  return { hass, sent };
}

/** Each of the changes `writes` offers, by its name. */
function changesOf(writes: MonitoringWrites): Array<keyof MonitoringWrites> {
  return Object.keys(writes).filter((key): key is keyof MonitoringWrites => key in writes);
}

afterEach(() => {
  setLanguage("en");
  vi.restoreAllMocks();
});

describe("the monitoring write services", () => {
  it.each(WRITE_SERVICES)("%s is named nowhere in the card's source but the module that sends it only for an administrator", service => {
    const named = new RegExp(`\\b${service}\\b`);
    expect(SOURCES.filter(([, text]) => named.test(text)).map(([path]) => path)).toEqual([ACCESS_MODULE]);
  });

  it("are each sent by one of the module's changes for an administrator, and nothing else is", async () => {
    const { hass, sent } = recording({ is_admin: true });
    const writes = monitoringWrites(hass);
    for (const change of changesOf(writes)) await writes[change]({ config_entry_id: "entry-1" });

    expect(sent.map(msg => msg.service).sort()).toEqual([...WRITE_SERVICES].sort());
    for (const msg of sent)
      expect(msg).toEqual({ type: "call_service", domain: "span_panel", service: msg.service, service_data: { config_entry_id: "entry-1" } });
  });

  it("are sent within the call, as calling the service directly sends one", () => {
    const { hass, sent } = recording({ is_admin: true });
    void monitoringWrites(hass).setCircuitThreshold({ circuit_id: "sensor.oven_current", monitoring_enabled: false });
    expect(sent.map(msg => msg.service)).toEqual(["set_circuit_threshold"]);
  });

  it.each([
    ["is not an administrator", { is_admin: false }],
    ["the frontend says nothing of", undefined],
  ])("are refused, with nothing sent, for a user who %s", async (_who, user) => {
    const { hass, sent } = recording(user);
    const writes = monitoringWrites(hass);
    for (const change of changesOf(writes)) {
      await expect(writes[change]({})).rejects.toBeInstanceOf(MonitoringChangeRefused);
    }
    expect(sent).toEqual([]);
  });

  it.each([
    ["a service's handler raises it", { code: "home_assistant_error", message: "Unauthorized" }],
    ["the websocket command raises it", { code: "unauthorized", message: "Unauthorized" }],
  ])("take the integration's Unauthorized, as when %s, as a refusal for want of administrator rights", async (_how, refusal) => {
    const { hass } = recording({ is_admin: true }, async () => Promise.reject(refusal));
    const sending = monitoringWrites(hass).setGlobalMonitoring({ enabled: false });
    await expect(sending).rejects.toBeInstanceOf(MonitoringChangeRefused);
    await expect(sending).rejects.toThrow(ADMIN_ONLY);
  });

  it("pass on any other refusal as the integration gave it", async () => {
    const refusal = { code: "service_validation_error", message: "Validation error: out of range", translation_key: "threshold_out_of_range" };
    const { hass } = recording({ is_admin: true }, async () => Promise.reject(refusal));
    await expect(monitoringWrites(hass).setMainsThreshold({ leg: "upstream_l1" })).rejects.toBe(refusal);
  });
});

describe("canEditMonitoring", () => {
  it("is true for an administrator only", () => {
    expect(canEditMonitoring(recording({ is_admin: true }).hass)).toBe(true);
    expect(canEditMonitoring(recording({ is_admin: false }).hass)).toBe(false);
  });

  it("is false where the frontend says nothing of the user, or there is no Home Assistant yet", () => {
    expect(canEditMonitoring(recording(undefined).hass)).toBe(false);
    expect(canEditMonitoring(null)).toBe(false);
    expect(canEditMonitoring(undefined)).toBe(false);
  });
});

describe("a refusal for want of administrator rights", () => {
  it("says so in the user's language", () => {
    setLanguage("fr");
    expect(new MonitoringChangeRefused().message).toBe("Seul un administrateur peut modifier la surveillance.");
  });

  it("is what a failed change's report says, where any other failure says what it was given", () => {
    expect(monitoringFailureText(new MonitoringChangeRefused(), "Unable to save threshold")).toBe(ADMIN_ONLY);
    expect(monitoringFailureText({ code: "unknown_error", message: "boom" }, "Unable to save threshold")).toBe("Unable to save threshold");
  });

  it("is shown in the error store, as is any other failed change", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = new ErrorStore();
    reportMonitoringFailure(errors, new MonitoringChangeRefused(), "circuit threshold toggle");
    expect(errors.active.map(e => [e.key, e.level, e.message])).toEqual([["service:monitoring", "error", ADMIN_ONLY]]);

    const others = new ErrorStore();
    reportMonitoringFailure(others, { code: "unknown_error", message: "boom" }, "circuit threshold toggle");
    expect(others.active.map(e => e.message)).toEqual(["Unable to save threshold"]);
  });
});
