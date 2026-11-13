import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { ErrorStore } from "../src/core/error-store.js";
import { setLanguage, t, tf } from "../src/i18n.js";
import { blurOnRemoval } from "./removal-blur.js";
import type { HomeAssistant, MonitoringPointInfo, PackageRatingsForm } from "../src/types.js";

type Message = Record<string, unknown>;
type Thresholds = Partial<Record<"continuous_threshold_pct" | "spike_threshold_pct" | "window_duration_m" | "cooldown_duration_m", number>>;

const GLOBALS = { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 };
const THRESHOLD_FIELDS = ["continuous_threshold_pct", "spike_threshold_pct", "window_duration_m", "cooldown_duration_m"] as const;

/** Synthetic circuits, by entity id; the tab draws them by name, so Garage, Kitchen, Oven, then Washer Dryer. */
const GARAGE = "sensor.garage_current";
const KITCHEN = "sensor.kitchen_current";
const OVEN = "sensor.oven_current";
const DRYER = "sensor.washer_dryer_current";
const MAINS = "sensor.span_panel_current_power";

/** Each circuit's point id, which the package-ratings services name it by, and the form its copy takes. */
const CIRCUITS: ReadonlyArray<readonly [string, string, string, PackageRatingsForm | null]> = [
  [GARAGE, "Garage", "circuit-7", "one_space"],
  // A member of a shared meter, which takes no copy.
  [KITCHEN, "Kitchen", "circuit-9", null],
  [OVEN, "Oven", "circuit-2", "one_space"],
  [DRYER, "Washer Dryer", "circuit-18", "two_spaces"],
];

/** The §14.6 text, as approved. */
const NOTE_TITLE = "Tandem breakers on SPAN Panel MAIN 32";
const NOTE_PARAGRAPHS = [
  "SPAN Panel MAIN 32 panels do not report which breakers are tandems, or the rating of a tandem's second breaker. A tandem puts two breakers in " +
    "one space, but the panel reports it as one circuit with only the first breaker's rating, while one sensor reads both breakers together. A " +
    "20-20 tandem shows 20 A here and can carry 40 A, so monitoring raises false alerts on it.",
  "To fix this, copy the ratings from your SPAN app:",
  "Monitoring then judges that space against both breakers together: 40 A for a 20-20. Only monitoring uses the copy, and the circuit's Breaker " +
    "Rating sensor still shows what the panel reports. To remove a copied rating, select ✕ beside its field.",
  "If you raised a tandem's thresholds above 100% to stop its alerts, select Reset on its row. Those thresholds now apply to both breakers together.",
  "For a circuit that spans two spaces, enter the second rating the same way if your SPAN app shows two, such as 20-30A. SPAN Panel MAIN 32 " +
    "panels report only the average of such a circuit's two legs, which can hide an overloaded leg, so the copy can't be applied and we recommend " +
    "turning monitoring off for that circuit.",
];
const NOTE_STEPS = [
  "In the SPAN app, find each circuit whose breaker shows two ratings, such as 20-20A.",
  "In the table below, type the second rating in that circuit's Rating field. Then press Enter or move to the next field.",
  "Leave the field empty for a circuit with a single breaker.",
];
const OWN_WARNING =
  "This circuit's thresholds are above 100% and now apply to both breakers together, which can let a real overload pass. Select Reset to use the " +
  "global thresholds.";
const GLOBAL_WARNING =
  "The global thresholds are above 100% and now apply to both breakers together, which can let a real overload pass. Change them under Global " +
  "Settings above.";
const AVERAGED_LEGS_WARNING =
  "SPAN Panel MAIN 32 panels report only the average of this circuit's two legs, which can hide an overloaded leg. We recommend turning " +
  "monitoring off for this circuit.";
const INVALID = "Enter the other breaker's rating as a whole number of amps, 1 or more.";

