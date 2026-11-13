import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";
import "../src/core/side-panel.js";
import { blurOnRemoval } from "./removal-blur.js";
import type { CardConfig, Circuit, HomeAssistant, PackageRatingsForm, PackageRatingsState, PanelTopology } from "../src/types.js";

type CallWS = (message: Record<string, unknown>) => Promise<unknown>;
type SidePanel = HTMLElement & { hass: HomeAssistant; errorStore: ErrorStore | null; open(config: unknown): void };

function hass(callWS: CallWS): HomeAssistant {
  return { states: {}, services: {}, language: "en", callService: async () => undefined, callWS } as unknown as HomeAssistant;
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.useRealTimers();
});
beforeEach(() => vi.useFakeTimers());

/**
 * A circuit as the integration's topology describes it on a SPAN Panel MAIN 32. `copied` is the package the user copied
 * from the SPAN app, if any, and `applies` false holds it waiting on a value not yet arrived. The form and the state are
 * the integration's: a rated circuit in one or two spaces takes a copy, and a two-space copy is kept on averaged legs,
 * never applied.
 */
function circuit(name: string, panel: number | null, copied: number[] | null = null, tabs: number[] = [1], applies = copied !== null): Circuit {
  const form: PackageRatingsForm | null = panel === null ? null : tabs.length === 1 ? "one_space" : tabs.length === 2 ? "two_spaces" : null;
  const state: PackageRatingsState | null = copied === null ? null : !applies ? "pending" : form === "two_spaces" ? "averaged_legs" : "applies";
  const userSet = state === "applies";
  const judged = userSet && copied ? copied.reduce((sum, rating) => sum + rating, 0) : panel;
  return {
    name,
    tabs,
    entities: {},
    breaker_rating_a: panel,
    monitoring_rating_a: judged,
    monitoring_rating_user_set: userSet,
    package_ratings_a: copied,
    package_ratings_form: form,
    package_ratings_state: state,
  };
}

interface Opened {
  panel: SidePanel;
  callWS: ReturnType<typeof vi.fn<CallWS>>;
  errors: ErrorStore;
}

/** Opens the circuit panel as the sidebar dashboard does on a MAIN 32: Monitoring section shown, monitoring on, package ratings offered. */
function open(members: { uuid: string; circuit: Circuit }[], extra: Record<string, unknown> = {}, callWS?: CallWS): Opened {
  const spy = vi.fn<CallWS>(callWS ?? (async () => undefined));
  const panel = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(panel);
  mounted.push(panel);
  panel.hass = hass(spy);
  const errors = new ErrorStore();
  panel.errorStore = errors;
  panel.open({
    uuid: members[0]!.uuid,
    name: members[0]!.circuit.name,
    entities: {},
    showMonitoring: true,
    monitoringRatingOffered: true,
    monitoringInfo: { monitoring_enabled: true },
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
    members,
    capacityA: null,
    configEntryId: "entry-1",
    ...extra,
  });
  return { panel, callWS: spy, errors };
}

const row = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-row"]');
const input = (p: SidePanel): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>('[data-role="rating-input"]')!;
const reset = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-reset"]');
const panelRating = (p: SidePanel): string | null | undefined => p.shadowRoot!.querySelector('[data-role="rating-panel-rating"]')?.textContent;
const guidance = (p: SidePanel): string | null | undefined => p.shadowRoot!.querySelector('[data-role="rating-guidance"]')?.textContent;
const averagedLegs = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-averaged-legs-warning"]');
const turnOff = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-turn-off-monitoring"]');
const thresholdWarningOf = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-threshold-warning"]');
const toggle = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>('[data-role="monitoring-toggle"]')!;

/** The side panel's guidance and the averaged-legs warning, as approved (spec §14.6). */
const ONE_SPACE_GUIDANCE =
  "If your SPAN app shows two ratings for this circuit, such as 20-20A, enter the second one here. SPAN Panel MAIN 32 panels report only " +
  "the first, and monitoring then judges this space against both breakers together.";
const TWO_SPACES_GUIDANCE = "If your SPAN app shows two ratings for this circuit, such as 20-30A, enter the second one here.";
const AVERAGED_LEGS_TEXT =
  "SPAN Panel MAIN 32 panels report only the average of this circuit's two legs, which can hide an overloaded leg. We recommend turning " +
  "monitoring off for this circuit.";

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

const active = (p: SidePanel): Element | null => p.shadowRoot!.activeElement;
const feedback = (p: SidePanel): string | null | undefined => p.shadowRoot!.querySelector('[data-role="rating-feedback"]')?.textContent;

const OVEN = [{ uuid: "c-1", circuit: circuit("Oven", 20) }];
const COPIED = [{ uuid: "c-1", circuit: circuit("Oven", 20, [20, 30]) }];

const details = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>('[data-role="monitoring-details"]')!;
const editor = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-section"]');
/** Whether the editor is on screen: in the DOM with no ancestor hidden (the details, or the threshold fields). */
function shown(p: SidePanel): boolean {
  for (let el: HTMLElement | null = editor(p); el && el !== (p.shadowRoot!.host as HTMLElement); el = el.parentElement) {
    if (el.style.display === "none") return false;
  }
  return editor(p) !== null;
}

function turnMonitoring(p: SidePanel, on: boolean): void {
  const toggle = p.shadowRoot!.querySelector<HTMLElement & { checked: boolean }>('[data-role="monitoring-toggle"]')!;
  toggle.checked = on;
  toggle.dispatchEvent(new Event("change"));
}

describe("the editor's visibility", () => {
  it("is absent from a panel that does not show the Monitoring section (the standalone card)", () => {
    expect(editor(open(OVEN, { showMonitoring: false }).panel)).toBeNull();
    expect(editor(open(OVEN, { showMonitoring: undefined }).panel)).toBeNull();
  });

  it("is hidden while the circuit's monitoring is off, and returns with the copied breaker when it is turned on", () => {
    const { panel } = open(COPIED, { monitoringInfo: { monitoring_enabled: false } });
    expect(shown(panel)).toBe(false);
    turnMonitoring(panel, true);
    expect(shown(panel)).toBe(true);
    expect(input(panel).value).toBe("30");
    turnMonitoring(panel, false);
    expect(shown(panel)).toBe(false);
    turnMonitoring(panel, true);
    expect(shown(panel)).toBe(true);
    expect(input(panel).value).toBe("30");
  });

  it("is shown in both the Global and the Custom mode", () => {
    expect(shown(open(OVEN, { monitoringInfo: { monitoring_enabled: true, has_override: false } }).panel)).toBe(true);
    expect(shown(open(OVEN, { monitoringInfo: { monitoring_enabled: true, has_override: true } }).panel)).toBe(true);
  });

  it("sits above the Global/Custom choice, outside the threshold fields", () => {
    const { panel } = open(OVEN, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    const radios = panel.shadowRoot!.querySelector<HTMLElement>(".radio-group")!;
    expect(editor(panel)!.compareDocumentPosition(radios) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.shadowRoot!.querySelector('[data-role="threshold-fields"]')!.contains(editor(panel))).toBe(false);
    expect(details(panel).contains(editor(panel))).toBe(true);
  });

  it("follows the Judged against line", () => {
    const { panel } = open(COPIED);
    const judged = panel.shadowRoot!.querySelector('[data-role="judged-against"]')!;
    expect(details(panel).contains(judged)).toBe(true);
    expect(judged.nextElementSibling).toBe(editor(panel));
  });

  it("is absent where the integration offers no package ratings, the Judged against line still shown", () => {
    const { panel } = open(OVEN, { monitoringRatingOffered: false });
    expect(editor(panel)).toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-role="judged-against"]')).not.toBeNull();
  });

  it("is absent where the integration predates package ratings and so says nothing", () => {
    expect(editor(open(OVEN, { monitoringRatingOffered: undefined }).panel)).toBeNull();
  });

  it("is absent where the integration offers the circuit no form of copy, whatever its spaces and rating", () => {
    expect(editor(open([{ uuid: "c-1", circuit: { ...circuit("Oven", 20), package_ratings_form: null } }]).panel)).toBeNull();
  });

  it("is absent where the integration predates forms (2.3.0b1) and says nothing of the circuit's", () => {
    const { package_ratings_form: _form, package_ratings_state: _state, ...older } = circuit("Oven", 20, [20, 30]);
    expect(editor(open([{ uuid: "c-1", circuit: older }]).panel)).toBeNull();
  });

  it("is absent for a shared meter, which is judged by its group's capacity", () => {
    const { panel } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, null, [7]) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, null, [7]) },
    ]);
    expect(editor(panel)).toBeNull();
  });

  it("shows the panel's rating read-only, labelled as the panel's, beside one input for the other breaker", () => {
    const { panel } = open(OVEN);
    expect(panelRating(panel)).toBe("Panel publishes 20 A");
    expect(row(panel)!.querySelectorAll("input")).toHaveLength(1);
    expect(input(panel).value).toBe("");
    expect(input(panel).getAttribute("aria-label")).toBe("Other breaker in the space of Oven");
    expect(row(panel)!.textContent).toContain("Other breaker (A)");
  });

  it("shows the copied other breaker, the panel's own still read-only", () => {
    const { panel } = open(COPIED);
    expect(input(panel).value).toBe("30");
    expect(panelRating(panel)).toBe("Panel publishes 20 A");
  });

  it("describes the field by the panel's rating, the guidance and what it says of a value, announcing changes politely", () => {
    const { panel } = open(COPIED);
    const ids = input(panel).getAttribute("aria-describedby")!.split(" ");
    expect(ids.map(id => panel.shadowRoot!.getElementById(id)?.dataset.role)).toEqual(["rating-panel-rating", "rating-guidance", "rating-feedback"]);
    expect(panel.shadowRoot!.querySelector('[data-role="rating-feedback"]')!.getAttribute("aria-live")).toBe("polite");
    expect(panel.shadowRoot!.querySelector('[data-role="rating-warning-region"]')!.getAttribute("aria-live")).toBe("polite");
    expect(panel.shadowRoot!.querySelector('[data-role="judged-against"]')!.getAttribute("aria-live")).toBe("polite");
  });

  it("titles the section and gives the one-space guidance, asking nothing to be added up", () => {
    const { panel } = open(OVEN);
    expect(editor(panel)!.querySelector(".section-label")!.textContent).toBe("Breaker ratings from the SPAN app");
    expect(guidance(panel)).toBe(ONE_SPACE_GUIDANCE);
  });
});

