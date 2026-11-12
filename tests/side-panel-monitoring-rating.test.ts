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

function circuit(name: string, panel: number | null, monitoring: number | null, userSet = false, tabs: number[] = [1]): Circuit {
  return { name, tabs, entities: {}, breaker_rating_a: panel, monitoring_rating_a: monitoring, monitoring_rating_user_set: userSet };
}

interface Opened {
  panel: SidePanel;
  callWS: ReturnType<typeof vi.fn<CallWS>>;
  errors: ErrorStore;
}

/** Opens the circuit panel as the sidebar dashboard does: Monitoring section shown, monitoring on for the circuit. */
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
    tabs: members[0]!.circuit.tabs,
    voltage: 240,
    entities: {},
    showMonitoring: true,
    monitoringInfo: { monitoring_enabled: true },
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
    members,
    configEntryId: "entry-1",
    ...extra,
  });
  return { panel, callWS: spy, errors };
}

const rows = (p: SidePanel): HTMLElement[] => [...p.shadowRoot!.querySelectorAll<HTMLElement>('[data-role="rating-row"]')];
const input = (row: HTMLElement): HTMLInputElement => row.querySelector<HTMLInputElement>('[data-role="rating-input"]')!;
const reset = (row: HTMLElement): HTMLElement | null => row.querySelector<HTMLElement>('[data-role="rating-reset"]');

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input"));
  vi.advanceTimersByTime(600);
}

const ONE = [{ uuid: "c-1", circuit: circuit("Oven", 30, 30) }];

const details = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>('[data-role="monitoring-details"]')!;
const editor = (p: SidePanel): HTMLElement | null => p.shadowRoot!.querySelector<HTMLElement>('[data-role="rating-section"]');
const cautions = (p: SidePanel): HTMLElement[] => [...p.shadowRoot!.querySelectorAll<HTMLElement>('[data-role="rating-caution"]')];
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
    expect(rows(open(ONE, { showMonitoring: false }).panel)).toHaveLength(0);
    expect(rows(open(ONE, { showMonitoring: undefined }).panel)).toHaveLength(0);
  });

  it("is hidden while the circuit's monitoring is off, and returns with the stored value when it is turned on", () => {
    const { panel } = open([{ uuid: "c-1", circuit: circuit("Oven", 20, 50, true) }], { monitoringInfo: { monitoring_enabled: false } });
    expect(shown(panel)).toBe(false);
    turnMonitoring(panel, true);
    expect(shown(panel)).toBe(true);
    expect(input(rows(panel)[0]!).value).toBe("50");
    turnMonitoring(panel, false);
    expect(shown(panel)).toBe(false);
    turnMonitoring(panel, true);
    expect(shown(panel)).toBe(true);
    expect(input(rows(panel)[0]!).value).toBe("50");
  });

  it("is shown in both the Global and the Custom mode", () => {
    expect(shown(open(ONE, { monitoringInfo: { monitoring_enabled: true, has_override: false } }).panel)).toBe(true);
    expect(shown(open(ONE, { monitoringInfo: { monitoring_enabled: true, has_override: true } }).panel)).toBe(true);
  });

  it("sits above the Global/Custom choice, outside the threshold fields", () => {
    const { panel } = open(ONE, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    const radios = panel.shadowRoot!.querySelector<HTMLElement>(".radio-group")!;
    expect(editor(panel)!.compareDocumentPosition(radios) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.shadowRoot!.querySelector('[data-role="threshold-fields"]')!.contains(editor(panel))).toBe(false);
    expect(details(panel).contains(editor(panel))).toBe(true);
  });

  it("is absent where the integration offers no monitoring rating, the Judged against line still shown", () => {
    const { panel } = open(ONE, { monitoringRatingOffered: false });
    expect(editor(panel)).toBeNull();
    expect(panel.shadowRoot!.querySelector('[data-role="judged-against"]')).not.toBeNull();
    expect(rows(open(ONE, { monitoringRatingOffered: true }).panel)).toHaveLength(1);
  });

  it("is absent for a circuit with no panel rating", () => {
    const { panel } = open([{ uuid: "c-1", circuit: circuit("Meter", null, null) }]);
    expect(rows(panel)).toHaveLength(0);
    expect(editor(panel)).toBeNull();
  });

  it("is one row for a lone circuit, with the guidance line", () => {
    const { panel } = open(ONE);
    expect(editor(panel)).not.toBeNull();
    expect(rows(panel)).toHaveLength(1);
    expect(input(rows(panel)[0]!).value).toBe("30");
    expect(rows(panel)[0]!.textContent).toContain("30 A");
    expect(editor(panel)!.textContent).toContain("The most current the measured wire can carry. For a tandem in one space, add its breakers.");
  });

  it("is one row per rated member of a shared slot, skipping a member with no panel rating", () => {
    const { panel } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 12, true) },
      { uuid: "c-c", circuit: circuit("Odd", null, null) },
    ]);
    expect(rows(panel)).toHaveLength(2);
    expect(input(rows(panel)[1]!).value).toBe("12");
    expect(rows(panel)[1]!.textContent).toContain("10 A");
  });

  it("shows the Judged against line beside it", () => {
    const { panel } = open([{ uuid: "c-1", circuit: circuit("Oven", 20, 50, true) }], {
      monitoringInfo: { monitoring_enabled: true, breaker_rating_a: 20, monitoring_rating_a: 50, monitoring_rating_user_set: true },
    });
    const judged = panel.shadowRoot!.querySelector('[data-role="judged-against"]')!;
    expect(judged.textContent).toBe("Judged against: 50 A, set by you (panel: 20 A)");
    expect(details(panel).contains(judged)).toBe(true);
    expect(judged.nextElementSibling).toBe(editor(panel));
  });
});

