import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";
import "../src/core/side-panel.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";

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

/** A circuit as the topology describes it; `copied` is the package the user copied from the SPAN app, if any. */
function circuit(name: string, panel: number | null, copied: number[] | null = null, tabs: number[] = [1], applies = copied !== null): Circuit {
  const judged = applies && copied ? copied.reduce((sum, rating) => sum + rating, 0) : panel;
  return {
    name,
    tabs,
    entities: {},
    breaker_rating_a: panel,
    monitoring_rating_a: judged,
    monitoring_rating_user_set: applies,
    package_ratings_a: copied,
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
const explanation = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-multi-space"]');

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

  it("is absent for a circuit with no panel rating, there being no first breaker to copy against", () => {
    expect(editor(open([{ uuid: "c-1", circuit: circuit("Meter", null) }]).panel)).toBeNull();
  });

  it("is absent for a circuit whose space has not arrived", () => {
    expect(editor(open([{ uuid: "c-1", circuit: circuit("Oven", 20, null, []) }]).panel)).toBeNull();
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

  it("titles the section and gives the guidance, asking nothing to be added up", () => {
    const { panel } = open(OVEN);
    expect(editor(panel)!.querySelector(".section-label")!.textContent).toBe("Breaker ratings from the SPAN app");
    expect(panel.shadowRoot!.querySelector('[data-role="rating-guidance"]')!.textContent).toBe(
      "Enter the other breaker in this space exactly as your SPAN app shows this circuit (for example 20-20A). " +
        "The panel publishes only the first; monitoring then judges this space against both breakers together."
    );
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

describe("a circuit across several spaces", () => {
  const DRYER = [{ uuid: "c-1", circuit: circuit("Dryer", 30, null, [1, 3]) }];

  it("gets an explanation in place of the editor", () => {
    const { panel } = open(DRYER);
    expect(row(panel)).toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-role="rating-input"]')).toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-role="rating-guidance"]')).toBeNull();
    expect(explanation(panel)!.getAttribute("role")).toBe("note");
    expect(explanation(panel)!.textContent).toBe(
      "This circuit spans more than one space. The panel reports the average of its legs, so one leg can carry more " +
        "than its breaker while the reading stays under the rating, and no ratings copied from the SPAN app can show it. " +
        "Turning monitoring off for this circuit is the safer choice."
    );
    expect(editor(panel)!.querySelector(".section-label")!.textContent).toBe("Breaker ratings from the SPAN app");
  });

  it("gets it whether or not the panel rates the circuit", () => {
    expect(explanation(open([{ uuid: "c-1", circuit: circuit("Dryer", null, null, [1, 3]) }]).panel)).not.toBeNull();
  });

  it("is not explained for a circuit in one space", () => {
    expect(explanation(open(OVEN).panel)).toBeNull();
  });

  it("is not explained where the integration offers no package ratings", () => {
    expect(editor(open(DRYER, { monitoringRatingOffered: false }).panel)).toBeNull();
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

  it("sends it when the field is left, and once only when Enter came first", () => {
    const { panel, callWS } = open(OVEN);
    typeOnly(input(panel), "30");
    input(panel).blur();
    expect(callWS).toHaveBeenCalledTimes(1);

    type(input(panel), "25");
    input(panel).blur();
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

  it("puts the copy in force back when the field is left empty, sending nothing", () => {
    const { panel, callWS } = open(COPIED);
    typeOnly(input(panel), "");
    input(panel).blur();
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

  it("keeps focus on the equivalent control when the editor is drawn afresh", () => {
    const { panel } = open(OVEN);
    input(panel).focus();

    // A second space arriving makes the circuit a two-space one: the editor gives way to its explanation.
    (panel as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: [{ uuid: "c-1", circuit: circuit("Oven", 20, null, [1, 3]) }],
      capacityA: null,
      monitoringInfo: { monitoring_enabled: true },
    });

    expect(panel.shadowRoot!.querySelector('[data-role="rating-input"]')).toBeNull();
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

  it("are the global ones where only the circuit's window or cooldown is its own", () => {
    const { panel } = open(COPIED, { monitoringInfo: ABOVE, monitoringGlobals: { continuous_threshold_pct: 160, spike_threshold_pct: 200 } });
    expect(warning(panel)!.textContent).toBe(GLOBAL_TEXT);
    expect(useGlobal(panel)).toBeNull();
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

    continuous.value = "160";
    continuous.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(600);
    expect(useGlobal(panel)).not.toBeNull();

    continuous.value = "90";
    continuous.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(600);
    expect(warning(panel)).toBeNull();
  });

  it("are kept when a custom threshold fails to save", async () => {
    const { panel } = open(COPIED, OWN, async () => {
      throw { message: "refused" };
    });
    const continuous = panel.shadowRoot!.querySelector<HTMLInputElement>('[data-role="threshold-continuous"]')!;
    continuous.value = "90";
    continuous.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(600);
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