describe("the editor's layout", () => {
  const css = (p: SidePanel): string => p.shadowRoot!.querySelector("style")!.textContent ?? "";
  const rule = (p: SidePanel, selector: string): string => {
    const at = css(p).indexOf(`${selector} {`);
    return at < 0 ? "" : css(p).slice(at, css(p).indexOf("}", at));
  };

  it("keeps the feedback in the layout while empty, so a screen reader hears it once it speaks", () => {
    const { panel } = open(COPIED);
    expect(css(panel)).not.toContain(".rating-feedback:empty");
  });

  it("lets the row wrap, so the field and the reset fit the 360 px panel", () => {
    const { panel } = open(COPIED);
    expect(row(panel)!.classList.contains("rating-row")).toBe(true);
    expect(rule(panel, ".rating-row")).toContain("flex-wrap: wrap");
  });

  it("styles its buttons as the panel's own, from the theme, so they follow dark mode", () => {
    const { panel } = open(COPIED, {
      monitoringInfo: { monitoring_enabled: true, has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 },
      monitoringGlobals: { continuous_threshold_pct: 80, spike_threshold_pct: 100 },
    });
    const buttons = [reset(panel)!, panel.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-threshold-reset"]')!];
    expect(buttons.map(b => b.classList.contains("text-btn"))).toEqual([true, true]);
    const style = rule(panel, ".text-btn");
    expect(style).toContain("var(--primary-text-color");
    expect(style).toContain("var(--divider-color");
    expect(style).toContain("background: none");
  });
});

describe("a circuit across two spaces", () => {
  /** A 20-30 package across spaces 18 and 20, before and after its copy is entered. */
  const WASHER = [{ uuid: "c-1", circuit: circuit("Washer", 20, null, [18, 20]) }];
  const KEPT = [{ uuid: "c-1", circuit: circuit("Washer", 20, [20, 30], [18, 20]) }];
  const ABOVE = {
    monitoringInfo: { monitoring_enabled: true, has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 },
    monitoringGlobals: { continuous_threshold_pct: 80, spike_threshold_pct: 100 },
  };

  it("takes a copy in the same field, with the two-space guidance", () => {
    const { panel } = open(WASHER);
    expect(editor(panel)!.dataset.kind).toBe("two_spaces");
    expect(editor(panel)!.querySelector(".section-label")!.textContent).toBe("Breaker ratings from the SPAN app");
    expect(panelRating(panel)).toBe("Panel publishes 20 A");
    expect(row(panel)!.querySelectorAll("input")).toHaveLength(1);
    expect(input(panel).value).toBe("");
    expect(input(panel).getAttribute("aria-label")).toBe("Other breaker in the space of Washer");
    expect(guidance(panel)).toBe(TWO_SPACES_GUIDANCE);
  });

  it("sends the package in the SPAN app's order, the panel's rating first, when Enter is pressed", () => {
    const { panel, callWS } = open(WASHER);
    type(input(panel), "30");
    expect(callWS.mock.calls.map(c => c[0])).toEqual([
      {
        type: "call_service",
        domain: "span_panel",
        service: "set_circuit_package_ratings",
        service_data: { circuit_id: "c-1", package_ratings_a: [20, 30], config_entry_id: "entry-1" },
      },
    ]);
  });

  it("shows the copy kept, with its reset, and warns of the averaged legs with a button to turn monitoring off", () => {
    const { panel } = open(KEPT);
    expect(input(panel).value).toBe("30");
    expect(reset(panel)).not.toBeNull();
    expect(averagedLegs(panel)!.getAttribute("role")).toBe("note");
    expect(averagedLegs(panel)!.textContent).toContain(AVERAGED_LEGS_TEXT);
    expect(turnOff(panel)!.textContent).toBe("Turn off monitoring");
    expect(turnOff(panel)!.classList.contains("text-btn")).toBe(true);
    expect(turnOff(panel)!.getAttribute("type")).toBe("button");
    expect(panel.shadowRoot!.querySelector('[data-role="rating-warning-region"]')!.contains(averagedLegs(panel))).toBe(true);
  });

  it("warns of the averaged legs once the copy entered is kept, the field keeping focus", () => {
    const { panel } = open(WASHER);
    type(input(panel), "30");
    const field = input(panel);

    (panel as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: KEPT,
      capacityA: null,
      monitoringInfo: { monitoring_enabled: true },
      monitoringGlobals: null,
    });

    expect(input(panel)).toBe(field);
    expect(active(panel)).toBe(field);
    expect(averagedLegs(panel)).not.toBeNull();
  });

  it("does not warn of the averaged legs before a copy is entered, or for a copy in one space", () => {
    expect(averagedLegs(open(WASHER).panel)).toBeNull();
    expect(averagedLegs(open(COPIED).panel)).toBeNull();
  });

  it("does not warn of thresholds above 100% for a copy on averaged legs, which changes no threshold's meaning", () => {
    const { panel } = open(KEPT, ABOVE);
    expect(thresholdWarningOf(panel)).toBeNull();
    expect(averagedLegs(panel)).not.toBeNull();
  });

  it("does not warn of thresholds above 100% for a two-space copy waiting on a value, which never applies", () => {
    const waiting = [{ uuid: "c-1", circuit: circuit("Washer", 20, [20, 30], [18, 20], false) }];
    expect(waiting[0]!.circuit.package_ratings_state).toBe("pending");
    expect(thresholdWarningOf(open(waiting, ABOVE).panel)).toBeNull();
  });

  it("warns of thresholds above 100% for a copy that applies, in one space", () => {
    expect(thresholdWarningOf(open(COPIED, ABOVE).panel)).not.toBeNull();
  });

  it("is not offered where the integration offers no package ratings", () => {
    expect(editor(open(WASHER, { monitoringRatingOffered: false }).panel)).toBeNull();
  });
});