/** What a threshold service call carries. */
function thresholdsOf(data: Message): Thresholds {
  const out: Thresholds = {};
  for (const key of THRESHOLD_FIELDS) {
    const value = data[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/**
 * A circuit holding `ratings` as its copy, as the integration resolves it: one in
 * one space applies, judged against both breakers; one across two spaces is kept
 * on the averaged legs, judged against the panel's rating; none leaves the panel's.
 */
function withCopy(info: MonitoringPointInfo, ratings: number[] | null): MonitoringPointInfo {
  const panel = info.breaker_rating_a ?? 0;
  if (!ratings) {
    return { ...info, package_ratings_a: null, package_ratings_state: null, monitoring_rating_a: panel, monitoring_rating_user_set: false };
  }
  const applies = info.package_ratings_form === "one_space";
  return {
    ...info,
    package_ratings_a: [...ratings],
    package_ratings_state: applies ? "applies" : "averaged_legs",
    monitoring_rating_a: applies ? ratings.reduce((sum, amps) => sum + amps, 0) : panel,
    monitoring_rating_user_set: applies,
  };
}

interface Options {
  /** The status root's `monitoring_rating_offered`, or "absent" to leave it out, as an integration that predates it does. */
  offered?: boolean | "absent";
  /** Each circuit's stored copy, by entity id. */
  copies?: Record<string, number[]>;
  /** Each circuit's own thresholds, by entity id, an override. */
  overrides?: Record<string, Thresholds>;
  /** Circuits with monitoring off, by entity id. */
  off?: readonly string[];
  globals?: Thresholds;
  /** The form the mains' entry names, which the integration never does. */
  mainsForm?: PackageRatingsForm | null;
  /** Fields of a circuit's entry as the integration reports them, by entity id, over what the rest gives. */
  patch?: Record<string, Partial<MonitoringPointInfo>>;
  /** A service named here is refused with the error given for it. */
  refuse?: Record<string, unknown>;
}

interface Integration {
  hass: HomeAssistant;
  /** Every service call other than the status read, as sent. */
  saves: Message[];
  /** How many times the tab read the monitoring status. */
  reads: () => number;
  /** Hold every later save until the test answers it. */
  holdSaves: () => Array<() => void>;
}

/**
 * One MAIN 32's monitoring as the integration reports it: a package-ratings set
 * stores the copy, resolved by the form the circuit takes, and a clear removes
 * it; a threshold save becomes the circuit's override, monitoring turned off
 * among it.
 */
function integration({
  offered = true,
  copies = {},
  overrides = {},
  off = [],
  globals = {},
  mainsForm = null,
  patch = {},
  refuse = {},
}: Options = {}): Integration {
  const settings = { ...GLOBALS, ...globals };
  const circuits: Record<string, MonitoringPointInfo> = {};
  for (const [entity, name, pointId, form] of CIRCUITS) {
    const base: MonitoringPointInfo = {
      name,
      point_id: pointId,
      monitoring_enabled: !off.includes(entity),
      has_override: entity in overrides || off.includes(entity),
      breaker_rating_a: 20,
      package_ratings_form: form,
      ...settings,
      ...overrides[entity],
    };
    circuits[entity] = { ...withCopy(base, copies[entity] ?? null), ...patch[entity] };
  }
  const mains: Record<string, MonitoringPointInfo> = {
    [MAINS]: {
      name: "Mains Breaker",
      monitoring_enabled: true,
      has_override: false,
      breaker_rating_a: 200,
      monitoring_rating_a: 200,
      monitoring_rating_user_set: false,
      package_ratings_a: null,
      package_ratings_form: mainsForm,
      package_ratings_state: null,
      point_id: "upstream_l1",
      ...settings,
    },
  };
  const byPoint = (pointId: unknown): string | undefined => Object.keys(circuits).find(entity => circuits[entity]!.point_id === pointId);
  const saves: Message[] = [];
  let reads = 0;
  let heldSaves: Array<() => void> | null = null;
  const root = (): Message => {
    const status: Message = { enabled: true, global_settings: { ...settings }, circuits: structuredClone(circuits), mains: structuredClone(mains) };
    if (offered !== "absent") status.monitoring_rating_offered = offered;
    return status;
  };
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    if (msg.service === "get_monitoring_status") {
      reads += 1;
      return { response: root() };
    }
    const data = (msg.service_data ?? {}) as Message;
    saves.push({ service: msg.service, ...data });
    if (typeof msg.service === "string" && msg.service in refuse) throw refuse[msg.service];
    const apply = (): void => {
      const pointEntity = byPoint(data.circuit_id);
      if (msg.service === "set_circuit_package_ratings" && pointEntity && Array.isArray(data.package_ratings_a)) {
        circuits[pointEntity] = withCopy(circuits[pointEntity]!, data.package_ratings_a as number[]);
      }
      if (msg.service === "clear_circuit_package_ratings" && pointEntity) {
        circuits[pointEntity] = withCopy(circuits[pointEntity]!, null);
      }
      if (msg.service === "set_circuit_threshold" && typeof data.circuit_id === "string" && data.circuit_id in circuits) {
        const enabled = typeof data.monitoring_enabled === "boolean" ? { monitoring_enabled: data.monitoring_enabled } : {};
        circuits[data.circuit_id] = { ...circuits[data.circuit_id]!, ...thresholdsOf(data), ...enabled, has_override: true };
      }
      if (msg.service === "clear_circuit_threshold" && typeof data.circuit_id === "string" && data.circuit_id in circuits) {
        circuits[data.circuit_id] = { ...circuits[data.circuit_id]!, ...settings, monitoring_enabled: true, has_override: false };
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
  return { hass, saves, reads: () => reads, holdSaves: () => (heldSaves = []) };
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  setLanguage("en");
});

/**
 * The tab drawn as the dashboard draws it, in a container inside the panel's
 * shadow root: happy-dom's document is no `Document`, so focus is read there.
 */
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

/** A circuit's row, by its switch. */
const rowOf = (container: HTMLElement, entity: string): HTMLTableRowElement =>
  container.querySelector<HTMLElement>(`.circuit-toggle[data-entity="${entity}"]`)!.closest("tr")!;

/** A point's Rating cell, as drawn now. */
const ratingCellOf = (container: HTMLElement, entity: string, toggle = "circuit-toggle"): HTMLElement =>
  container.querySelector<HTMLElement>(`.${toggle}[data-entity="${entity}"]`)!.closest("tr")!.querySelector<HTMLElement>(".rating-cell")!;

/** A circuit's other-breaker field, as drawn now; null where its row draws none. */
const fieldOf = (container: HTMLElement, entity: string): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>(`.rating-input[data-entity="${entity}"]`);

/** A circuit's ✕, as drawn now; null where its row draws none. */
const clearOf = (container: HTMLElement, entity: string): HTMLElement | null => container.querySelector<HTMLElement>(`.rating-clear[data-entity="${entity}"]`);

/** The warning drawn under a circuit's row, or null where there is none. */
function warningOf(container: HTMLElement, entity: string): HTMLElement | null {
  const next = rowOf(container, entity).nextElementSibling;
  return next instanceof HTMLElement && next.classList.contains("rating-warning-row") ? next : null;
}

/** The element a field names as its description. */
function description(field: HTMLInputElement): HTMLElement | null {
  const id = field.getAttribute("aria-describedby");
  const root = field.getRootNode();
  return id && root instanceof ShadowRoot ? root.getElementById(id) : null;
}

/** Type `value` into the field, as keystrokes do, without committing it. */
function typeOnly(el: HTMLInputElement, value: string): void {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

function enter(el: HTMLInputElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
}

/** Type `value` and commit it with Enter. */
function type(el: HTMLInputElement, value: string): void {
  typeOnly(el, value);
  enter(el);
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** The text of an element, its runs of white space as one space. */
const textOf = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the MAIN 32 note above the table", () => {
  it("is drawn, as approved, where the integration offers package ratings", async () => {
    const { container } = await shown(integration({ offered: true }));
    const note = container.querySelector<HTMLElement>(".rating-note")!;

    expect(textOf(note.querySelector("h4"))).toBe(NOTE_TITLE);
    expect([...note.querySelectorAll("p")].map(textOf)).toEqual(NOTE_PARAGRAPHS);
    expect([...note.querySelectorAll("ol > li")].map(textOf)).toEqual(NOTE_STEPS);
  });

  it("sits above the table the fields are in", async () => {
    const { container } = await shown(integration({ offered: true }));
    const note = container.querySelector(".rating-note")!;
    const table = container.querySelector("table")!;

    expect(note.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ["not offered", false],
    ["left out, by an integration that predates it", "absent" as const],
  ])("is not drawn, nor any field, where the offer is %s", async (_name, offered) => {
    const { container } = await shown(integration({ offered, copies: { [OVEN]: [20, 20] } }));

    expect(container.querySelector(".rating-note")).toBeNull();
    expect(container.textContent).not.toContain(NOTE_TITLE);
    expect(container.querySelectorAll(".rating-input")).toHaveLength(0);
    expect(container.querySelectorAll(".rating-clear")).toHaveLength(0);
  });

  it("keeps the ✎ mark on a copy where no field is offered", async () => {
    const { container } = await shown(integration({ offered: false, copies: { [OVEN]: [20, 20] } }));

    expect(ratingCellOf(container, OVEN).querySelector(".rating-user-set")).not.toBeNull();
  });
});

describe("a one-space circuit's Rating cell", () => {
  it("shows the panel's rating and an empty field, and nothing judged by a copy", async () => {
    const { container } = await shown(integration());
    const cell = ratingCellOf(container, OVEN);
    const field = fieldOf(container, OVEN)!;

    expect(textOf(cell)).toBe("20 A +");
    expect(cell.contains(field)).toBe(true);
    expect(field.value).toBe("");
    expect(field.dataset.circuit).toBe("circuit-2");
    expect(field.getAttribute("aria-label")).toBe("Other breaker in the space of Oven");
    expect(clearOf(container, OVEN)).toBeNull();
  });

  it("sends the panel's rating and the one typed on Enter, then shows what the copy is judged at, with its ✕", async () => {
    const panel = integration();
    const { container } = await shown(panel);

    type(fieldOf(container, OVEN)!, "20");
    await vi.waitFor(() => expect(clearOf(container, OVEN)).not.toBeNull());

    expect(panel.saves).toEqual([{ service: "set_circuit_package_ratings", circuit_id: "circuit-2", package_ratings_a: [20, 20], config_entry_id: "entry-1" }]);
    const cell = ratingCellOf(container, OVEN);
    expect(fieldOf(container, OVEN)!.value).toBe("20");
    expect(textOf(cell)).toBe("20 A + = 40 A ✕");
    expect(clearOf(container, OVEN)!.getAttribute("aria-label")).toBe("Remove copied ratings for Oven");
    // The field shows the copy, so the cell draws no ✎ mark.
    expect(cell.querySelector(".rating-user-set")).toBeNull();
  });

  it("sends nothing for an entry that is not a whole number of amps, saying what to enter", async () => {
    const panel = integration();
    const { container } = await shown(panel);
    const field = fieldOf(container, OVEN)!;

    type(field, "0");
    field.blur();
    await settle();

    expect(panel.saves).toEqual([]);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(description(field)!.textContent).toBe(INVALID);
    expect(description(field)!.getAttribute("aria-live")).toBe("polite");
  });

  it("removes the copy with its ✕, and the cell goes back to the panel's rating", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] } });
    const { container } = await shown(panel);

    clearOf(container, OVEN)!.click();
    await vi.waitFor(() => expect(clearOf(container, OVEN)).toBeNull());

    expect(panel.saves).toEqual([{ service: "clear_circuit_package_ratings", circuit_id: "circuit-2", config_entry_id: "entry-1" }]);
    expect(fieldOf(container, OVEN)!.value).toBe("");
    expect(textOf(ratingCellOf(container, OVEN))).toBe("20 A +");
  });

  it("marks its ✕ busy while the removal is on its way, sending nothing on a second click", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] } });
    const { container } = await shown(panel);
    const pending = panel.holdSaves();
    const clear = clearOf(container, OVEN)!;

    clear.click();
    clear.click();
    await settle();

    expect(panel.saves).toEqual([{ service: "clear_circuit_package_ratings", circuit_id: "circuit-2", config_entry_id: "entry-1" }]);
    expect(clear.getAttribute("aria-disabled")).toBe("true");
    for (const answer of pending) answer();
  });

  it("says why a removal failed, its ✕ usable again", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, refuse: { clear_circuit_package_ratings: { message: "The panel is not loaded" } } });
    const { tab, container } = await shown(panel);
    const errors = new ErrorStore();
    tab.errorStore = errors;
    const clear = clearOf(container, OVEN)!;

    clear.click();
    await vi.waitFor(() => expect(errors.active.map(e => e.message)).toEqual(["The panel is not loaded"]));

    await vi.waitFor(() => expect(clear.hasAttribute("aria-disabled")).toBe(false));
    expect(clearOf(container, OVEN)).toBe(clear);
  });

  it("takes what the field held with the copy, a value needing correction and what was said of it included", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, refuse: { clear_circuit_package_ratings: { message: "The panel is not loaded" } } });
    const { container } = await shown(panel);
    const field = fieldOf(container, OVEN)!;
    type(field, "0");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    clearOf(container, OVEN)!.click();
    await vi.waitFor(() => expect(panel.saves).toHaveLength(1));

    // The removal failed, so the copy in force is still the one shown.
    expect(field.value).toBe("20");
    expect(field.hasAttribute("aria-invalid")).toBe(false);
    expect(description(field)!.textContent).toBe("");
  });

  it("draws nothing judged while a copy waits on a value", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, patch: { [OVEN]: { package_ratings_state: "pending", monitoring_rating_a: 20 } } });
    const { container } = await shown(panel);

    expect(textOf(ratingCellOf(container, OVEN))).toBe("20 A + ✕");
    expect(fieldOf(container, OVEN)!.value).toBe("20");
  });

  it("names its field and its ✕ by the circuit's name as written, markup and quotes included", async () => {
    const written = `Oven "A" <b>&</b>`;
    const { container } = await shown(integration({ copies: { [OVEN]: [20, 20] }, patch: { [OVEN]: { name: written } } }));

    expect(fieldOf(container, OVEN)!.getAttribute("aria-label")).toBe(`Other breaker in the space of ${written}`);
    expect(clearOf(container, OVEN)!.getAttribute("aria-label")).toBe(`Remove copied ratings for ${written}`);
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("a refused copy", () => {
  const REFUSAL = {
    code: "service_validation_error",
    message: "Validation error: The two breakers together exceed the panel's service rating",
  };

  it("shows the integration's reason and puts the copy in force back in the field", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, refuse: { set_circuit_package_ratings: REFUSAL } });
    const { tab, container } = await shown(panel);
    const errors = new ErrorStore();
    tab.errorStore = errors;
    const reads = panel.reads();
    const field = fieldOf(container, OVEN)!;

    type(field, "300");
    await vi.waitFor(() => expect(errors.active.map(e => e.message)).toEqual(["The two breakers together exceed the panel's service rating"]));

    expect(fieldOf(container, OVEN)).toBe(field);
    expect(field.value).toBe("20");
    expect(panel.reads()).toBe(reads);
  });

  it("says it could not update the copy where the integration gives no reason", async () => {
    const panel = integration({ refuse: { set_circuit_package_ratings: {} } });
    const { tab, container } = await shown(panel);
    const errors = new ErrorStore();
    tab.errorStore = errors;

    type(fieldOf(container, OVEN)!, "20");

    await vi.waitFor(() => expect(errors.active.map(e => e.message)).toEqual(["Unable to update the ratings copied from the SPAN app"]));
    expect(fieldOf(container, OVEN)!.value).toBe("");
  });
});

