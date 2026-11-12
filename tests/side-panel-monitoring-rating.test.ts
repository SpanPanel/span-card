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

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input"));
  vi.advanceTimersByTime(600);
}

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

  it("titles the section and gives the guidance, asking nothing to be added up", () => {
    const { panel } = open(OVEN);
    expect(editor(panel)!.querySelector(".section-label")!.textContent).toBe("Breaker ratings from the SPAN app");
    expect(panel.shadowRoot!.querySelector('[data-role="rating-guidance"]')!.textContent).toBe(
      "Enter the other breaker in this space exactly as your SPAN app shows this circuit (for example 20-20A). " +
        "The panel publishes only the first; monitoring then judges this space against both breakers together."
    );
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
  it("sends the package in the SPAN app's order, the panel's rating first, the other rounded, after the debounce", () => {
    const { panel, callWS } = open(OVEN);
    const el = input(panel);
    el.value = "12.6";
    el.dispatchEvent(new Event("input"));
    expect(callWS).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "span_panel",
      service: "set_circuit_package_ratings",
      service_data: { circuit_id: "c-1", package_ratings_a: [20, 13], config_entry_id: "entry-1" },
    });
  });

  it("sends only the last of several keystrokes", () => {
    const { panel, callWS } = open(OVEN);
    const el = input(panel);
    el.value = "3";
    el.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(100);
    el.value = "30";
    el.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(600);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service_data: { package_ratings_a: [20, 30] } });
  });

  it.each(["", "abc", "0", "-5", "0.5", "0.99"])("sends nothing for %j", value => {
    const { panel, callWS } = open(OVEN);
    type(input(panel), value);
    expect(callWS).not.toHaveBeenCalled();
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

describe("the reset", () => {
  it("is shown only where a package is stored", () => {
    expect(reset(open(OVEN).panel)).toBeNull();
    expect(reset(open(COPIED).panel)).not.toBeNull();
  });

  it("is shown for a copy waiting on a value not yet arrived, which is still stored", () => {
    expect(reset(open([{ uuid: "c-1", circuit: circuit("Oven", 20, [20, 30], [1], false) }]).panel)).not.toBeNull();
  });

  it("cancels a typed value still waiting out its debounce", () => {
    const { panel, callWS } = open(COPIED);
    const el = input(panel);
    el.value = "25";
    el.dispatchEvent(new Event("input"));
    reset(panel)!.click();
    vi.advanceTimersByTime(600);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service: "clear_circuit_package_ratings" });
  });

  it("clears the copy of its own circuit", () => {
    const { panel, callWS } = open(COPIED);
    reset(panel)!.click();
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "span_panel",
      service: "clear_circuit_package_ratings",
      service_data: { circuit_id: "c-1", config_entry_id: "entry-1" },
    });
  });
});

describe("a refused change", () => {
  it("shows the service's message", async () => {
    const { panel, errors } = open(OVEN, {}, async () => {
      throw { code: "service_validation_error", message: "The ratings copied from the SPAN app add up to more than the panel's service rating of 40 A." };
    });
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

  it("puts the copy in force back in the input, beside the message", async () => {
    const { panel, errors } = open(COPIED, {}, async () => {
      throw { code: "service_validation_error", message: "refused" };
    });
    type(input(panel), "90");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active).toHaveLength(1);
    expect(input(panel).value).toBe("30");
  });

  it("restores from the copy in force when the refusal lands, not when the value was typed", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel } = open(OVEN, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(panel), "90");
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
    el.value = "30";
    el.dispatchEvent(new Event("input"));
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(input(panel)).toBe(el);
    expect(el.value).toBe("30");
    vi.advanceTimersByTime(600);
    expect(callWS.mock.calls.map(c => (c[0] as { service_data: { package_ratings_a?: number[] } }).service_data.package_ratings_a)).toEqual([
      [20, 90],
      [20, 30],
    ]);
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

  it("reports a failed reset the same way", async () => {
    const { panel, errors } = open(COPIED, {}, async () => {
      throw { message: "no such circuit" };
    });
    reset(panel)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["no such circuit"]);
  });
});

