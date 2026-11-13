import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { ErrorStore } from "../src/core/error-store.js";
import { blurOnRemoval } from "./removal-blur.js";
import type { HomeAssistant, MonitoringPointInfo } from "../src/types.js";

type Message = Record<string, unknown>;
type Fields = Partial<Record<"continuous_threshold_pct" | "spike_threshold_pct" | "window_duration_m" | "cooldown_duration_m", number>>;

const GLOBALS = { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 };
const OVEN = "sensor.oven_current";
const MAINS = "sensor.span_panel_current_power";
const THRESHOLD_FIELDS = ["continuous_threshold_pct", "spike_threshold_pct", "window_duration_m", "cooldown_duration_m"] as const;

function point(name: string): MonitoringPointInfo {
  return { name, monitoring_enabled: true, has_override: false, breaker_rating_a: 20, monitoring_rating_a: 20, ...GLOBALS };
}

/** What a threshold service call carries, the field it sets among them. */
function fieldsOf(data: Message): Fields {
  const out: Fields = {};
  for (const key of THRESHOLD_FIELDS) {
    const value = data[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

interface Integration {
  hass: HomeAssistant;
  /** Every service call other than the status read, as sent. */
  saves: Message[];
  /** How many times the tab read the monitoring status. */
  reads: () => number;
  /** Hold every later status read until the test answers it, with the status as it stood when it was asked. */
  holdReads: () => Array<() => void>;
  /** Hold every later save until the test answers it. */
  holdSaves: () => Array<() => void>;
}

/**
 * One panel's monitoring as the integration reports it: a threshold save becomes
 * the point's override, a clear takes it away, and a global save the thresholds of
 * every point without one.
 * A service named in `refuse` is refused with the error given for it.
 */
function integration({ ovenOverride = false, ovenName = "Oven", monitoringOn = true, refuse = {} as Record<string, unknown> } = {}): Integration {
  const globals: Fields = { ...GLOBALS };
  const circuits: Record<string, MonitoringPointInfo> = { [OVEN]: { ...point(ovenName), has_override: ovenOverride } };
  const mains: Record<string, MonitoringPointInfo> = { [MAINS]: point("Mains") };
  const saves: Message[] = [];
  let reads = 0;
  let heldReads: Array<() => void> | null = null;
  let heldSaves: Array<() => void> | null = null;
  const status = (): unknown => ({
    response: { enabled: monitoringOn, global_settings: { ...globals }, circuits: structuredClone(circuits), mains: structuredClone(mains) },
  });
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    if (msg.service === "get_monitoring_status") {
      reads += 1;
      const answer = status();
      const queue = heldReads;
      if (queue) return new Promise(resolve => queue.push(() => resolve(answer)));
      return answer;
    }
    const data = (msg.service_data ?? {}) as Message;
    saves.push({ service: msg.service, ...data });
    if (typeof msg.service === "string" && msg.service in refuse) throw refuse[msg.service];
    const apply = (): void => {
      if (msg.service === "set_circuit_threshold" && typeof data.circuit_id === "string") {
        circuits[data.circuit_id] = { ...circuits[data.circuit_id]!, ...fieldsOf(data), has_override: true };
      }
      if (msg.service === "set_mains_threshold" && typeof data.leg === "string") {
        mains[data.leg] = { ...mains[data.leg]!, ...fieldsOf(data), has_override: true };
      }
      if (msg.service === "clear_circuit_threshold" && typeof data.circuit_id === "string") {
        circuits[data.circuit_id] = { ...circuits[data.circuit_id]!, ...globals, has_override: false };
      }
      if (msg.service === "clear_mains_threshold" && typeof data.leg === "string") {
        mains[data.leg] = { ...mains[data.leg]!, ...globals, has_override: false };
      }
      if (msg.service === "set_global_monitoring") {
        Object.assign(globals, fieldsOf(data));
        for (const points of [circuits, mains]) {
          for (const [id, info] of Object.entries(points)) if (!info.has_override) points[id] = { ...info, ...fieldsOf(data) };
        }
      }
    };
    const queue = heldSaves;
    if (queue) {
      return new Promise(resolve =>
        queue.push(() => {
          apply();
          resolve({});
        })
      );
    }
    apply();
    return {};
  });
  const callService = vi.fn(
    async (domain: string, service: string, data: Message): Promise<unknown> => callWS({ type: "call_service", domain, service, service_data: data })
  );
  const hass = { states: {}, services: {}, language: "en", callService, callWS } as unknown as HomeAssistant;
  return {
    hass,
    saves,
    reads: () => reads,
    holdReads: () => (heldReads = []),
    holdSaves: () => (heldSaves = []),
  };
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.useRealTimers();
});