describe("a two-space circuit's Rating cell", () => {
  it("sends the package typed, and shows the copy kept with its ✕, judged at nothing it adds", async () => {
    const panel = integration();
    const { container } = await shown(panel);

    type(fieldOf(container, DRYER)!, "30");
    await vi.waitFor(() => expect(clearOf(container, DRYER)).not.toBeNull());

    expect(panel.saves).toEqual([
      { service: "set_circuit_package_ratings", circuit_id: "circuit-18", package_ratings_a: [20, 30], config_entry_id: "entry-1" },
    ]);
    expect(textOf(ratingCellOf(container, DRYER))).toBe("20 A + ✕");
    expect(fieldOf(container, DRYER)!.value).toBe("30");
  });

  it("recommends turning monitoring off under the row, with a button that does it", async () => {
    const panel = integration({ copies: { [DRYER]: [20, 30] } });
    const { container } = await shown(panel);
    const warning = warningOf(container, DRYER)!;
    const button = warning.querySelector<HTMLButtonElement>("button")!;

    expect(textOf(warning.querySelector('[role="note"] > span'))).toBe(AVERAGED_LEGS_WARNING);
    expect(textOf(button)).toBe("Turn off monitoring");
    expect(button.getAttribute("aria-label")).toBe("Turn off monitoring for Washer Dryer");

    button.click();
    await vi.waitFor(() => expect(warningOf(container, DRYER)).toBeNull());

    expect(panel.saves).toEqual([{ service: "set_circuit_threshold", circuit_id: DRYER, monitoring_enabled: false, config_entry_id: "entry-1" }]);
    // The row's field stays, dimmed with the row, for the copy to be kept or changed.
    expect(fieldOf(container, DRYER)!.value).toBe("30");
    expect(rowOf(container, DRYER).style.opacity).toBe("0.4");
  });

  it("sends from its button the very call the row's switch sends", async () => {
    const byButton = integration({ copies: { [DRYER]: [20, 30] } });
    const byButtonTab = await shown(byButton);
    warningOf(byButtonTab.container, DRYER)!.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(byButton.saves).toHaveLength(1));

    const bySwitch = integration({ copies: { [DRYER]: [20, 30] } });
    const bySwitchTab = await shown(bySwitch);
    const toggle = bySwitchTab.container.querySelector<HTMLInputElement>(`.circuit-toggle[data-entity="${DRYER}"]`)!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(bySwitch.saves).toHaveLength(1));

    expect(byButton.saves).toEqual(bySwitch.saves);
  });

  it("moves focus from the button that went with the warning to the row's switch", async () => {
    const panel = integration({ copies: { [DRYER]: [20, 30] } });
    const { container, root } = await shown(panel);
    const button = warningOf(container, DRYER)!.querySelector<HTMLButtonElement>("button")!;
    button.focus();

    button.click();
    await vi.waitFor(() => expect(warningOf(container, DRYER)).toBeNull());

    expect(root.activeElement).toBe(container.querySelector(`.circuit-toggle[data-entity="${DRYER}"]`));
  });

  it("marks its button busy while the call is on its way, sending nothing on a second click", async () => {
    const panel = integration({ copies: { [DRYER]: [20, 30] } });
    const { container } = await shown(panel);
    const pending = panel.holdSaves();
    const button = warningOf(container, DRYER)!.querySelector<HTMLButtonElement>("button")!;

    button.click();
    button.click();
    await settle();

    expect(panel.saves).toHaveLength(1);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    for (const answer of pending) answer();
  });

  it("keeps the warning and a usable button where turning monitoring off fails, saying so", async () => {
    const panel = integration({ copies: { [DRYER]: [20, 30] }, refuse: { set_circuit_threshold: { message: "Not loaded" } } });
    const { tab, container } = await shown(panel);
    const errors = new ErrorStore();
    tab.errorStore = errors;
    const button = warningOf(container, DRYER)!.querySelector<HTMLButtonElement>("button")!;

    button.click();
    await vi.waitFor(() => expect(errors.active.map(e => e.message)).toEqual(["Unable to save threshold"]));

    await vi.waitFor(() => expect(button.hasAttribute("aria-disabled")).toBe(false));
    expect(warningOf(container, DRYER)).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>(`.circuit-toggle[data-entity="${DRYER}"]`)!.checked).toBe(true);
  });

  it("draws no warning while monitoring is off for the circuit, and keeps the field", async () => {
    const { container } = await shown(integration({ copies: { [DRYER]: [20, 30] }, off: [DRYER] }));

    expect(warningOf(container, DRYER)).toBeNull();
    expect(fieldOf(container, DRYER)!.value).toBe("30");
    expect(clearOf(container, DRYER)).not.toBeNull();
  });

  it("gives no threshold warning, whatever its thresholds", async () => {
    const panel = integration({ copies: { [DRYER]: [20, 30] }, overrides: { [DRYER]: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } } });
    const { container } = await shown(panel);

    expect(container.querySelectorAll(".rating-warning-row")).toHaveLength(1);
    expect(textOf(warningOf(container, DRYER)!.querySelector('[role="note"] > span'))).toBe(AVERAGED_LEGS_WARNING);
  });
});

