import { describe, it, expect, afterEach, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
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
 * the point's override, and a global save the thresholds of every point without one.
 */
function integration(): Integration {
  const globals: Fields = { ...GLOBALS };
  const circuits: Record<string, MonitoringPointInfo> = { [OVEN]: point("Oven") };
  const mains: Record<string, MonitoringPointInfo> = { [MAINS]: point("Mains") };
  const saves: Message[] = [];
  let reads = 0;
  let heldReads: Array<() => void> | null = null;
  let heldSaves: Array<() => void> | null = null;
  const status = (): unknown => ({
    response: { enabled: true, global_settings: { ...globals }, circuits: structuredClone(circuits), mains: structuredClone(mains) },
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
    const apply = (): void => {
      if (msg.service === "set_circuit_threshold" && typeof data.circuit_id === "string") {
        circuits[data.circuit_id] = { ...circuits[data.circuit_id]!, ...fieldsOf(data), has_override: true };
      }
      if (msg.service === "set_mains_threshold" && typeof data.leg === "string") {
        mains[data.leg] = { ...mains[data.leg]!, ...fieldsOf(data), has_override: true };
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
  const hass = { states: {}, services: {}, language: "en", callService: async () => undefined, callWS } as unknown as HomeAssistant;
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
  const global = (container: HTMLElement, id: string): HTMLInputElement => container.querySelector<HTMLInputElement>(`#${id}`)!;

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