/** The tab drawn as the dashboard draws it, in a container inside the panel's shadow root. */
async function shown(panel: Integration): Promise<{ tab: MonitoringTab; container: HTMLElement; root: ShadowRoot }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  const root = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  root.appendChild(container);
  const tab = new MonitoringTab();
  await tab.render(container, panel.hass, "entry-1");
  return { tab, container, root };
}

/** A Global Settings field, by its id, as drawn now. */
const global = (container: HTMLElement, id: string): HTMLInputElement => container.querySelector<HTMLInputElement>(`#${id}`)!;

/** The table's field for a point's threshold or duration, as drawn now. */
const cell = (container: HTMLElement, entity: string, field: string): HTMLInputElement =>
  container.querySelector<HTMLInputElement>(`.threshold-input[data-entity="${entity}"][data-field="${field}"]`)!;

/** The element a field names as its description. */
function description(field: HTMLInputElement): HTMLElement | null {
  const id = field.getAttribute("aria-describedby");
  const root = field.getRootNode();
  return id && root instanceof ShadowRoot ? root.getElementById(id) : null;
}

/** What the table says beside a field, through the description the field names. */
const said = (field: HTMLInputElement): string | null => description(field)?.textContent ?? null;

/** Type `value` into the field, as keystrokes do, without committing it. */
function typeOnly(el: HTMLInputElement, value: string): void {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

/** Type `value` and commit it with Enter. */
function type(el: HTMLInputElement, value: string): void {
  typeOnly(el, value);
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("the Monitoring tab's threshold table", () => {
  it("saves a threshold only on Enter, never while it is typed or stepped", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { container } = await shown(panel);
    const field = cell(container, OVEN, "continuous_threshold_pct");

    // Each step is an input event, as the arrow keys and the spinner make.
    for (const step of ["81", "82", "83"]) typeOnly(field, step);
    await vi.advanceTimersByTimeAsync(5000);
    expect(panel.saves).toEqual([]);

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(panel.saves).toEqual([{ service: "set_circuit_threshold", circuit_id: OVEN, continuous_threshold_pct: 83, config_entry_id: "entry-1" }]);
  });

  it("saves on leaving a field the user changed, and nothing on leaving one nobody changed", async () => {
    const panel = integration();
    const { container } = await shown(panel);

    cell(container, OVEN, "spike_threshold_pct").focus();
    cell(container, OVEN, "spike_threshold_pct").blur();
    await settle();
    expect(panel.saves).toEqual([]);

    typeOnly(cell(container, OVEN, "window_duration_m"), "20");
    cell(container, OVEN, "window_duration_m").blur();
    await settle();

    expect(panel.saves).toEqual([{ service: "set_circuit_threshold", circuit_id: OVEN, window_duration_m: 20, config_entry_id: "entry-1" }]);
  });

  it("saves the mains' thresholds by its leg", async () => {
    const panel = integration();
    const { container } = await shown(panel);

    type(cell(container, MAINS, "cooldown_duration_m"), "30");
    await settle();

    expect(panel.saves).toEqual([{ service: "set_mains_threshold", leg: MAINS, cooldown_duration_m: 30, config_entry_id: "entry-1" }]);
  });

  it.each([
    ["continuous_threshold_pct", "", "Enter a whole number from 1 to 200."],
    ["continuous_threshold_pct", "0", "Enter a whole number from 1 to 200."],
    ["spike_threshold_pct", "201", "Enter a whole number from 1 to 200."],
    ["spike_threshold_pct", "12.5", "Enter a whole number from 1 to 200."],
    ["window_duration_m", "181", "Enter a whole number from 1 to 180."],
    ["cooldown_duration_m", "", "Enter a whole number from 1 to 180."],
  ])("saves nothing for %s set to %j, saying what to enter", async (key, value, message) => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = cell(container, OVEN, key);

    type(field, value);
    field.blur();
    await settle();

    expect(panel.saves).toEqual([]);
    expect(said(field)).toBe(message);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(description(field)!.getAttribute("aria-live")).toBe("polite");
  });

  it("clears what it said once the user types again", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = cell(container, OVEN, "window_duration_m");
    const border = field.style.borderColor;

    type(field, "0");
    expect(field.style.borderColor).not.toBe(border);
    typeOnly(field, "20");

    expect(said(field)).toBe("");
    expect(field.hasAttribute("aria-invalid")).toBe(false);
    expect(field.style.borderColor).toBe(border);
  });

  it("gives every field its own description", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const ids = [...container.querySelectorAll<HTMLInputElement>(".threshold-input")].map(field => field.getAttribute("aria-describedby"));

    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });

  it("keeps the wheel from stepping a focused field, and leaves it alone over one not focused", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const focused = cell(container, OVEN, "continuous_threshold_pct");
    const other = cell(container, OVEN, "spike_threshold_pct");
    focused.focus();

    const overFocused = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    focused.dispatchEvent(overFocused);
    const overOther = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    other.dispatchEvent(overOther);

    expect(overFocused.defaultPrevented).toBe(true);
    expect(overOther.defaultPrevented).toBe(false);
  });

  it("reads the table again once a save is stored, so the point's Reset appears", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    expect(container.querySelector(`.reset-btn[data-entity="${OVEN}"]`)).toBeNull();

    type(cell(container, OVEN, "continuous_threshold_pct"), "90");

    await vi.waitFor(() => expect(container.querySelector(`.reset-btn[data-entity="${OVEN}"]`)).not.toBeNull());
    expect(cell(container, OVEN, "continuous_threshold_pct").value).toBe("90");
  });

  it("keeps focus on the field the user moved to, and what they began typing there, across that read", async () => {
    const panel = integration();
    const { container, root } = await shown(panel);
    typeOnly(cell(container, OVEN, "continuous_threshold_pct"), "90");

    // Tab to the next field, which leaves the first and saves it, and start typing.
    const next = cell(container, OVEN, "spike_threshold_pct");
    next.focus();
    next.value = "15";
    next.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(cell(container, OVEN, "spike_threshold_pct")).not.toBe(next));

    const redrawn = cell(container, OVEN, "spike_threshold_pct");
    expect(root.activeElement).toBe(redrawn);
    expect(redrawn.value).toBe("15");

    // What they typed is still theirs to commit, with no more typing.
    redrawn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await settle();
    expect(panel.saves.map(fieldsOf)).toEqual([{ continuous_threshold_pct: 90 }, { spike_threshold_pct: 15 }]);
  });

  it("draws nothing once the tab is left while a save is on its way", async () => {
    const panel = integration();
    const { tab, container } = await shown(panel);
    const pending = panel.holdSaves();
    const reads = panel.reads();
    type(cell(container, OVEN, "continuous_threshold_pct"), "90");

    // The user opens another tab, which takes the same container.
    tab.stop();
    container.innerHTML = "<p>another tab</p>";
    for (const answer of pending) answer();
    await settle();
    await settle();

    expect(container.innerHTML).toBe("<p>another tab</p>");
    expect(panel.reads()).toBe(reads);
  });

  it("draws nothing once the tab is left while its read after a save is on its way", async () => {
    const panel = integration();
    const { tab, container } = await shown(panel);
    const answers = panel.holdReads();
    type(cell(container, OVEN, "continuous_threshold_pct"), "90");
    await vi.waitFor(() => expect(answers).toHaveLength(1));

    tab.stop();
    container.innerHTML = "<p>another tab</p>";
    answers[0]!();
    await settle();
    await settle();

    expect(container.innerHTML).toBe("<p>another tab</p>");
  });

  it("draws the newest read of the table when two reads cross", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const answers = panel.holdReads();

    type(cell(container, OVEN, "continuous_threshold_pct"), "90");
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    type(cell(container, OVEN, "spike_threshold_pct"), "150");
    await vi.waitFor(() => expect(answers).toHaveLength(2));

    // The second read, which saw both saves, answers first; the first, which saw one, answers last.
    answers[1]!();
    await vi.waitFor(() => expect(cell(container, OVEN, "spike_threshold_pct").value).toBe("150"));
    answers[0]!();
    await settle();
    await settle();

    expect(cell(container, OVEN, "spike_threshold_pct").value).toBe("150");
    expect(cell(container, OVEN, "continuous_threshold_pct").value).toBe("90");
  });
});