describe("turning monitoring off from the averaged-legs warning", () => {
  const KEPT = [{ uuid: "c-1", circuit: circuit("Washer", 20, [20, 30], [18, 20]) }];
  const POWER = { entities: { power: "sensor.washer_power" } };
  const details = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>('[data-role="monitoring-details"]')!;

  /** The panel open on the Washer, its service calls held until `answer` settles them. */
  function held(): Opened & { answer(error?: unknown): void } {
    let settle: (error?: unknown) => void = () => {};
    const opened = open(
      KEPT,
      POWER,
      () =>
        new Promise<undefined>((resolve, reject) => {
          settle = error => (error === undefined ? resolve(undefined) : reject(error));
        })
    );
    return { ...opened, answer: error => settle(error) };
  }

  it("sends the Monitoring switch's own call, the button busy, not disabled, while it is in flight", () => {
    const { panel, callWS } = held();
    turnOff(panel)!.focus();
    turnOff(panel)!.click();

    expect(callWS.mock.calls.map(c => c[0])).toEqual([
      {
        type: "call_service",
        domain: "span_panel",
        service: "set_circuit_threshold",
        service_data: { circuit_id: "sensor.washer_power", monitoring_enabled: false, config_entry_id: "entry-1" },
      },
    ]);
    expect(turnOff(panel)!.getAttribute("aria-disabled")).toBe("true");
    expect((turnOff(panel) as HTMLButtonElement).disabled).toBe(false);
    expect(active(panel)).toBe(turnOff(panel));
    turnOff(panel)!.click();
    expect(callWS).toHaveBeenCalledTimes(1);
  });

  it("is the very call the Monitoring switch sends", () => {
    const bySwitch = open(KEPT, POWER);
    turnMonitoring(bySwitch.panel, false);
    const byButton = open(KEPT, POWER);
    turnOff(byButton.panel)!.click();
    expect(byButton.callWS.mock.calls).toEqual(bySwitch.callWS.mock.calls);
  });

  it("once it succeeds, shows monitoring off: the switch off, the details hidden, the warning gone, focus on the switch", async () => {
    const { panel, answer } = held();
    turnOff(panel)!.focus();
    turnOff(panel)!.click();

    answer();
    await vi.advanceTimersByTimeAsync(0);

    expect(toggle(panel).hasAttribute("checked")).toBe(false);
    expect(details(panel).style.display).toBe("none");
    expect(shown(panel)).toBe(false);
    expect(averagedLegs(panel)).toBeNull();
    expect(active(panel)).toBe(toggle(panel));
    expect(input(panel).value).toBe("30");
  });

  it("warns again, its button ready, when monitoring is turned back on", async () => {
    const { panel, answer } = held();
    turnOff(panel)!.click();
    answer();
    await vi.advanceTimersByTimeAsync(0);

    turnMonitoring(panel, true);

    expect(shown(panel)).toBe(true);
    expect(toggle(panel).hasAttribute("checked")).toBe(true);
    expect(averagedLegs(panel)).not.toBeNull();
    expect(turnOff(panel)!.hasAttribute("aria-disabled")).toBe(false);
  });

  it("goes as monitoring is turned off with the switch, and returns as it is turned on", () => {
    const { panel } = open(KEPT);
    turnMonitoring(panel, false);
    expect(averagedLegs(panel)).toBeNull();
    turnMonitoring(panel, true);
    expect(averagedLegs(panel)).not.toBeNull();
  });

  it("keeps monitoring on and the warning, its button ready again, when the call fails", async () => {
    const { panel, errors, answer } = held();
    turnOff(panel)!.focus();
    turnOff(panel)!.click();

    answer({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.active.map(e => e.message)).toEqual(["Unable to save threshold"]);
    expect(toggle(panel).hasAttribute("checked")).toBe(true);
    expect(shown(panel)).toBe(true);
    expect(averagedLegs(panel)).not.toBeNull();
    expect(turnOff(panel)!.hasAttribute("aria-disabled")).toBe(false);
    expect(active(panel)).toBe(turnOff(panel));
  });

  it("leaves the circuit the panel moved to alone when the call answers", async () => {
    const { panel, answer } = held();
    turnOff(panel)!.click();
    panel.open({
      uuid: "c-2",
      name: "Dryer",
      entities: {},
      showMonitoring: true,
      monitoringRatingOffered: true,
      monitoringInfo: { monitoring_enabled: true },
      graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
      members: [{ uuid: "c-2", circuit: circuit("Dryer", 30, [30, 30], [2, 4]) }],
      capacityA: null,
      configEntryId: "entry-1",
    });

    answer();
    await vi.advanceTimersByTimeAsync(0);

    expect(toggle(panel).hasAttribute("checked")).toBe(true);
    expect(shown(panel)).toBe(true);
    expect(averagedLegs(panel)).not.toBeNull();
  });
});

describe("choosing Global and removing the copy", () => {
  it("choosing Global calls only clear_circuit_threshold and leaves the copy shown", () => {
    const { panel, callWS } = open(COPIED, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    const global = panel.shadowRoot!.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="global"]')!;
    global.checked = true;
    global.dispatchEvent(new Event("change"));
    expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(["clear_circuit_threshold"]);
    expect(shown(panel)).toBe(true);
    expect(input(panel).value).toBe("30");
    expect(reset(panel)).not.toBeNull();
  });

  it("the copy's own reset calls only clear_circuit_package_ratings, leaving thresholds alone", () => {
    const { panel, callWS } = open(COPIED, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    reset(panel)!.click();
    expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(["clear_circuit_package_ratings"]);
  });
});

describe("the other breaker's input", () => {
  it("sends the package in the SPAN app's order, the panel's rating first, when Enter is pressed", () => {
    const { panel, callWS } = open(OVEN);
    typeOnly(input(panel), "30");
    vi.advanceTimersByTime(5000);
    expect(callWS).not.toHaveBeenCalled();

    input(panel).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "span_panel",
      service: "set_circuit_package_ratings",
      service_data: { circuit_id: "c-1", package_ratings_a: [20, 30], config_entry_id: "entry-1" },
    });
  });

  it("sends it when the field is left, and once only when Enter came first", async () => {
    const { panel, callWS } = open(OVEN);
    typeOnly(input(panel), "30");
    input(panel).blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(callWS).toHaveBeenCalledTimes(1);

    type(input(panel), "25");
    input(panel).blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(callWS.mock.calls.map(c => (c[0] as { service_data: { package_ratings_a: number[] } }).service_data.package_ratings_a)).toEqual([
      [20, 30],
      [20, 25],
    ]);
  });

  it("stores nothing while the user types slowly, steps or pauses: only the value committed", () => {
    const { panel, callWS } = open(OVEN);
    typeOnly(input(panel), "3");
    vi.advanceTimersByTime(2000);
    typeOnly(input(panel), "30");
    vi.advanceTimersByTime(2000);
    expect(callWS).not.toHaveBeenCalled();

    type(input(panel), "30");

    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service_data: { package_ratings_a: [20, 30] } });
  });

  it("sends nothing for the copy already in force", () => {
    const { panel, callWS } = open(COPIED);
    type(input(panel), "30");
    input(panel).blur();
    expect(callWS).not.toHaveBeenCalled();
  });

  it.each(["12.6", "0", "-5", "0.5", "1e30"])("sends nothing for %j and says what to enter", value => {
    const { panel, callWS } = open(OVEN);
    type(input(panel), value);
    expect(callWS).not.toHaveBeenCalled();
    expect(feedback(panel)).toBe("Enter the other breaker's rating as a whole number of amps, 1 or more.");
    expect(input(panel).getAttribute("aria-invalid")).toBe("true");
  });

  it("says what to enter for text a browser holds back from a number field as bad input", () => {
    const { panel, callWS } = open(COPIED);
    typeOnly(input(panel), "");
    Object.defineProperty(input(panel), "validity", { value: { badInput: true } });
    input(panel).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(callWS).not.toHaveBeenCalled();
    expect(feedback(panel)).toBe("Enter the other breaker's rating as a whole number of amps, 1 or more.");
  });

  it("clears what it said once the user types again, and sends a corrected value", () => {
    const { panel, callWS } = open(OVEN);
    type(input(panel), "12.6");
    typeOnly(input(panel), "13");
    expect(feedback(panel)).toBe("");
    expect(input(panel).hasAttribute("aria-invalid")).toBe(false);
    input(panel).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service_data: { package_ratings_a: [20, 13] } });
  });

  it("puts the copy in force back when the field is left empty, sending nothing", async () => {
    const { panel, callWS } = open(COPIED);
    typeOnly(input(panel), "");
    input(panel).blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(callWS).not.toHaveBeenCalled();
    expect(input(panel).value).toBe("30");
  });

  it("keeps the wheel from stepping the focused field", () => {
    const { panel } = open(OVEN);
    input(panel).focus();
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    input(panel).dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("leaves the wheel alone over a field that is not focused, so the page scrolls", () => {
    const { panel } = open(OVEN);
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    input(panel).dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });

  it("keeps the wheel from stepping a focused threshold field too", () => {
    const { panel } = open(OVEN, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    const threshold = panel.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;
    threshold.focus();
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    threshold.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });

  it("leaves max unset, since the topology carries no service rating", () => {
    const el = input(open(OVEN).panel);
    expect(el.min).toBe("1");
    expect(el.step).toBe("1");
    expect(el.hasAttribute("max")).toBe(false);
  });

  it("does not show the typed value as the copy in force", () => {
    const { panel } = open(COPIED, {
      monitoringInfo: {
        monitoring_enabled: true,
        breaker_rating_a: 20,
        monitoring_rating_a: 50,
        monitoring_rating_user_set: true,
        package_ratings_a: [20, 30],
      },
    });
    const judged = panel.shadowRoot!.querySelector('[data-role="judged-against"]')!;
    const before = judged.textContent;
    type(input(panel), "25");
    expect(judged.textContent).toBe(before);
    expect(panelRating(panel)).toBe("Panel publishes 20 A");
  });
});

describe("the threshold and duration fields", () => {
  const CUSTOM = {
    monitoringInfo: {
      monitoring_enabled: true,
      has_override: true,
      continuous_threshold_pct: 80,
      spike_threshold_pct: 100,
      window_duration_m: 15,
      cooldown_duration_m: 15,
    },
  };
  const field = (p: SidePanel, key: string): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>(`[data-role="threshold-${key}"]`)!;
  const said = (p: SidePanel, key: string): string | null | undefined => p.shadowRoot!.querySelector(`[data-role="threshold-feedback-${key}"]`)?.textContent;
  const sent = (callWS: ReturnType<typeof vi.fn<CallWS>>): unknown[] => callWS.mock.calls.map(c => (c[0] as { service_data: unknown }).service_data);

  it("send only on Enter or leaving the field, and only the field the user changed", () => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    typeOnly(field(panel, "continuous"), "160");
    vi.advanceTimersByTime(5000);
    expect(callWS).not.toHaveBeenCalled();

    field(panel, "continuous").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    field(panel, "continuous").blur();

    expect(sent(callWS)).toEqual([{ circuit_id: "c-1", continuous_threshold_pct: 160, config_entry_id: "entry-1" }]);
  });

  it("send nothing on leaving a field nobody touched", () => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    field(panel, "spike").focus();
    field(panel, "spike").blur();
    expect(callWS).not.toHaveBeenCalled();
  });

  it.each([
    ["continuous", "", "Enter a whole number from 1 to 200."],
    ["continuous", "0", "Enter a whole number from 1 to 200."],
    ["spike", "201", "Enter a whole number from 1 to 200."],
    ["spike", "12.5", "Enter a whole number from 1 to 200."],
    ["window-m", "181", "Enter a whole number from 1 to 180."],
    ["cooldown-m", "", "Enter a whole number from 1 to 180."],
  ])("send nothing for %s set to %j, saying what to enter", (key, value, message) => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    type(field(panel, key), value);
    expect(callWS).not.toHaveBeenCalled();
    expect(said(panel, key)).toBe(message);
    expect(field(panel, key).getAttribute("aria-invalid")).toBe("true");
    expect(field(panel, key).getAttribute("aria-describedby")).toBe(`threshold-feedback-${key}`);
  });

  it("send a duration the user changed, under its own field's name", () => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    type(field(panel, "cooldown-m"), "30");
    expect(sent(callWS)).toEqual([{ circuit_id: "c-1", cooldown_duration_m: 30, config_entry_id: "entry-1" }]);
  });

  it("clear what they said once the user types again", () => {
    const { panel } = open(OVEN, CUSTOM);
    type(field(panel, "window-m"), "0");
    typeOnly(field(panel, "window-m"), "20");
    expect(said(panel, "window-m")).toBe("");
    expect(field(panel, "window-m").hasAttribute("aria-invalid")).toBe(false);
  });

  it.each([
    ["continuous", "Continuous %"],
    ["spike", "Spike %"],
    ["window-m", "Window duration"],
    ["cooldown-m", "Cooldown"],
  ])("name the %s field by the label shown beside it", (key, name) => {
    const { panel } = open(OVEN, CUSTOM);
    const id = field(panel, key).getAttribute("aria-labelledby")!;

    expect(panel.shadowRoot!.getElementById(id)!.textContent).toBe(name);
  });

  it.each(["window-m", "cooldown-m"])("keep the wheel from stepping the focused %s field", key => {
    const { panel } = open(OVEN, CUSTOM);
    field(panel, key).focus();
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    field(panel, key).dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
  });
});