describe("a row's threshold warning", () => {
  it("names the circuit's own thresholds above 100% under a copy that applies, pointing to the row's Reset", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, overrides: { [OVEN]: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } } });
    const { container } = await shown(panel);
    const warning = warningOf(container, OVEN)!;

    expect(textOf(warning)).toBe(OWN_WARNING);
    expect(warning.querySelector('[role="note"]')).not.toBeNull();
    expect(warning.querySelector("button")).toBeNull();
    expect(rowOf(container, OVEN).querySelector(".reset-btn")).not.toBeNull();
  });

  it("names the global thresholds above 100%, pointing to Global Settings", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, globals: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } });
    const { container } = await shown(panel);

    expect(textOf(warningOf(container, OVEN))).toBe(GLOBAL_WARNING);
  });

  it("spans the row's every column, directly under it", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, globals: { spike_threshold_pct: 150 } });
    const { container } = await shown(panel);
    const warning = warningOf(container, OVEN)!;

    expect(warning.tagName).toBe("TR");
    expect(warning.children).toHaveLength(1);
    expect(Number(warning.querySelector("td")!.getAttribute("colspan"))).toBe(rowOf(container, OVEN).children.length);
  });

  it("appears once a copy entered for the row applies", async () => {
    const panel = integration({ overrides: { [OVEN]: { continuous_threshold_pct: 160 } } });
    const { container } = await shown(panel);
    expect(warningOf(container, OVEN)).toBeNull();

    type(fieldOf(container, OVEN)!, "20");

    await vi.waitFor(() => expect(textOf(warningOf(container, OVEN))).toBe(OWN_WARNING));
  });

  it("is not drawn with every threshold at 100% or below", async () => {
    const { container } = await shown(integration({ copies: { [OVEN]: [20, 20], [GARAGE]: [20, 15] } }));

    expect(container.querySelectorAll(".rating-warning-row")).toHaveLength(0);
  });

  it("is not drawn while monitoring is off for the circuit, whose Reset would turn monitoring back on", async () => {
    // Monitoring turned off is an override, so the circuit has a Reset, yet it is judged by the global thresholds.
    const panel = integration({ copies: { [OVEN]: [20, 20] }, off: [OVEN], globals: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } });
    const { container } = await shown(panel);

    expect(rowOf(container, OVEN).querySelector(".reset-btn")).not.toBeNull();
    expect(warningOf(container, OVEN)).toBeNull();
    expect(container.querySelectorAll(".rating-warning-row")).toHaveLength(0);
    // The field stays, dimmed with the row, for the copy to be kept or changed.
    expect(fieldOf(container, OVEN)!.value).toBe("20");
  });

  it("comes back once monitoring is turned on again for the circuit", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] }, off: [OVEN], globals: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } });
    const { container } = await shown(panel);
    const toggle = container.querySelector<HTMLInputElement>(`.circuit-toggle[data-entity="${OVEN}"]`)!;

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    // The switch's override stays, so the warning is the circuit's own, pointing to its Reset.
    await vi.waitFor(() => expect(textOf(warningOf(container, OVEN))).toBe(OWN_WARNING));
  });
});