describe("the Monitoring tab's global thresholds", () => {
  it("saves a global threshold only on Enter, never while it is typed or stepped, and only the one changed", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { container } = await shown(panel);
    const field = global(container, "g-continuous");

    for (const step of ["81", "82", "95"]) typeOnly(field, step);
    await vi.advanceTimersByTimeAsync(5000);
    expect(panel.saves).toEqual([]);

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(panel.saves).toEqual([{ service: "set_global_monitoring", continuous_threshold_pct: 95, config_entry_id: "entry-1" }]);
  });

  it("saves on leaving a field the user changed, and nothing on leaving one nobody changed", async () => {
    const panel = integration();
    const { container } = await shown(panel);

    global(container, "g-spike").focus();
    global(container, "g-spike").blur();
    await settle();
    expect(panel.saves).toEqual([]);

    typeOnly(global(container, "g-cooldown"), "30");
    global(container, "g-cooldown").blur();
    await settle();

    expect(panel.saves).toEqual([{ service: "set_global_monitoring", cooldown_duration_m: 30, config_entry_id: "entry-1" }]);
  });

  it.each([
    ["g-continuous", "0", "Enter a whole number from 1 to 200."],
    ["g-spike", "201", "Enter a whole number from 1 to 200."],
    ["g-window", "181", "Enter a whole number from 1 to 180."],
    ["g-cooldown", "", "Enter a whole number from 1 to 180."],
  ])("saves nothing for %s set to %j, saying what to enter", async (id, value, message) => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = global(container, id);

    type(field, value);
    field.blur();
    await settle();

    expect(panel.saves).toEqual([]);
    expect(said(field)).toBe(message);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(description(field)!.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the wheel from stepping a focused global field", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = global(container, "g-window");
    field.focus();

    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    field.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(true);
  });

  it("reads the tab again once a global save is stored, keeping focus on the field the user moved to", async () => {
    const panel = integration();
    const { container, root } = await shown(panel);
    typeOnly(global(container, "g-continuous"), "95");

    const next = global(container, "g-spike");
    next.focus();
    await vi.waitFor(() => expect(global(container, "g-spike")).not.toBe(next));

    // A point on the global thresholds shows the new one.
    expect(cell(container, OVEN, "continuous_threshold_pct").value).toBe("95");
    expect(root.activeElement).toBe(global(container, "g-spike"));
  });

  it("draws nothing once the tab is left while a global save is on its way", async () => {
    const panel = integration();
    const { tab, container } = await shown(panel);
    const pending = panel.holdSaves();
    const reads = panel.reads();
    type(global(container, "g-continuous"), "95");

    tab.stop();
    container.innerHTML = "<p>another tab</p>";
    for (const answer of pending) answer();
    await settle();
    await settle();

    expect(container.innerHTML).toBe("<p>another tab</p>");
    expect(panel.reads()).toBe(reads);
  });
});