describe("a refresh while the user is in the editor", () => {
  const refresh = (p: SidePanel, copied: number[] | null, panelAmps = 20): void =>
    (p as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: [{ uuid: "c-1", circuit: circuit("Oven", panelAmps, copied) }],
      capacityA: null,
      monitoringInfo: { monitoring_enabled: true },
    });

  it("updates a focused field the user has not touched, and leaving it sends nothing", () => {
    // Another browser, or a reconcile, changed the copy while the field had focus.
    const { panel, callWS } = open(COPIED);
    input(panel).focus();

    refresh(panel, [20, 35]);
    expect(input(panel).value).toBe("35");
    input(panel).blur();

    expect(callWS).not.toHaveBeenCalled();
  });

  it("sends nothing on leaving an untouched field whose copy a reconcile removed", () => {
    // The panel's rating changed, so the copy went: [30, 30] is a package nobody entered.
    const { panel, callWS } = open(COPIED);
    input(panel).focus();

    refresh(panel, null, 30);
    input(panel).blur();

    expect(input(panel).value).toBe("");
    expect(callWS).not.toHaveBeenCalled();
  });

  it("keeps a value showing why it needs correcting across a refresh", () => {
    const { panel } = open(COPIED);
    type(input(panel), "12.6");
    input(panel).blur();

    refresh(panel, [20, 35]);

    expect(input(panel).value).toBe("12.6");
    expect(feedback(panel)).toBe("Enter the other breaker's rating as a whole number of amps, 1 or more.");
  });

  it("sends a value entered again after a change elsewhere put another copy in force", () => {
    const { panel, callWS } = open(OVEN);
    type(input(panel), "30");
    input(panel).blur();
    refresh(panel, [20, 25]);

    type(input(panel), "30");

    expect(callWS.mock.calls.map(c => (c[0] as { service_data: { package_ratings_a: number[] } }).service_data.package_ratings_a)).toEqual([
      [20, 30],
      [20, 30],
    ]);
  });

  it("never replaces what is being typed in the focused field", () => {
    const { panel } = open(COPIED);
    typeOnly(input(panel), "4");
    const field = input(panel);

    refresh(panel, [20, 35]);

    expect(input(panel)).toBe(field);
    expect(field.value).toBe("4");
    expect(active(panel)).toBe(field);
  });

  it("shows the copy in force in a field that is not focused", () => {
    const { panel } = open(COPIED);
    refresh(panel, [20, 35]);
    expect(input(panel).value).toBe("35");
  });

  it("keeps the focused field's focus after a save, the editor patched in place", () => {
    const { panel } = open(OVEN);
    type(input(panel), "30");
    const field = input(panel);

    refresh(panel, [20, 30]);

    expect(input(panel)).toBe(field);
    expect(active(panel)).toBe(field);
    expect(reset(panel)).not.toBeNull();
  });

  it("moves focus from a reset that goes to the field", () => {
    const { panel } = open(COPIED);
    reset(panel)!.focus();
    reset(panel)!.click();

    refresh(panel, null);

    expect(reset(panel)).toBeNull();
    expect(active(panel)).toBe(input(panel));
  });

  it("keeps focus on the equivalent control when the editor is drawn afresh for another form", () => {
    const { panel } = open(OVEN);
    const before = input(panel);
    before.focus();

    // A second space arriving makes the circuit a two-space one: the editor is drawn afresh in that form.
    (panel as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: [{ uuid: "c-1", circuit: circuit("Oven", 20, null, [1, 3]) }],
      capacityA: null,
      monitoringInfo: { monitoring_enabled: true },
    });

    expect(editor(panel)!.dataset.kind).toBe("two_spaces");
    expect(guidance(panel)).toBe(TWO_SPACES_GUIDANCE);
    expect(input(panel)).not.toBe(before);
    expect(active(panel)).toBe(input(panel));
  });

  it("moves focus past the editor when the integration stops offering the circuit a form", () => {
    const { panel } = open(OVEN);
    input(panel).focus();

    (panel as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: [{ uuid: "c-1", circuit: { ...circuit("Oven", 20), package_ratings_form: null } }],
      capacityA: null,
      monitoringInfo: { monitoring_enabled: true },
    });

    expect(editor(panel)).toBeNull();
    expect((active(panel) as HTMLInputElement | null)?.name).toBe("monitoring-mode");
  });
});