describe("custom thresholds above 100% under a copy", () => {
  const ABOVE = { monitoring_enabled: true, has_override: true, continuous_threshold_pct: 160, spike_threshold_pct: 200 };
  const warning = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-threshold-warning"]');
  const useGlobal = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-threshold-reset"]');

  it("are warned of, since they now apply to both breakers together", () => {
    const { panel } = open(COPIED, { monitoringInfo: ABOVE });
    expect(warning(panel)!.getAttribute("role")).toBe("note");
    expect(warning(panel)!.textContent).toContain(
      "This circuit's custom thresholds are above 100%. With the copied ratings they now apply to both breakers together, which can let a real overload pass."
    );
    expect(useGlobal(panel)!.textContent).toBe("Use global thresholds");
    expect(editor(panel)!.contains(warning(panel))).toBe(true);
  });

  it.each([
    ["the continuous threshold alone", { continuous_threshold_pct: 160, spike_threshold_pct: 100 }],
    ["the spike threshold alone", { continuous_threshold_pct: 80, spike_threshold_pct: 200 }],
  ])("are warned of for %s", (_label, thresholds) => {
    expect(warning(open(COPIED, { monitoringInfo: { monitoring_enabled: true, has_override: true, ...thresholds } }).panel)).not.toBeNull();
  });

  it("are warned of for a copy waiting on a value not yet arrived, which applies once it does", () => {
    const waiting = [{ uuid: "c-1", circuit: circuit("Oven", 20, [20, 30], [1], false) }];
    expect(warning(open(waiting, { monitoringInfo: ABOVE }).panel)).not.toBeNull();
  });

  it("are not warned of with no copy, where they are the circuit's own business", () => {
    expect(warning(open(OVEN, { monitoringInfo: ABOVE }).panel)).toBeNull();
  });

  it("are not warned of at 100% or below", () => {
    const within = { monitoring_enabled: true, has_override: true, continuous_threshold_pct: 80, spike_threshold_pct: 100 };
    expect(warning(open(COPIED, { monitoringInfo: within }).panel)).toBeNull();
  });

  it("are not the circuit's when they are the global ones, which the warning does not judge", () => {
    expect(warning(open(COPIED, { monitoringInfo: { ...ABOVE, has_override: false } }).panel)).toBeNull();
  });

  it("are reset to the global thresholds in one click, as choosing Global does, and the warning goes", () => {
    const { panel, callWS } = open(COPIED, { monitoringInfo: ABOVE });
    useGlobal(panel)!.click();
    expect(callWS.mock.calls.map(c => c[0])).toEqual([
      { type: "call_service", domain: "span_panel", service: "clear_circuit_threshold", service_data: { circuit_id: "c-1", config_entry_id: "entry-1" } },
    ]);
    expect(panel.shadowRoot!.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="global"]')!.checked).toBe(true);
    expect(panel.shadowRoot!.querySelector<HTMLElement>('[data-role="threshold-fields"]')!.style.display).toBe("none");
    expect(warning(panel)).toBeNull();
    expect(input(panel).value).toBe("30");
  });

  it("are left as they are by the copy itself: setting the package calls no threshold service", () => {
    const { panel, callWS } = open(OVEN, { monitoringInfo: ABOVE });
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

  type Opened = { showMonitoring?: boolean; monitoringRatingOffered?: boolean; members?: { uuid: string }[] };

  async function opened(
    uuid: string,
    show: boolean,
    topology: PanelTopology = TOPOLOGY,
    setUp: (ctrl: DashboardController) => void = () => {}
  ): Promise<Opened> {
    const ctrl = new DashboardController();
    ctrl.showMonitoring = show;
    ctrl.init(
      topology,
      {} as CardConfig,
      hass(async () => undefined),
      "entry-1"
    );
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

  it("takes a favorite's flag from the favorite's own panel in the Favorites view", async () => {
    const merged = { circuits: { "p-1|c-m": TOPOLOGY.circuits["c-m"]! } } as PanelTopology;
    const cfg = await opened("p-1|c-m", true, merged, ctrl => {
      ctrl.setFavoriteRefs({ "p-1|c-m": { panelDeviceId: "p-1", kind: "circuit", targetId: "c-m", configEntryId: "entry-1" } });
      const own = { ...TOPOLOGY, monitoring_rating_offered: false } as PanelTopology;
      ctrl.setFavoritesPerPanelInfo(new Map([["p-1", { panelName: "Panel", topology: own, configEntryId: "entry-1" }]]));
    });
    expect(cfg.monitoringRatingOffered).toBe(false);
  });
});