describe("the Monitoring tab's other controls", () => {
  /** Each control that saves and then reads the tab again, and how the user changes it. */
  const CONTROLS: Array<[string, (container: HTMLElement) => void]> = [
    [
      "the Enabled switch",
      container => {
        const enabled = container.querySelector<HTMLInputElement>("#monitoring-enabled")!;
        enabled.checked = false;
        enabled.dispatchEvent(new Event("change"));
      },
    ],
    [
      "the notification priority",
      container => {
        const priority = container.querySelector<HTMLSelectElement>("#g-priority")!;
        priority.value = "active";
        priority.dispatchEvent(new Event("change"));
      },
    ],
    [
      "All / None",
      container => {
        const all = container.querySelector<HTMLInputElement>("#toggle-all-circuits")!;
        all.checked = false;
        all.dispatchEvent(new Event("change"));
      },
    ],
    [
      "a circuit's switch",
      container => {
        const toggle = container.querySelector<HTMLInputElement>(`.circuit-toggle[data-entity="${OVEN}"]`)!;
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
      },
    ],
    [
      "the mains' switch",
      container => {
        const toggle = container.querySelector<HTMLInputElement>(`.mains-toggle[data-entity="${MAINS}"]`)!;
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
      },
    ],
    ["a point's Reset", container => container.querySelector<HTMLElement>(`.reset-btn[data-entity="${OVEN}"]`)!.click()],
  ];

  it.each(CONTROLS)("draw nothing once the tab is left while what %s saved is on its way", async (_name, change) => {
    const panel = integration({ ovenOverride: true });
    const { tab, container } = await shown(panel);
    const pending = panel.holdSaves();
    const reads = panel.reads();
    change(container);
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));

    tab.stop();
    container.innerHTML = "<p>another tab</p>";
    for (const answer of pending) answer();
    await settle();
    await settle();

    expect(container.innerHTML).toBe("<p>another tab</p>");
    expect(panel.reads()).toBe(reads);
  });

  it.each(CONTROLS)("read the tab again once what %s saved is stored", async (_name, change) => {
    const panel = integration({ ovenOverride: true });
    const { container } = await shown(panel);
    const reads = panel.reads();

    change(container);

    await vi.waitFor(() => expect(panel.reads()).toBe(reads + 1));
  });
});