describe("the multi-space caution", () => {
  const CAUTION = "The panel reports the average of its legs, so one leg can carry more than its breaker while the reading stays under the rating.";

  it("is absent for a circuit in one space", () => {
    expect(cautions(open(ONE).panel)).toHaveLength(0);
  });

  it("is shown for a circuit whose tabs span two spaces", () => {
    const { panel } = open([{ uuid: "c-1", circuit: circuit("Dryer", 30, 30, false, [1, 3]) }]);
    expect(cautions(panel)).toHaveLength(1);
    expect(cautions(panel)[0]!.textContent).toContain(CAUTION);
    expect(cautions(panel)[0]!.textContent).toContain("Turning monitoring off for this circuit is the safer choice.");
  });

  it("is shown once, not per member, for a slot whose members occupy several spaces", () => {
    const { panel } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15, false, [1]) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 10, false, [3]) },
      { uuid: "c-c", circuit: circuit("Fan", 10, 10, false, [5]) },
    ]);
    expect(rows(panel)).toHaveLength(3);
    expect(cautions(panel)).toHaveLength(1);
  });

  it("is shown once for a slot of several members that each span two spaces", () => {
    const { panel } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15, false, [1, 3]) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 10, false, [1, 3]) },
    ]);
    expect(cautions(panel)).toHaveLength(1);
  });

  it("is absent for a tandem pair sharing one space", () => {
    const { panel } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15, false, [7]) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 10, false, [7]) },
    ]);
    expect(cautions(panel)).toHaveLength(0);
  });
});