describe("rows that take no copy", () => {
  it("draw no field for the mains, whatever its entry says", async () => {
    const { container } = await shown(integration({ mainsForm: "one_space" }));

    expect(fieldOf(container, MAINS)).toBeNull();
    expect(textOf(ratingCellOf(container, MAINS, "mains-toggle"))).toBe("200A");
  });

  it("draw the rating as before where the integration names no form", async () => {
    const { container } = await shown(integration());

    expect(fieldOf(container, KITCHEN)).toBeNull();
    expect(textOf(ratingCellOf(container, KITCHEN))).toBe("20A");
  });
});

describe("a redraw after a save, which in Chromium blurs a focused field as it removes it", () => {
  let undo: () => void = () => {};
  beforeEach(() => (undo = blurOnRemoval()));
  afterEach(() => undo());

  it("keeps what was typed in another row's field, and focus on it, sending nothing for it until committed", async () => {
    const panel = integration();
    const { container, root } = await shown(panel);
    const pending = panel.holdSaves();

    // Row B commits; the user moves to row A and types there while row B's save is on its way.
    type(fieldOf(container, GARAGE)!, "20");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const typed = fieldOf(container, OVEN)!;
    typeOnly(typed, "3");
    for (const answer of pending) answer();
    await vi.waitFor(() => expect(fieldOf(container, OVEN)).not.toBe(typed));
    await settle();

    const redrawn = fieldOf(container, OVEN)!;
    expect(redrawn.value).toBe("3");
    expect(root.activeElement).toBe(redrawn);
    expect(panel.saves).toEqual([{ service: "set_circuit_package_ratings", circuit_id: "circuit-7", package_ratings_a: [20, 20], config_entry_id: "entry-1" }]);

    // What they typed is still theirs to commit, with no more typing.
    enter(redrawn);
    await settle();
    expect(panel.saves[1]).toEqual({ service: "set_circuit_package_ratings", circuit_id: "circuit-2", package_ratings_a: [20, 3], config_entry_id: "entry-1" });
  });

  it("keeps focus on a field the user committed with Enter", async () => {
    const panel = integration();
    const { container, root } = await shown(panel);
    const field = fieldOf(container, OVEN)!;

    type(field, "20");
    await vi.waitFor(() => expect(fieldOf(container, OVEN)).not.toBe(field));

    expect(root.activeElement).toBe(fieldOf(container, OVEN));
    expect(panel.saves).toHaveLength(1);
  });

  it("moves focus from a ✕ that went with its copy to the field the copy was in", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] } });
    const { container, root } = await shown(panel);
    const clear = clearOf(container, OVEN)!;
    clear.focus();

    clear.click();
    await vi.waitFor(() => expect(clearOf(container, OVEN)).toBeNull());

    expect(root.activeElement).toBe(fieldOf(container, OVEN));
  });

  it("stays on a ✕ that is still there after a redraw for another reason", async () => {
    const panel = integration({ copies: { [OVEN]: [20, 20] } });
    const { container, root } = await shown(panel);
    clearOf(container, OVEN)!.focus();
    const reads = panel.reads();

    const toggle = container.querySelector<HTMLInputElement>(`.mains-toggle[data-entity="${MAINS}"]`)!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(panel.reads()).toBe(reads + 1));
    await settle();

    expect(root.activeElement).toBe(clearOf(container, OVEN));
  });

  it("sends nothing for a field half typed as the dashboard clears the tab", async () => {
    const panel = integration();
    const { tab, container } = await shown(panel);
    typeOnly(fieldOf(container, OVEN)!, "20");

    tab.stop();
    container.innerHTML = "";
    await settle();

    expect(panel.saves).toEqual([]);
  });
});