describe("a point's Reset", () => {
  const resetOf = (container: HTMLElement): HTMLElement | null => container.querySelector<HTMLElement>(`.reset-btn[data-entity="${OVEN}"]`);

  it("is marked busy while it is on its way, keeps focus, and sends nothing on a second click", async () => {
    const panel = integration({ ovenOverride: true });
    const { container, root } = await shown(panel);
    const pending = panel.holdSaves();
    const reset = resetOf(container)!;
    reset.focus();

    reset.click();
    reset.click();
    await settle();

    expect(panel.saves).toEqual([{ service: "clear_circuit_threshold", circuit_id: OVEN, config_entry_id: "entry-1" }]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    expect(root.activeElement).toBe(reset);
    for (const answer of pending) answer();
  });

  it("says why it failed, and is usable again with the point's thresholds as they were", async () => {
    const panel = integration({
      ovenOverride: true,
      refuse: { clear_circuit_threshold: { code: "home_assistant_error", message: "The panel is not loaded" } },
    });
    const { tab, container } = await shown(panel);
    const errors = new ErrorStore();
    tab.errorStore = errors;
    const reads = panel.reads();
    const reset = resetOf(container)!;

    reset.click();
    await vi.waitFor(() => expect(errors.active.map(e => e.message)).toEqual(["The panel is not loaded"]));

    expect(resetOf(container)).toBe(reset);
    expect(reset.hasAttribute("aria-disabled")).toBe(false);
    expect(panel.reads()).toBe(reads);

    // Once usable again, it sends again.
    reset.click();
    await settle();
    expect(panel.saves.filter(save => save.service === "clear_circuit_threshold")).toHaveLength(2);
  });

  it("says it could not save where the integration gives no reason", async () => {
    const panel = integration({ ovenOverride: true, refuse: { clear_circuit_threshold: {} } });
    const { tab, container } = await shown(panel);
    const errors = new ErrorStore();
    tab.errorStore = errors;

    resetOf(container)!.click();

    await vi.waitFor(() => expect(errors.active.map(e => e.message)).toEqual(["Unable to save threshold"]));
  });
});

describe("the Monitoring tab's notification settings", () => {
  const title = (container: HTMLElement): HTMLInputElement => container.querySelector<HTMLInputElement>("#g-title-template")!;
  const message = (container: HTMLElement): HTMLInputElement => container.querySelector<HTMLInputElement>("#g-message-template")!;
  const target = (container: HTMLElement, value: string): HTMLInputElement => container.querySelector<HTMLInputElement>(`.notify-target-cb[value="${value}"]`)!;
  const choose = (box: HTMLInputElement, checked: boolean): void => {
    box.checked = checked;
    box.dispatchEvent(new Event("change"));
  };
  const settings = (panel: Integration): Message[] => panel.saves.filter(save => save.service === "set_global_monitoring");

  it("save a template and a target choice made within one pause, each of them", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { container } = await shown(panel);

    typeOnly(title(container), "SPAN alert");
    choose(target(container, "event_bus"), true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(settings(panel)).toEqual(
      expect.arrayContaining([
        { service: "set_global_monitoring", notification_title_template: "SPAN alert", config_entry_id: "entry-1" },
        { service: "set_global_monitoring", notify_targets: "event_bus", config_entry_id: "entry-1" },
      ])
    );
    expect(settings(panel)).toHaveLength(2);
  });

  it("save the title and the message templates typed one after the other, each of them", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { container } = await shown(panel);

    typeOnly(title(container), "SPAN alert");
    typeOnly(message(container), "{name} is high");
    await vi.advanceTimersByTimeAsync(1000);

    expect(settings(panel).map(save => save.notification_title_template ?? save.notification_message_template)).toEqual(["SPAN alert", "{name} is high"]);
  });

  it("save a template once the user pauses, not at each keystroke", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { container } = await shown(panel);

    for (const text of ["S", "SP", "SPAN"]) typeOnly(title(container), text);
    await vi.advanceTimersByTimeAsync(1000);

    expect(settings(panel)).toEqual([{ service: "set_global_monitoring", notification_title_template: "SPAN", config_entry_id: "entry-1" }]);
  });

  it("send what is waiting, and the target choices once, before sending the test", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { container } = await shown(panel);
    typeOnly(title(container), "SPAN alert");
    choose(target(container, "event_bus"), true);

    container.querySelector<HTMLButtonElement>("#test-notification-btn")!.click();
    await vi.advanceTimersByTimeAsync(0);

    // Both settings first, in either order, then the test.
    expect(panel.saves.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { service: "set_global_monitoring", notify_targets: "event_bus", config_entry_id: "entry-1" },
        { service: "set_global_monitoring", notification_title_template: "SPAN alert", config_entry_id: "entry-1" },
      ])
    );
    expect(panel.saves[2]).toEqual({ service: "test_notification", config_entry_id: "entry-1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel.saves).toHaveLength(3);
  });

  it("send no test where what was waiting fails to save, saying why", async () => {
    const panel = integration({ refuse: { set_global_monitoring: { message: "Template is not valid" } } });
    const { container } = await shown(panel);
    typeOnly(title(container), "{oops");

    container.querySelector<HTMLButtonElement>("#test-notification-btn")!.click();

    await vi.waitFor(() => expect(container.querySelector("#test-notification-status")!.textContent).toContain("Template is not valid"));
    expect(panel.saves.map(save => save.service)).not.toContain("test_notification");
    expect(container.querySelector<HTMLButtonElement>("#test-notification-btn")!.disabled).toBe(false);
  });

  it("send what is waiting when the tab is left, to the panel it was typed for", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { tab, container } = await shown(panel);
    typeOnly(title(container), "SPAN alert");

    tab.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings(panel)).toEqual([{ service: "set_global_monitoring", notification_title_template: "SPAN alert", config_entry_id: "entry-1" }]);

    // The tab drawn again for another panel sends nothing more.
    await tab.render(container, panel.hass, "entry-2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(settings(panel)).toHaveLength(1);
  });

  it("send a template still waiting to the panel it was typed for, though the tab has since been drawn for another", async () => {
    vi.useFakeTimers();
    const panel = integration();
    const { tab, container } = await shown(panel);
    typeOnly(title(container), "SPAN alert");

    await tab.render(container, panel.hass, "entry-2");
    await vi.advanceTimersByTimeAsync(1000);

    expect(settings(panel)).toEqual([{ service: "set_global_monitoring", notification_title_template: "SPAN alert", config_entry_id: "entry-1" }]);
  });
});