describe("choosing Global and pressing Reset", () => {
  const WITH_RATING = [{ uuid: "c-1", circuit: circuit("Oven", 20, 50, true) }];

  it("choosing Global calls only clear_circuit_threshold and leaves the monitoring rating shown", () => {
    const { panel, callWS } = open(WITH_RATING, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    const global = panel.shadowRoot!.querySelector<HTMLInputElement>('input[name="monitoring-mode"][value="global"]')!;
    global.checked = true;
    global.dispatchEvent(new Event("change"));
    expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(["clear_circuit_threshold"]);
    expect(shown(panel)).toBe(true);
    expect(input(rows(panel)[0]!).value).toBe("50");
    expect(reset(rows(panel)[0]!)).not.toBeNull();
  });

  it("the rating's own reset calls only clear_circuit_monitoring_rating, leaving thresholds alone", () => {
    const { panel, callWS } = open(WITH_RATING, { monitoringInfo: { monitoring_enabled: true, has_override: true } });
    reset(rows(panel)[0]!)!.click();
    expect(callWS.mock.calls.map(c => (c[0] as { service: string }).service)).toEqual(["clear_circuit_monitoring_rating"]);
  });
});

describe("the rating input", () => {
  it("sends the rounded value for the row's own circuit, after the debounce", () => {
    const { panel, callWS } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 10) },
    ]);
    const el = input(rows(panel)[1]!);
    el.value = "12.6";
    el.dispatchEvent(new Event("input"));
    expect(callWS).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "span_panel",
      service: "set_circuit_monitoring_rating",
      service_data: { circuit_id: "c-b", monitoring_rating_a: 13, config_entry_id: "entry-1" },
    });
  });

  it("sends only the last of several keystrokes", () => {
    const { panel, callWS } = open(ONE);
    const el = input(rows(panel)[0]!);
    el.value = "4";
    el.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(100);
    el.value = "40";
    el.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(600);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service_data: { monitoring_rating_a: 40 } });
  });

  it.each(["", "abc", "0", "-5", "0.5", "0.99"])("sends nothing for %j", value => {
    const { panel, callWS } = open(ONE);
    type(input(rows(panel)[0]!), value);
    expect(callWS).not.toHaveBeenCalled();
  });

  it("leaves max unset, since the topology carries no service rating", () => {
    const el = input(rows(open(ONE).panel)[0]!);
    expect(el.min).toBe("1");
    expect(el.hasAttribute("max")).toBe(false);
  });

  it("does not show the typed value as the rating in force", () => {
    const { panel } = open([{ uuid: "c-1", circuit: circuit("Oven", 30, 25, true) }]);
    type(input(rows(panel)[0]!), "50");
    const shown = panel.shadowRoot!.querySelector(".panel")!.textContent;
    expect(shown).toContain("Oven");
    expect(shown).not.toContain("50");
    expect(panel.shadowRoot!.querySelector('[data-role="rating-panel-rating"]')!.textContent).toBe("Panel: 30 A");
  });
});

describe("the reset", () => {
  it("is shown only on a row whose rating is the user's", () => {
    const { panel } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 12, true) },
    ]);
    expect(reset(rows(panel)[0]!)).toBeNull();
    expect(reset(rows(panel)[1]!)).not.toBeNull();
  });

  it("cancels a typed value still waiting out its debounce", () => {
    const { panel, callWS } = open([{ uuid: "c-1", circuit: circuit("Oven", 30, 25, true) }]);
    const el = input(rows(panel)[0]!);
    el.value = "50";
    el.dispatchEvent(new Event("input"));
    reset(rows(panel)[0]!)!.click();
    vi.advanceTimersByTime(600);
    expect(callWS).toHaveBeenCalledTimes(1);
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service: "clear_circuit_monitoring_rating" });
  });

  it("clears the monitoring rating of its own circuit", () => {
    const { panel, callWS } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 12, true) },
    ]);
    reset(rows(panel)[1]!)!.click();
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "span_panel",
      service: "clear_circuit_monitoring_rating",
      service_data: { circuit_id: "c-b", config_entry_id: "entry-1" },
    });
  });
});