describe("the reset", () => {
  it("clears a value that needs correcting, and what was said of it, from the field", () => {
    const { panel } = open(COPIED);
    type(input(panel), "12.6");
    reset(panel)!.click();
    expect(feedback(panel)).toBe("");
    expect(input(panel).hasAttribute("aria-invalid")).toBe(false);
    expect(input(panel).value).toBe("30");
  });

  it("is shown only where a package is stored", () => {
    expect(reset(open(OVEN).panel)).toBeNull();
    expect(reset(open(COPIED).panel)).not.toBeNull();
  });

  it("is shown for a copy waiting on a value not yet arrived, which is still stored", () => {
    expect(reset(open([{ uuid: "c-1", circuit: circuit("Oven", 20, [20, 30], [1], false) }]).panel)).not.toBeNull();
  });

  it("clears the copy of its own circuit, sending nothing typed but not committed", () => {
    const { panel, callWS } = open(COPIED);
    typeOnly(input(panel), "25");
    reset(panel)!.click();
    expect(callWS.mock.calls.map(c => c[0])).toEqual([
      {
        type: "call_service",
        domain: "span_panel",
        service: "clear_circuit_package_ratings",
        service_data: { circuit_id: "c-1", config_entry_id: "entry-1" },
      },
    ]);
  });
});

describe("a refused change", () => {
  /** A refusal as Home Assistant's websocket hands it over: the message in the server's language, prefixed, and its translation key. */
  const REFUSAL = {
    code: "service_validation_error",
    message: "Validation error: The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A.",
    translation_domain: "span_panel",
    translation_key: "package_ratings_above_service_rating",
    translation_placeholders: { service_rating: "40" },
  };

  it("shows the refusal in the user's language, from the integration's exception translations", async () => {
    const loads: unknown[][] = [];
    const { panel, errors } = open(OVEN, {}, async () => {
      throw REFUSAL;
    });
    panel.hass = {
      ...panel.hass,
      loadBackendTranslation: async (...args: unknown[]) => {
        loads.push(args);
        return (key: string, values?: Record<string, string | number>) =>
          key === "component.span_panel.exceptions.package_ratings_above_service_rating.message"
            ? `Les calibres copiés dépassent le calibre de service du panneau, soit ${String(values?.service_rating)} A.`
            : "";
      },
    } as HomeAssistant;
    type(input(panel), "30");
    await vi.advanceTimersByTimeAsync(0);
    expect(loads).toEqual([["exceptions", "span_panel"]]);
    expect(errors.active.map(e => e.message)).toEqual(["Les calibres copiés dépassent le calibre de service du panneau, soit 40 A."]);
  });

  it("shows the service's message without Home Assistant's prefix where no translation is to be had", async () => {
    const { panel, errors } = open(OVEN, {}, async () => {
      throw REFUSAL;
    });
    type(input(panel), "30");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A."]);
  });

  it("shows the service's message where the translation has no such key", async () => {
    const { panel, errors } = open(OVEN, {}, async () => {
      throw REFUSAL;
    });
    panel.hass = { ...panel.hass, loadBackendTranslation: async () => () => "" } as HomeAssistant;
    type(input(panel), "30");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A."]);
  });

  it("falls back to the generic message when the error carries none", async () => {
    const { panel, errors } = open(OVEN, {}, async () => {
      throw new Error("");
    });
    type(input(panel), "30");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["Unable to update the ratings copied from the SPAN app"]);
  });

  it("puts the copy in force back in the field, focused so it can be corrected", async () => {
    const { panel, errors } = open(COPIED, {}, async () => {
      throw { code: "service_validation_error", message: "refused" };
    });
    type(input(panel), "90");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active).toHaveLength(1);
    expect(input(panel).value).toBe("30");
    expect(active(panel)).toBe(input(panel));
  });

  it("restores from the copy in force when the refusal lands, not when the value was typed", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel } = open(OVEN, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(panel), "90");
    input(panel).blur();
    (panel as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: [{ uuid: "c-1", circuit: circuit("Oven", 20, [20, 15]) }],
      capacityA: null,
      monitoringInfo: null,
    });
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(input(panel).value).toBe("15");
    expect(reset(panel)).not.toBeNull();
  });

  it("leaves a value typed while the refused one was in flight", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel, callWS } = open(OVEN, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(panel), "90");
    const el = input(panel);
    typeOnly(el, "30");
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(input(panel)).toBe(el);
    expect(el.value).toBe("30");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(callWS.mock.calls.map(c => (c[0] as { service_data: { package_ratings_a?: number[] } }).service_data.package_ratings_a)).toEqual([
      [20, 90],
      [20, 30],
    ]);
  });

  it("gives the field focus back where focus was lost when the refusal lands", async () => {
    const { panel } = open(COPIED, {}, async () => {
      throw { message: "refused" };
    });
    typeOnly(input(panel), "90");
    input(panel).blur();
    expect(document.activeElement).toBe(document.body);
    await vi.advanceTimersByTimeAsync(0);
    expect(active(panel)).toBe(input(panel));
    expect(input(panel).value).toBe("30");
  });

  it("leaves another circuit's field alone when a refusal lands after the panel moved to it", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel } = open(OVEN, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(panel), "90");
    panel.open({
      uuid: "c-2",
      name: "Dryer",
      entities: {},
      showMonitoring: true,
      monitoringRatingOffered: true,
      monitoringInfo: { monitoring_enabled: true },
      graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
      members: [{ uuid: "c-2", circuit: circuit("Dryer", 30) }],
      capacityA: null,
      configEntryId: "entry-1",
    });
    typeOnly(input(panel), "90");
    const other = input(panel);

    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);

    expect(input(panel)).toBe(other);
    expect(other.value).toBe("90");
  });

  it("does nothing to a panel closed while the call was in flight", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel } = open(OVEN, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(panel), "30");
    (panel as unknown as { close(): void }).close();
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.hasAttribute("open")).toBe(false);
  });

  it("reports a failed reset the same way, focus staying on it", async () => {
    const { panel, errors } = open(COPIED, {}, async () => {
      throw { message: "no such circuit" };
    });
    reset(panel)!.focus();
    reset(panel)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["no such circuit"]);
    expect(active(panel)).toBe(reset(panel));
  });
});