describe("the Monitoring tab's copy text in each language", () => {
  const PROSE = [
    "note_title",
    "note_problem",
    "note_steps",
    "note_step_find",
    "note_step_enter",
    "note_step_single",
    "note_judged",
    "note_thresholds",
    "note_two_spaces",
    "clear_label",
    "table_threshold_warning",
    "table_threshold_warning_global",
  ].map(key => `monitoringRating.${key}`);

  it.each(["en", "es", "fr", "ja", "pt"])("%s has every key, with its placeholders", lang => {
    setLanguage(lang);
    for (const key of [...PROSE, "monitoringRating.judged_equals", "monitoringRating.panel_plus"]) expect(t(key)).not.toBe(key);
    expect(tf("monitoringRating.clear_label", { circuit: "<C>" })).toContain("<C>");
    expect(tf("monitoringRating.judged_equals", { rating: "<R>" })).toContain("<R>");
    expect(tf("monitoringRating.panel_plus", { panel: "<P>" })).toContain("<P>");
    expect(tf("monitoringRating.note_step_enter", { column: "<COL>" })).toContain("<COL>");
    expect(tf("monitoringRating.note_thresholds", { reset: "<RESET>" })).toContain("<RESET>");
    expect(tf("monitoringRating.table_threshold_warning", { reset: "<RESET>" })).toContain("<RESET>");
    expect(tf("monitoringRating.table_threshold_warning_global", { settings: "<S>" })).toContain("<S>");
  });

  it.each(["es", "fr", "ja", "pt"])("%s says it in its own words", lang => {
    const english = PROSE.map(key => t(key));
    setLanguage(lang);

    expect(PROSE.map(key => t(key)).filter((text, i) => text === english[i])).toEqual([]);
  });

  it("names the column, the Reset and the settings by the labels the tab shows, in the user's language", async () => {
    setLanguage("es");
    const { container } = await shown(integration({ copies: { [OVEN]: [20, 20] }, overrides: { [OVEN]: { continuous_threshold_pct: 160 } } }));

    expect(textOf(container.querySelector(".rating-note ol > li:nth-child(2)"))).toContain(t("monitoring.rating"));
    expect(textOf(warningOf(container, OVEN))).toContain(t("monitoring.reset"));
  });
});