describe("the Monitoring tab's table, as a screen reader names it", () => {
  it("names each field by its point and what it sets", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const names = [...container.querySelectorAll<HTMLInputElement>(".threshold-input")].map(field => field.getAttribute("aria-label"));

    expect(names).toEqual([
      "Continuous (%) for Mains",
      "Spike (%) for Mains",
      "Window (min) for Mains",
      "Cooldown (min) for Mains",
      "Continuous (%) for Oven",
      "Spike (%) for Oven",
      "Window (min) for Oven",
      "Cooldown (min) for Oven",
    ]);
  });

  it("names a point's Reset by its point, keeping the word it shows", async () => {
    const panel = integration({ ovenOverride: true });
    const { container } = await shown(panel);
    const reset = container.querySelector<HTMLElement>(`.reset-btn[data-entity="${OVEN}"]`)!;

    expect(reset.getAttribute("aria-label")).toBe("Reset Oven");
    expect(reset.getAttribute("aria-label")).toContain(reset.textContent!.trim());
  });

  it("names them by the point's name as written, markup and quotes included", async () => {
    const written = `Oven "A" <b>&</b>`;
    const panel = integration({ ovenOverride: true, ovenName: written });
    const { container } = await shown(panel);

    expect(cell(container, OVEN, "spike_threshold_pct").getAttribute("aria-label")).toBe(`Spike (%) for ${written}`);
    expect(container.querySelector(`.reset-btn[data-entity="${OVEN}"]`)!.getAttribute("aria-label")).toBe(`Reset ${written}`);
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("a redraw, which in Chromium blurs a focused field as it removes it", () => {
  let undo: () => void = () => {};
  beforeEach(() => (undo = blurOnRemoval()));
  afterEach(() => undo());

  it("sends nothing for a global field half typed as the tab is drawn again, keeping what was typed", async () => {
    const panel = integration();
    const { container, root } = await shown(panel);
    typeOnly(global(container, "g-continuous"), "85");
    // Tab to Spike, which saves Continuous, and start typing as the tab is read again.
    const next = global(container, "g-spike");
    next.focus();
    next.value = "1";
    next.dispatchEvent(new Event("input"));

    await vi.waitFor(() => expect(global(container, "g-spike")).not.toBe(next));
    await settle();

    expect(panel.saves).toEqual([{ service: "set_global_monitoring", continuous_threshold_pct: 85, config_entry_id: "entry-1" }]);
    expect(global(container, "g-spike").value).toBe("1");
    expect(root.activeElement).toBe(global(container, "g-spike"));
  });

  it("sends nothing for a table field half typed as the tab is drawn again, keeping what was typed", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    typeOnly(cell(container, OVEN, "continuous_threshold_pct"), "85");
    const next = cell(container, OVEN, "spike_threshold_pct");
    next.focus();
    next.value = "1";
    next.dispatchEvent(new Event("input"));

    await vi.waitFor(() => expect(cell(container, OVEN, "spike_threshold_pct")).not.toBe(next));
    await settle();

    expect(panel.saves).toEqual([{ service: "set_circuit_threshold", circuit_id: OVEN, continuous_threshold_pct: 85, config_entry_id: "entry-1" }]);
    expect(cell(container, OVEN, "spike_threshold_pct").value).toBe("1");
  });

  it.each([
    ["a table field", (container: HTMLElement) => cell(container, OVEN, "spike_threshold_pct")],
    ["a global field", (container: HTMLElement) => global(container, "g-window")],
  ])("sends nothing for %s half typed as the dashboard clears the tab", async (_name, fieldOf) => {
    const panel = integration();
    const { tab, container } = await shown(panel);
    typeOnly(fieldOf(container), "15");

    tab.stop();
    container.innerHTML = "";
    await settle();

    expect(panel.saves).toEqual([]);
  });

  it("still saves a field the user leaves", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    typeOnly(cell(container, OVEN, "window_duration_m"), "20");

    cell(container, OVEN, "window_duration_m").blur();
    await settle();

    expect(panel.saves).toEqual([{ service: "set_circuit_threshold", circuit_id: OVEN, window_duration_m: 20, config_entry_id: "entry-1" }]);
  });
});

describe("a field's border, as Chromium reads it", () => {
  // Chromium reads a longhand of a shorthand holding var() as "": `border: 1px solid var(--divider-color)`
  // gives a borderColor of "" until the colour is set on its own. happy-dom reads the colour.
  let undo: () => void = () => {};
  beforeEach(() => {
    const style = document.createElement("input").style;
    let owner: object | null = style;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, "borderColor"))) owner = Object.getPrototypeOf(owner);
    const original = descriptor!;
    const setOwn = new WeakSet<object>();
    Object.defineProperty(owner!, "borderColor", {
      ...original,
      get(this: CSSStyleDeclaration) {
        const value = original.get!.call(this) as string;
        return !setOwn.has(this) && value.includes("var(") ? "" : value;
      },
      set(this: CSSStyleDeclaration, value: string) {
        setOwn.add(this);
        original.set!.call(this, value);
      },
    });
    undo = () => Object.defineProperty(owner!, "borderColor", original);
  });
  afterEach(() => undo());

  it.each([
    ["a table field", (container: HTMLElement) => cell(container, OVEN, "window_duration_m")],
    ["a global field", (container: HTMLElement) => global(container, "g-window")],
  ])("takes the divider colour back on %s once what it said is cleared", async (_name, fieldOf) => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = fieldOf(container);

    type(field, "0");
    typeOnly(field, "20");

    expect(field.style.getPropertyValue("border-color")).toBe("var(--divider-color)");
  });

  it("leaves a field nobody marked with the colour it was drawn with", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = cell(container, OVEN, "window_duration_m");

    typeOnly(field, "20");

    expect(field.style.getPropertyValue("border-color")).toBe("var(--divider-color)");
  });
});