describe("a refused change", () => {
  it("shows the service's message", async () => {
    const { panel, errors } = open(ONE, {}, async () => {
      throw { code: "service_validation_error", message: "50 A is above the panel's 40 A service rating" };
    });
    type(input(rows(panel)[0]!), "50");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["50 A is above the panel's 40 A service rating"]);
  });

  it("falls back to the generic message when the error carries none", async () => {
    const { panel, errors } = open(ONE, {}, async () => {
      throw new Error("");
    });
    type(input(rows(panel)[0]!), "50");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["Unable to update monitoring rating"]);
  });

  it("puts the rating in force back in the input, beside the message", async () => {
    const { panel, errors } = open(ONE, {}, async () => {
      throw { code: "service_validation_error", message: "50 A is above the panel's 40 A service rating" };
    });
    type(input(rows(panel)[0]!), "50");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active).toHaveLength(1);
    expect(input(rows(panel)[0]!).value).toBe("30");
    expect(rows(panel)).toHaveLength(1);
  });

  it("restores only the refused member's row of a shared slot", async () => {
    const { panel } = open(
      [
        { uuid: "c-a", circuit: circuit("Lights", 15, 15) },
        { uuid: "c-b", circuit: circuit("Outlets", 10, 12, true) },
      ],
      {},
      async () => {
        throw { message: "refused" };
      }
    );
    const lights = rows(panel)[0]!;
    input(lights).value = "17";
    type(input(rows(panel)[1]!), "99");
    await vi.advanceTimersByTimeAsync(0);
    expect(rows(panel)[0]).toBe(lights);
    expect(input(rows(panel)[0]!).value).toBe("17");
    expect(input(rows(panel)[1]!).value).toBe("12");
    expect(reset(rows(panel)[1]!)).not.toBeNull();
  });

  it("restores from the rating in force when the refusal lands, not when the value was typed", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel } = open(ONE, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(rows(panel)[0]!), "50");
    (panel as unknown as { refreshRating(view: unknown): void }).refreshRating({
      members: [{ uuid: "c-1", circuit: circuit("Oven", 30, 35, true) }],
      ratingText: "35 A",
      monitoringInfo: null,
    });
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(input(rows(panel)[0]!).value).toBe("35");
    expect(reset(rows(panel)[0]!)).not.toBeNull();
  });

  it("leaves a value typed while the refused one was in flight", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel, callWS } = open(ONE, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(rows(panel)[0]!), "50");
    const el = input(rows(panel)[0]!);
    el.value = "45";
    el.dispatchEvent(new Event("input"));
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(input(rows(panel)[0]!)).toBe(el);
    expect(el.value).toBe("45");
    vi.advanceTimersByTime(600);
    expect(callWS.mock.calls.map(c => (c[0] as { service_data: { monitoring_rating_a?: number } }).service_data.monitoring_rating_a)).toEqual([50, 45]);
  });

  it("does nothing to a panel closed while the call was in flight", async () => {
    let refuse: (reason: unknown) => void = () => {};
    const { panel } = open(ONE, {}, () => new Promise((_resolve, reject) => (refuse = reject)));
    type(input(rows(panel)[0]!), "50");
    (panel as unknown as { close(): void }).close();
    refuse({ message: "refused" });
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.hasAttribute("open")).toBe(false);
  });

  it("reports a failed reset the same way", async () => {
    const { panel, errors } = open([{ uuid: "c-1", circuit: circuit("Oven", 30, 50, true) }], {}, async () => {
      throw { message: "no such circuit" };
    });
    reset(rows(panel)[0]!)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["no such circuit"]);
  });
});

describe("the gear", () => {
  const TOPOLOGY = {
    circuits: {
      "c-a": { ...circuit("Lights", 15, 15), shared_meter_group: "c-a" },
      "c-b": { ...circuit("Outlets", 10, 12, true), shared_meter_group: "c-a" },
      "c-m": circuit("Lone", 20, 20),
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

  it("passes on whether the panel offers a monitoring rating, as the integration says", async () => {
    expect((await opened("c-m", true, { ...TOPOLOGY, monitoring_rating_offered: false })).monitoringRatingOffered).toBe(false);
    expect((await opened("c-m", true, { ...TOPOLOGY, monitoring_rating_offered: true })).monitoringRatingOffered).toBe(true);
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