describe("thresholds above 100% under a copy", () => {
  const GLOBALS = { continuous_threshold_pct: 80, spike_threshold_pct: 100 };
  const ABOVE = { monitoring_enabled: true, has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 };
  const OWN = { monitoringInfo: ABOVE, monitoringGlobals: GLOBALS };
  const OWN_TEXT =
    "This circuit's custom thresholds are above 100%. With the copied ratings they now apply to both breakers together, which can let a real overload pass.";
  const GLOBAL_TEXT =
    "The global thresholds this circuit uses are above 100%. With the copied ratings they now apply to both breakers together, which can let a real " +
    "overload pass; change them under Global Settings on the Monitoring tab.";
  const warning = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-threshold-warning"]');
  const useGlobal = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-threshold-reset"]');
  const choose = (p: SidePanel, mode: "global" | "custom"): void => {
    const radio = p.shadowRoot!.querySelector<HTMLInputElement>(`input[name="monitoring-mode"][value="${mode}"]`)!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
  };

  it("are warned of only while the circuit is monitored, the warning going with the details and back with them", () => {
    // Monitoring off is itself an override, which the warning's reset to the global thresholds would clear.
    const { panel } = open(COPIED, OWN);
    turnMonitoring(panel, false);
    expect(warning(panel)).toBeNull();
    expect(shown(panel)).toBe(false);

    turnMonitoring(panel, true);
    expect(shown(panel)).toBe(true);
    expect(warning(panel)!.textContent).toContain(OWN_TEXT);
    expect(useGlobal(panel)!.hasAttribute("aria-disabled")).toBe(false);
  });

  it("are the circuit's own where they differ from the global ones: warned of, with a reset to the global thresholds", () => {
    const { panel } = open(COPIED, OWN);
    expect(warning(panel)!.getAttribute("role")).toBe("note");
    expect(warning(panel)!.textContent).toContain(OWN_TEXT);
    expect(useGlobal(panel)!.textContent).toBe("Use global thresholds");
    expect(editor(panel)!.contains(warning(panel))).toBe(true);
  });

  it.each([
    ["the continuous threshold alone", { continuous_threshold_pct: 160, spike_threshold_pct: 100 }],
    ["the spike threshold alone", { continuous_threshold_pct: 80, spike_threshold_pct: 200 }],
  ])("are warned of for %s", (_label, thresholds) => {
    const shown = open(COPIED, { monitoringInfo: { monitoring_enabled: true, has_override: true, ...thresholds }, monitoringGlobals: GLOBALS });
    expect(useGlobal(shown.panel)).not.toBeNull();
  });

  it("are the global ones where they equal them: warned of, pointing to the global settings, with no reset", () => {
    const { panel } = open(COPIED, {
      monitoringInfo: { ...ABOVE, has_override: false },
      monitoringGlobals: { continuous_threshold_pct: 160, spike_threshold_pct: 200 },
    });
    expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
    expect(useGlobal(panel)).toBeNull();
  });

  it("are the circuit's own wherever it has an override, its values the global ones included, the reset offered", () => {
    // Beside a checked Custom choice; a reset that changes no value then turns the warning into the pointer.
    const { panel } = open(COPIED, { monitoringInfo: ABOVE, monitoringGlobals: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } });
    expect(warning(panel)!.textContent).toContain(OWN_TEXT);
    expect(useGlobal(panel)).not.toBeNull();
    expect(panel.shadowRoot!.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="custom"]')!.checked).toBe(true);
  });

  it("are the circuit's own, where the global ones are not known, only while it has an override", () => {
    expect(useGlobal(open(COPIED, { monitoringInfo: ABOVE, monitoringGlobals: null }).panel)).not.toBeNull();
    const global = open(COPIED, { monitoringInfo: { ...ABOVE, has_override: false }, monitoringGlobals: null });
    expect(warning(global.panel)!.textContent).toBe(GLOBAL_TEXT);
  });

  it("are warned of for a copy waiting on a value not yet arrived, which applies once it does", () => {
    const waiting = [{ uuid: "c-1", circuit: circuit("Oven", 20, [20, 30], [1], false) }];
    expect(warning(open(waiting, OWN).panel)).not.toBeNull();
  });

  it("are not warned of with no copy, where they are the circuit's own business", () => {
    expect(warning(open(OVEN, OWN).panel)).toBeNull();
  });

  it("are not warned of at 100% or below", () => {
    const within = { monitoring_enabled: true, has_override: true, continuous_threshold_pct: 80, spike_threshold_pct: 100 };
    expect(warning(open(COPIED, { monitoringInfo: within, monitoringGlobals: GLOBALS }).panel)).toBeNull();
  });

  it("go when Global is chosen and the global thresholds are within 100%", async () => {
    const { panel } = open(COPIED, OWN);
    choose(panel, "global");
    await vi.advanceTimersByTimeAsync(0);
    expect(warning(panel)).toBeNull();
  });

  it("turn into the pointer to the global settings when Global is chosen and those are above 100%", async () => {
    const { panel } = open(COPIED, { monitoringInfo: ABOVE, monitoringGlobals: { continuous_threshold_pct: 150, spike_threshold_pct: 200 } });
    choose(panel, "global");
    await vi.advanceTimersByTimeAsync(0);
    expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
    expect(useGlobal(panel)).toBeNull();
  });

  it("appear as soon as a custom threshold saved goes above 100%, and go as soon as one comes back", async () => {
    const { panel } = open(COPIED, { monitoringInfo: { monitoring_enabled: true, has_override: true, ...GLOBALS }, monitoringGlobals: GLOBALS });
    const continuous = panel.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;
    expect(warning(panel)).toBeNull();

    type(continuous, "160");
    await vi.advanceTimersByTimeAsync(0);
    expect(useGlobal(panel)).not.toBeNull();

    type(continuous, "90");
    await vi.advanceTimersByTimeAsync(0);
    expect(warning(panel)).toBeNull();
  });

  describe("after a custom threshold is saved, as the integration then reports them", () => {
    // The global thresholds are above 100%; the circuit's own continuous threshold differs from theirs.
    const ABOVE_GLOBALS = { continuous_threshold_pct: 160, spike_threshold_pct: 200, window_duration_m: 15, cooldown_duration_m: 15 };
    const SENSOR = "sensor.oven_current";
    const opening = {
      entities: { current: SENSOR },
      monitoringInfo: { monitoring_enabled: true, has_override: true, ...ABOVE_GLOBALS, continuous_threshold_pct: 170 },
      monitoringGlobals: ABOVE_GLOBALS,
    };
    /** The integration's answer to a status read, with the circuit's entry `point`. */
    const status = (point: Record<string, unknown>): unknown => ({
      response: { enabled: true, global_settings: ABOVE_GLOBALS, circuits: { [SENSOR]: point }, mains: {} },
    });
    const continuous = (p: SidePanel): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;

    it("point to the global settings where the integration dropped an override that matches them", async () => {
      const { panel, callWS } = open(COPIED, opening, async message =>
        message.service === "get_monitoring_status" ? status({ monitoring_enabled: true, has_override: false, ...ABOVE_GLOBALS }) : undefined
      );

      type(continuous(panel), "160");
      await vi.advanceTimersByTimeAsync(0);

      expect(callWS.mock.calls.map(c => (c[0] as { service: string; service_data: unknown }).service)).toEqual([
        "set_circuit_threshold",
        "get_monitoring_status",
      ]);
      expect((callWS.mock.calls[1]![0] as { service_data: unknown; return_response: unknown }).service_data).toEqual({ config_entry_id: "entry-1" });
      expect((callWS.mock.calls[1]![0] as { return_response: unknown }).return_response).toBe(true);
      expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
      expect(useGlobal(panel)).toBeNull();
    });

    it("are the circuit's own, with the reset, where the integration kept the override", async () => {
      const { panel } = open(COPIED, { ...opening, monitoringInfo: { ...opening.monitoringInfo, has_override: false } }, async message =>
        message.service === "get_monitoring_status"
          ? status({ monitoring_enabled: true, has_override: true, ...ABOVE_GLOBALS, continuous_threshold_pct: 180 })
          : undefined
      );

      type(continuous(panel), "180");
      await vi.advanceTimersByTimeAsync(0);

      expect(warning(panel)!.textContent).toContain(OWN_TEXT);
      expect(useGlobal(panel)).not.toBeNull();
    });

    const radio = (p: SidePanel, mode: "global" | "custom"): HTMLInputElement =>
      p.shadowRoot!.querySelector<HTMLInputElement>(`input[name="monitoring-mode"][value="${mode}"]`)!;
    const fields = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>('[data-role="threshold-fields"]')!;
    const spike = (p: SidePanel): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-spike"]')!;
    const dropped = async (message: Record<string, unknown>): Promise<unknown> =>
      message.service === "get_monitoring_status" ? status({ monitoring_enabled: true, has_override: false, ...ABOVE_GLOBALS }) : undefined;

    it("show Global as chosen, its fields hidden and focus on it, where the integration dropped the override", async () => {
      const { panel } = open(COPIED, opening, dropped);

      type(continuous(panel), "160");
      await vi.advanceTimersByTimeAsync(0);

      expect(radio(panel, "global").checked).toBe(true);
      expect(radio(panel, "custom").checked).toBe(false);
      expect(fields(panel).style.display).toBe("none");
      expect(active(panel)).toBe(radio(panel, "global"));
    });

    it("keep Custom and its fields where the user is typing in one when the integration drops the override", async () => {
      const { panel, callWS } = open(COPIED, opening, dropped);
      typeOnly(continuous(panel), "160");
      // Tab to Spike, which saves Continuous, and start typing before the answer.
      spike(panel).focus();
      spike(panel).value = "21";
      spike(panel).dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(0);

      expect(radio(panel, "custom").checked).toBe(true);
      expect(fields(panel).style.display).toBe("block");
      expect(active(panel)).toBe(spike(panel));
      expect(spike(panel).value).toBe("21");
      expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(["set_circuit_threshold", "get_monitoring_status"]);
    });

    it("judge only the fields drawn now, not ones half typed in before the panel was drawn again", async () => {
      const { panel } = open(COPIED, opening, dropped);
      typeOnly(continuous(panel), "15");
      // Drawn again on the same circuit: the field half typed in goes, uncommitted.
      panel.open({
        uuid: "c-1",
        name: "Oven",
        showMonitoring: true,
        monitoringRatingOffered: true,
        graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
        members: COPIED,
        capacityA: null,
        configEntryId: "entry-1",
        ...opening,
      });

      type(continuous(panel), "160");
      await vi.advanceTimersByTimeAsync(0);

      expect(radio(panel, "global").checked).toBe(true);
    });

    it("ignore a read from a save before the reset to the global thresholds, which answers after it", async () => {
      let answer: () => void = () => {};
      const { panel } = open(COPIED, opening, message =>
        message.service === "get_monitoring_status"
          ? new Promise(
              resolve => (answer = () => resolve(status({ monitoring_enabled: true, has_override: true, ...ABOVE_GLOBALS, continuous_threshold_pct: 180 })))
            )
          : Promise.resolve(undefined)
      );
      type(continuous(panel), "180");
      await vi.advanceTimersByTimeAsync(0);

      useGlobal(panel)!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
      answer();
      await vi.advanceTimersByTimeAsync(0);

      expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
      expect(useGlobal(panel)).toBeNull();
    });

    it("keep Custom where the integration kept the override", async () => {
      const { panel } = open(COPIED, opening, async message =>
        message.service === "get_monitoring_status"
          ? status({ monitoring_enabled: true, has_override: true, ...ABOVE_GLOBALS, continuous_threshold_pct: 180 })
          : undefined
      );

      type(continuous(panel), "180");
      await vi.advanceTimersByTimeAsync(0);

      expect(radio(panel, "custom").checked).toBe(true);
      expect(fields(panel).style.display).toBe("block");
    });

    it("take the global thresholds the answer came with, which a reset then applies", async () => {
      // Since the panel opened, the global thresholds were brought back within 100%.
      const within = { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 };
      const { panel } = open(COPIED, opening, async message =>
        message.service === "get_monitoring_status"
          ? {
              response: {
                enabled: true,
                global_settings: within,
                circuits: { [SENSOR]: { monitoring_enabled: true, has_override: true, ...within, continuous_threshold_pct: 180 } },
              },
            }
          : undefined
      );
      type(continuous(panel), "180");
      await vi.advanceTimersByTimeAsync(0);
      expect(useGlobal(panel)).not.toBeNull();

      useGlobal(panel)!.click();
      await vi.advanceTimersByTimeAsync(0);

      expect(warning(panel)).toBeNull();
    });

    it("take the later of two answers where the earlier answers last", async () => {
      const answers: Array<() => void> = [];
      const points = [
        { monitoring_enabled: true, has_override: true, ...ABOVE_GLOBALS, continuous_threshold_pct: 180 },
        { monitoring_enabled: true, has_override: false, ...ABOVE_GLOBALS },
      ];
      const { panel } = open(COPIED, opening, message => {
        if (message.service !== "get_monitoring_status") return Promise.resolve(undefined);
        const answer = status(points[answers.length]!);
        return new Promise(resolve => answers.push(() => resolve(answer)));
      });

      type(continuous(panel), "180");
      await vi.advanceTimersByTimeAsync(0);
      type(continuous(panel), "160");
      await vi.advanceTimersByTimeAsync(0);
      expect(answers).toHaveLength(2);
      answers[1]!();
      await vi.advanceTimersByTimeAsync(0);
      answers[0]!();
      await vi.advanceTimersByTimeAsync(0);

      expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
    });

    it("are taken as entered where the status cannot be read, as the circuit's own", async () => {
      const { panel } = open(COPIED, { ...opening, monitoringInfo: { ...opening.monitoringInfo, has_override: false } }, async message => {
        if (message.service === "get_monitoring_status") throw { message: "unavailable" };
        return undefined;
      });

      type(continuous(panel), "180");
      await vi.advanceTimersByTimeAsync(0);

      expect(warning(panel)!.textContent).toContain(OWN_TEXT);
    });

    it("leave a panel since closed alone", async () => {
      let answer: () => void = () => {};
      const { panel } = open(COPIED, opening, message =>
        message.service === "get_monitoring_status"
          ? new Promise(resolve => (answer = () => resolve(status({ monitoring_enabled: true, has_override: false, ...ABOVE_GLOBALS }))))
          : Promise.resolve(undefined)
      );
      type(continuous(panel), "160");
      await vi.advanceTimersByTimeAsync(0);
      const before = warning(panel)!.textContent;

      panel.removeAttribute("open");
      answer();
      await vi.advanceTimersByTimeAsync(0);

      expect(warning(panel)!.textContent).toBe(before);
    });
  });

  it("are kept when a custom threshold fails to save", async () => {
    const { panel } = open(COPIED, OWN, async () => {
      throw { message: "refused" };
    });
    const continuous = panel.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;
    type(continuous, "90");
    await vi.advanceTimersByTimeAsync(0);
    expect(useGlobal(panel)).not.toBeNull();
  });

  it("are reset to the global thresholds in one click, as choosing Global does, the warning going once that succeeds", async () => {
    let clear: () => void = () => {};
    const { panel, callWS } = open(COPIED, OWN, () => new Promise<undefined>(resolve => (clear = () => resolve(undefined))));
    useGlobal(panel)!.focus();
    useGlobal(panel)!.click();
    expect(callWS.mock.calls.map(c => c[0])).toEqual([
      { type: "call_service", domain: "span_panel", service: "clear_circuit_threshold", service_data: { circuit_id: "c-1", config_entry_id: "entry-1" } },
    ]);
    expect(panel.shadowRoot!.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="global"]')!.checked).toBe(true);
    expect(panel.shadowRoot!.querySelector<HTMLElement>('[data-role="threshold-fields"]')!.style.display).toBe("none");
    // In flight: the warning stays, its button marked busy, not disabled, so it keeps focus; a second click sends nothing.
    expect(warning(panel)).not.toBeNull();
    expect(useGlobal(panel)!.getAttribute("aria-disabled")).toBe("true");
    expect((useGlobal(panel) as HTMLButtonElement).disabled).toBe(false);
    expect(active(panel)).toBe(useGlobal(panel));
    useGlobal(panel)!.click();
    expect(callWS).toHaveBeenCalledTimes(1);

    clear();
    await vi.advanceTimersByTimeAsync(0);

    expect(warning(panel)).toBeNull();
    expect(input(panel).value).toBe("30");
    expect((active(panel) as HTMLInputElement | null)?.value).toBe("global");
  });

  it("are kept, with the warning, when the reset fails, the Custom choice and its fields put back", async () => {
    const { panel, errors } = open(COPIED, OWN, async () => {
      throw { message: "refused" };
    });
    useGlobal(panel)!.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.active.map(e => e.message)).toEqual(["Unable to save threshold"]);
    expect(warning(panel)).not.toBeNull();
    expect(useGlobal(panel)!.hasAttribute("aria-disabled")).toBe(false);
    expect(panel.shadowRoot!.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="custom"]')!.checked).toBe(true);
    expect(panel.shadowRoot!.querySelector<HTMLElement>('[data-role="threshold-fields"]')!.style.display).toBe("block");
  });

  it("are left as they are by the copy itself: setting the package calls no threshold service", () => {
    const { panel, callWS } = open(OVEN, OWN);
    type(input(panel), "20");
    expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(["set_circuit_package_ratings"]);
  });
});