describe("the Monitoring tab's settings, as a screen reader names them", () => {
  it.each([
    ["#g-continuous", "Continuous (%)"],
    ["#g-spike", "Spike (%)"],
    ["#g-window", "Window (min)"],
    ["#g-cooldown", "Cooldown (min)"],
    ["#g-priority", "Priority"],
    ["#g-title-template", "Title Template"],
    ["#g-message-template", "Message Template"],
  ])("names %s by the label shown beside it", async (selector, name) => {
    const panel = integration();
    const { container } = await shown(panel);
    const control = container.querySelector<HTMLElement>(selector)!;

    expect(control.getAttribute("aria-label")).toBe(name);
    expect(control.parentElement!.querySelector("span")!.textContent).toBe(name);
  });
});

describe("focus across the redraw after a row's control saves", () => {
  it("moves from a Reset that went with the override to the row's first field", async () => {
    const panel = integration({ ovenOverride: true });
    const { container, root } = await shown(panel);
    const reset = container.querySelector<HTMLElement>(`.reset-btn[data-entity="${OVEN}"]`)!;
    reset.focus();

    reset.click();
    await vi.waitFor(() => expect(container.querySelector(`.reset-btn[data-entity="${OVEN}"]`)).toBeNull());

    expect(root.activeElement).toBe(cell(container, OVEN, "continuous_threshold_pct"));
  });

  it("stays on a Reset that is still there after the redraw", async () => {
    // The integration kept the override, so the redrawn row still offers its Reset.
    const panel = integration({ ovenOverride: true });
    const { container, root } = await shown(panel);
    const reset = container.querySelector<HTMLElement>(`.reset-btn[data-entity="${OVEN}"]`)!;
    reset.focus();
    const reads = panel.reads();

    // A redraw for another reason, a switch elsewhere saving, while the Reset has focus.
    const all = container.querySelector<HTMLInputElement>(`.mains-toggle[data-entity="${MAINS}"]`)!;
    all.checked = false;
    all.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(panel.reads()).toBe(reads + 1));
    await settle();

    expect(root.activeElement).toBe(container.querySelector(`.reset-btn[data-entity="${OVEN}"]`));
  });

  it.each([
    ["circuit", OVEN],
    ["mains", MAINS],
  ])("stays on the %s switch the user changed", async (kind, entity) => {
    const panel = integration();
    const { container, root } = await shown(panel);
    const toggle = container.querySelector<HTMLInputElement>(`.${kind}-toggle[data-entity="${entity}"]`)!;
    toggle.focus();
    const reads = panel.reads();

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(panel.reads()).toBe(reads + 1));
    await settle();

    expect(root.activeElement).toBe(container.querySelector(`.${kind}-toggle[data-entity="${entity}"]`));
    expect(root.activeElement).not.toBe(toggle);
  });
});

describe("turning monitoring on", () => {
  const enabled = (container: HTMLElement): HTMLInputElement => container.querySelector<HTMLInputElement>("#monitoring-enabled")!;
  const turnOn = (container: HTMLElement): void => {
    enabled(container).checked = true;
    enabled(container).dispatchEvent(new Event("change"));
  };

  it("sends the four global fields as they stand", async () => {
    const panel = integration({ monitoringOn: false });
    const { container } = await shown(panel);

    turnOn(container);
    await settle();

    expect(panel.saves[0]).toEqual({ service: "set_global_monitoring", ...GLOBALS, config_entry_id: "entry-1" });
  });

  it.each([
    ["g-spike", "250", "Enter a whole number from 1 to 200."],
    ["g-continuous", "12.5", "Enter a whole number from 1 to 200."],
    ["g-window", "", "Enter a whole number from 1 to 180."],
  ])("is refused with %s set to %j, which is marked, and nothing is sent", async (id, value, message) => {
    // Monitoring is off, its fields dimmed, but the keyboard still reaches them.
    const panel = integration({ monitoringOn: false });
    const { container } = await shown(panel);
    typeOnly(global(container, id), value);

    turnOn(container);
    await settle();

    expect(panel.saves).toEqual([]);
    expect(enabled(container).checked).toBe(false);
    expect(container.querySelector<HTMLElement>("#global-fields")!.style.pointerEvents).toBe("none");
    expect(global(container, id).getAttribute("aria-invalid")).toBe("true");
    expect(said(global(container, id))).toBe(message);
    expect(container.querySelector("#global-status")!.textContent).toBe("Error: Monitoring was not turned on: correct the fields marked.");
  });

  it("is put back as it was where the integration refuses it", async () => {
    const panel = integration({ monitoringOn: false, refuse: { set_global_monitoring: { message: "Not loaded" } } });
    const { container } = await shown(panel);

    turnOn(container);
    await vi.waitFor(() => expect(container.querySelector("#global-status")!.textContent).toBe("Error: Not loaded"));

    expect(enabled(container).checked).toBe(false);
    expect(container.querySelector<HTMLElement>("#global-fields")!.style.pointerEvents).toBe("none");
  });
});