describe("the gear", () => {
  const TOPOLOGY = {
    monitoring_rating_offered: true,
    circuits: {
      "c-a": { ...circuit("Lights", 15), shared_meter_group: "c-a" },
      "c-b": { ...circuit("Outlets", 10), shared_meter_group: "c-a" },
      "c-m": circuit("Lone", 20),
    },
  } as unknown as PanelTopology;

  type Opened = { showMonitoring?: boolean; monitoringRatingOffered?: boolean; monitoringGlobals?: unknown; members?: { uuid: string }[] };

  async function opened(
    uuid: string,
    show: boolean,
    topology: PanelTopology = TOPOLOGY,
    setUp: (ctrl: DashboardController) => void = () => {},
    callWS: CallWS = async () => undefined
  ): Promise<Opened> {
    const ctrl = new DashboardController();
    ctrl.showMonitoring = show;
    ctrl.init(topology, {} as CardConfig, hass(callWS), "entry-1");
    setUp(ctrl);
    const root = document.createElement("div");
    root.innerHTML = `<button class="gear-icon circuit-gear" data-uuid="${uuid}"></button><span-side-panel></span-side-panel>`;
    document.body.appendChild(root);
    const sp = root.querySelector("span-side-panel") as unknown as { open: (config: unknown) => void };
    const spy = vi.spyOn(sp, "open").mockImplementation(() => {});
    await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);
    root.remove();
    return spy.mock.calls[0]![0] as Opened;
  }

  it("passes on the panel's global thresholds from the monitoring status the circuit's own came from", async () => {
    const globals = { continuous_threshold_pct: 150, spike_threshold_pct: 200 };
    const cfg = await opened(
      "c-m",
      true,
      TOPOLOGY,
      () => {},
      async msg => (msg.service === "get_monitoring_status" ? { response: { enabled: true, circuits: {}, global_settings: globals } } : undefined)
    );
    expect(cfg.monitoringGlobals).toEqual(globals);
  });

  it("is not asked to show the Monitoring section, and so the editor, in the standalone card", async () => {
    expect((await opened("c-m", false)).showMonitoring).toBe(false);
  });

  it("is asked once the dashboard enables Monitoring, passing a shared slot's every member with its id", async () => {
    const cfg = await opened("c-a", true);
    expect(cfg.showMonitoring).toBe(true);
    expect(cfg.members?.map(m => m.uuid)).toEqual(["c-a", "c-b"]);
  });

  it("passes on whether the panel offers package ratings, as the integration says, and an older integration's silence as no", async () => {
    expect((await opened("c-m", true, { ...TOPOLOGY, monitoring_rating_offered: false })).monitoringRatingOffered).toBe(false);
    expect((await opened("c-m", true, { ...TOPOLOGY, monitoring_rating_offered: true })).monitoringRatingOffered).toBe(true);
    const { monitoring_rating_offered: _offered, ...older } = TOPOLOGY;
    expect((await opened("c-m", true, older as PanelTopology)).monitoringRatingOffered).toBe(false);
  });

  it("takes a favorite's flag from the favorite's own panel in the Favorites view, not the merged view's", async () => {
    // The merged topology says nothing, which reads as no; only the favorite's own panel says yes.
    const merged = { circuits: { "p-1|c-m": TOPOLOGY.circuits["c-m"]! } } as PanelTopology;
    const configure = (offered: boolean) => (ctrl: DashboardController) => {
      ctrl.setFavoriteRefs({ "p-1|c-m": { panelDeviceId: "p-1", kind: "circuit", targetId: "c-m", configEntryId: "entry-1" } });
      const own = { ...TOPOLOGY, monitoring_rating_offered: offered } as PanelTopology;
      ctrl.setFavoritesPerPanelInfo(new Map([["p-1", { panelName: "Panel", topology: own, configEntryId: "entry-1" }]]));
    };
    expect((await opened("p-1|c-m", true, merged, configure(true))).monitoringRatingOffered).toBe(true);
    expect((await opened("p-1|c-m", true, merged, configure(false))).monitoringRatingOffered).toBe(false);
  });
});

describe("a field half typed as the side panel's DOM goes, which in Chromium blurs it", () => {
  let undo: () => void = () => {};
  beforeEach(() => (undo = blurOnRemoval()));
  afterEach(() => undo());

  const CUSTOM = {
    monitoringInfo: {
      monitoring_enabled: true,
      has_override: true,
      continuous_threshold_pct: 80,
      spike_threshold_pct: 100,
      window_duration_m: 15,
      cooldown_duration_m: 15,
    },
  };
  const threshold = (p: SidePanel): HTMLInputElement => p.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;

  /** The panel, moved into a container of the dashboard's, which clears it as it draws another tab. */
  function inContainer(panel: SidePanel): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted.push(container);
    container.appendChild(panel);
    return container;
  }

  it("sends nothing for a threshold as the panel opens on another circuit", async () => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    typeOnly(threshold(panel), "15");

    panel.open({
      uuid: "c-2",
      name: "Dryer",
      entities: {},
      showMonitoring: true,
      monitoringRatingOffered: true,
      monitoringInfo: { monitoring_enabled: true },
      graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
      members: [{ uuid: "c-2", circuit: circuit("Dryer", 30) }],
      capacityA: null,
      configEntryId: "entry-1",
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(callWS).not.toHaveBeenCalled();
  });

  it("sends nothing for a threshold as the dashboard clears the panel away", async () => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    const container = inContainer(panel);
    typeOnly(threshold(panel), "15");

    container.innerHTML = "";
    await vi.advanceTimersByTimeAsync(0);

    expect(callWS).not.toHaveBeenCalled();
  });

  it("sends nothing for a copied rating as the panel is taken off the page", async () => {
    const { panel, callWS } = open(OVEN);
    typeOnly(input(panel), "3");

    panel.remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(callWS).not.toHaveBeenCalled();
  });

  it("still sends a threshold and a copied rating the user leaves", async () => {
    const { panel, callWS } = open(OVEN, CUSTOM);
    typeOnly(threshold(panel), "150");
    threshold(panel).blur();
    typeOnly(input(panel), "30");
    input(panel).blur();
    await vi.advanceTimersByTimeAsync(0);

    expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(
      expect.arrayContaining(["set_circuit_threshold", "set_circuit_package_ratings"])
    );
  });
});
