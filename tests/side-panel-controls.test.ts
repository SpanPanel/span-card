import { describe, it, expect, afterEach, vi } from "vitest";
import "../src/core/side-panel.js";
import "../src/core/span-switch.js";
import { ErrorStore } from "../src/core/error-store.js";
import { setLanguage } from "../src/i18n.js";
import type { Circuit, ControlAccess, HomeAssistant } from "../src/types.js";

const SWITCH = "switch.kitchen_breaker";
const SELECT = "select.kitchen_circuit_priority";
const POWER = "sensor.kitchen_power";

type Message = Record<string, unknown>;
type CallWS = (msg: Message) => Promise<unknown>;

type SidePanel = HTMLElement & {
  hass: HomeAssistant;
  errorStore: ErrorStore | null;
  open(config: unknown): void;
  refreshControlAccess(access: ControlAccess): void;
};

const ADMIN_ONLY: ControlAccess = { mayOperate: false, reason: "admin_only" };
const OPERABLE: ControlAccess = { mayOperate: true, reason: null };
const ADMIN_ONLY_HINT = "Only an administrator can operate this panel's controls.";

/** The integration's exception messages, as Home Assistant loads them for the frontend. */
const GATE_MESSAGES: Record<string, string> = {
  "component.span_panel.exceptions.admin_only_control.message": "Only a Home Assistant administrator may operate this SPAN panel.",
  "component.span_panel.exceptions.control_locked.message": "The SPAN panel's control lock is armed. Disarm it before operating circuits.",
  "component.span_panel.exceptions.relay_debounced.message": "That circuit's relay was operated moments ago. The command was refused rather than queued.",
};

/** The control gate's refusal, as Home Assistant's websocket rejects a service call with it. */
function refusal(key: string): Record<string, unknown> {
  const message = GATE_MESSAGES[`component.span_panel.exceptions.${key}.message`] ?? key;
  return {
    code: "service_validation_error",
    message: `Validation error: ${message}`,
    translation_domain: "span_panel",
    translation_key: key,
    translation_placeholders: {},
  };
}

function hass(states: Record<string, string>, callWS: CallWS = async () => ({})): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return {
    states: full,
    services: {},
    language: "en",
    callService: vi.fn(async () => undefined),
    callWS,
    loadBackendTranslation: async () => (key: string) => GATE_MESSAGES[key] ?? "",
  } as unknown as HomeAssistant;
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  setLanguage("en");
  vi.restoreAllMocks();
});

/** The kitchen circuit alone, as the panel publishes it. */
const KITCHEN: Circuit = { name: "Kitchen", tabs: [2], voltage: 240, breaker_rating_a: 20, entities: { switch: SWITCH, select: SELECT, power: POWER } };

interface OpenOptions {
  priority?: string;
  callWS?: CallWS;
  slot?: readonly Circuit[];
  controlAccess?: ControlAccess;
  entities?: Circuit["entities"];
}

function openFor(states: Record<string, string>, options: OpenOptions = {}): SidePanel {
  const panel = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(panel);
  mounted.push(panel);
  panel.hass = hass(states, options.callWS);
  panel.errorStore = new ErrorStore();
  const slot = options.slot ?? [KITCHEN];
  panel.open({
    uuid: "kitchen",
    name: "Kitchen",
    members: slot.map((circuit, i) => ({ uuid: i === 0 ? "kitchen" : `kitchen-${i}`, circuit })),
    capacityA: null,
    entities: options.entities ?? { switch: SWITCH, select: SELECT, power: POWER },
    is_user_controllable: true,
    relay_state: "CLOSED",
    priority: options.priority,
    monitoringInfo: null,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
    controlAccess: options.controlAccess ?? OPERABLE,
  });
  return panel;
}

function relay(panel: SidePanel): HTMLElement & { disabled: boolean; checked: boolean } {
  return panel.shadowRoot!.querySelector('[data-role="relay-toggle"]') as HTMLElement & { disabled: boolean; checked: boolean };
}

function select(panel: SidePanel): HTMLSelectElement {
  return panel.shadowRoot!.querySelector('[data-role="shedding-select"]') as HTMLSelectElement;
}

function note(panel: SidePanel): HTMLElement | null {
  return panel.shadowRoot!.querySelector<HTMLElement>('[data-role="controls-note"]');
}

/** Choose `option` in the priority select, as the user does. */
function choose(panel: SidePanel, option: string): void {
  select(panel).value = option;
  select(panel).dispatchEvent(new Event("change", { bubbles: true }));
}

/** Let every pending refusal, and its report, settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** A send that waits until the test answers it. */
function deferredSend(): { callWS: ReturnType<typeof vi.fn<CallWS>>; answer: (err?: unknown) => void } {
  let settleIt: ((err?: unknown) => void) | null = null;
  const callWS = vi.fn<CallWS>(
    () =>
      new Promise<unknown>((resolve, reject) => {
        settleIt = (err?: unknown) => (err === undefined ? resolve({}) : reject(err));
      })
  );
  return { callWS, answer: err => settleIt?.(err) };
}

/** The messages the error store was handed, by key. */
function reported(panel: SidePanel): Array<[string, string]> {
  return vi.mocked(panel.errorStore!.add).mock.calls.map(([entry]) => [entry.key, entry.message]);
}

describe("the side panel's controls", () => {
  it("are enabled while the switch and select are operable", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" });
    expect(relay(panel).disabled).toBe(false);
    expect(select(panel).disabled).toBe(false);
    expect(select(panel).value).toBe("never");
  });

  it("are drawn disabled while the switch and select are unavailable, showing the last known state", () => {
    const panel = openFor({ [SWITCH]: "unavailable", [SELECT]: "unavailable" }, { priority: "OFF_GRID" });
    expect(relay(panel).disabled).toBe(true);
    expect(relay(panel).hasAttribute("checked")).toBe(true);
    expect(select(panel).disabled).toBe(true);
    expect(select(panel).value).toBe("off_grid");
  });

  it("shows no priority as chosen when it is unknown, on first render and on a live update", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "unavailable" });
    expect(select(panel).selectedIndex).toBe(-1);

    panel.hass = hass({ [SWITCH]: "on", [SELECT]: "soc_threshold" });
    expect(select(panel).value).toBe("soc_threshold");

    panel.hass = hass({ [SWITCH]: "on", [SELECT]: "unknown" });
    expect(select(panel).selectedIndex).toBe(-1);
    expect(select(panel).disabled).toBe(true);
  });

  it("tracks the switch going unavailable on a live update", () => {
    const panel = openFor({ [SWITCH]: "off", [SELECT]: "never" });
    panel.hass = hass({ [SWITCH]: "unavailable", [SELECT]: "never" });
    expect(relay(panel).disabled).toBe(true);
  });

  it("are untitled, with no note, where the user may operate them", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: OPERABLE });
    expect(relay(panel).hasAttribute("title")).toBe(false);
    expect(select(panel).hasAttribute("title")).toBe(false);
    expect(note(panel)).toBeNull();
  });
});

describe("the side panel's relay switch", () => {
  // The switch flips its `checked` property and fires `change` at once; Lit
  // reflects the attribute only on its next update, so the handler must read
  // the property.
  it("turns an on breaker off", () => {
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS });
    relay(panel).click();
    expect(callWS).toHaveBeenCalledWith({ type: "call_service", domain: "switch", service: "turn_off", service_data: {}, target: { entity_id: SWITCH } });
  });

  it("turns an off breaker on", () => {
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "off", [SELECT]: "never" }, { callWS });
    relay(panel).click();
    expect(callWS).toHaveBeenCalledWith({ type: "call_service", domain: "switch", service: "turn_on", service_data: {}, target: { entity_id: SWITCH } });
  });
});

describe("the side panel's shedding priority", () => {
  it("sets the priority chosen", () => {
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS });
    choose(panel, "off_grid");
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "select",
      service: "select_option",
      service_data: { option: "off_grid" },
      target: { entity_id: SELECT },
    });
  });
});

describe("the side panel's controls, for a user who may not operate the panel's", () => {
  it("are drawn disabled, titled with why, still showing the relay and the priority", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    expect(relay(panel).disabled).toBe(true);
    expect(relay(panel).hasAttribute("checked")).toBe(true);
    expect(relay(panel).title).toBe(ADMIN_ONLY_HINT);
    expect(select(panel).disabled).toBe(true);
    expect(select(panel).value).toBe("never");
    expect(select(panel).title).toBe(ADMIN_ONLY_HINT);
  });

  it("say why in a note under the relay", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    expect(note(panel)!.textContent).toBe(ADMIN_ONLY_HINT);
    expect(note(panel)!.getAttribute("role")).toBe("note");
    expect(note(panel)!.closest(".section")!.contains(relay(panel))).toBe(true);
    expect(panel.shadowRoot!.querySelectorAll('[data-role="controls-note"]')).toHaveLength(1);
  });

  it("say why under the priority where the circuit has no relay switch", () => {
    const panel = openFor({ [SELECT]: "never" }, { controlAccess: ADMIN_ONLY, entities: { select: SELECT, power: POWER } });
    expect(relay(panel)).toBeNull();
    expect(note(panel)!.closest(".section")!.contains(select(panel))).toBe(true);
  });

  it("say why the integration gives: control switched off in the panel's options", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: { mayOperate: false, reason: "control_disabled" } });
    expect(note(panel)!.textContent).toBe("Control of this panel is switched off in its options.");
    expect(relay(panel).title).toBe("Control of this panel is switched off in its options.");
  });

  it("say why in the user's language", () => {
    setLanguage("es");
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    expect(note(panel)!.textContent).toBe("Solo un administrador puede operar los controles de este panel.");
  });

  it("stay disabled on a live update, whatever the switch and select read", () => {
    const panel = openFor({ [SWITCH]: "unavailable", [SELECT]: "unavailable" }, { controlAccess: ADMIN_ONLY });
    panel.hass = hass({ [SWITCH]: "off", [SELECT]: "soc_threshold" });
    expect(relay(panel).disabled).toBe(true);
    expect(relay(panel).hasAttribute("checked")).toBe(false);
    expect(select(panel).disabled).toBe(true);
    expect(select(panel).value).toBe("soc_threshold");
  });

  it("send nothing, a click on the relay included", async () => {
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS, controlAccess: ADMIN_ONLY });
    relay(panel).click();
    await settle();
    expect(callWS).not.toHaveBeenCalled();
    expect(relay(panel).hasAttribute("checked")).toBe(true);
  });

  it("send nothing for a priority change, refusing it and saying why", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS, controlAccess: ADMIN_ONLY });
    vi.spyOn(panel.errorStore!, "add");
    choose(panel, "off_grid");
    await settle();
    expect(callWS).not.toHaveBeenCalled();
    expect(select(panel).value).toBe("never");
    expect(reported(panel)).toEqual([["service:shedding", ADMIN_ONLY_HINT]]);
  });

  it("leave the graph horizon and the favorite open", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    const horizon = panel.shadowRoot!.querySelector('[data-role="horizon-section"]')!;
    for (const control of horizon.querySelectorAll<HTMLSelectElement | HTMLInputElement | HTMLButtonElement>("select, input, button")) {
      expect(control.disabled).toBe(false);
    }
    expect(horizon.querySelectorAll("select, input, button").length).toBeGreaterThan(0);
  });
});

describe("the side panel's controls, as the access the user has changes while it is open", () => {
  it("are disabled, with the note, where the user may no longer operate them, nothing else drawn again", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" });
    const body = panel.shadowRoot!.querySelector(".panel-body");
    const toggle = relay(panel);

    panel.refreshControlAccess(ADMIN_ONLY);

    expect(panel.shadowRoot!.querySelector(".panel-body")).toBe(body);
    expect(relay(panel)).toBe(toggle);
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe(ADMIN_ONLY_HINT);
    expect(select(panel).disabled).toBe(true);
    expect(note(panel)!.textContent).toBe(ADMIN_ONLY_HINT);
  });

  it("are enabled again, the note gone, where the user may operate them again", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    panel.refreshControlAccess(OPERABLE);
    expect(relay(panel).disabled).toBe(false);
    expect(relay(panel).hasAttribute("title")).toBe(false);
    expect(select(panel).disabled).toBe(false);
    expect(note(panel)).toBeNull();
  });

  it("send what the user may now send, and refuse what the user may no longer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS, controlAccess: ADMIN_ONLY });
    panel.refreshControlAccess(OPERABLE);
    relay(panel).click();
    expect(callWS).toHaveBeenCalledTimes(1);

    panel.refreshControlAccess(ADMIN_ONLY);
    choose(panel, "off_grid");
    await settle();
    expect(callWS).toHaveBeenCalledTimes(1);
  });

  it("say why once, the reason changing", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    panel.refreshControlAccess({ mayOperate: false, reason: "control_disabled" });
    expect(panel.shadowRoot!.querySelectorAll('[data-role="controls-note"]')).toHaveLength(1);
    expect(note(panel)!.textContent).toBe("Control of this panel is switched off in its options.");
  });

  it("are ignored while the side panel is closed", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" });
    panel.removeAttribute("open");
    panel.refreshControlAccess(ADMIN_ONLY);
    expect(relay(panel).disabled).toBe(false);
  });
});

describe("an open side panel moved in the DOM, as a dashboard moves its card between columns", () => {
  /** Move `panel` under a parent of its own, as a masonry view re-columning does, and hand it Home Assistant again. */
  function move(panel: SidePanel): void {
    const hassNow = panel.hass;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    mounted.push(parent);
    parent.appendChild(panel);
    panel.hass = hassNow;
  }

  it("still sends a relay and a priority change where the user may operate the controls", async () => {
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS, controlAccess: OPERABLE });
    move(panel);

    expect(panel.hasAttribute("open")).toBe(true);
    expect(relay(panel).disabled).toBe(false);
    relay(panel).click();
    choose(panel, "off_grid");
    await settle();

    expect(callWS.mock.calls.map(([msg]) => [msg.domain, msg.service])).toEqual([
      ["switch", "turn_off"],
      ["select", "select_option"],
    ]);
  });

  it("still refuses them, saying why, where the user may not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS, controlAccess: ADMIN_ONLY });
    vi.spyOn(panel.errorStore!, "add");
    move(panel);

    expect(relay(panel).disabled).toBe(true);
    relay(panel).click();
    choose(panel, "off_grid");
    await settle();

    expect(callWS).not.toHaveBeenCalled();
    expect(reported(panel)).toEqual([["service:shedding", ADMIN_ONLY_HINT]]);
    expect(note(panel)!.textContent).toBe(ADMIN_ONLY_HINT);
  });

  it("still takes the access a topology fetched again gives, being still open on its circuit", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: OPERABLE });
    move(panel);
    panel.refreshControlAccess(ADMIN_ONLY);
    expect(relay(panel).disabled).toBe(true);
    expect(note(panel)!.textContent).toBe(ADMIN_ONLY_HINT);
  });
});

describe("a graph horizon change still on its way as the panel leaves the page", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The panel's graph settings side panel, with a horizon select for the kitchen, over a Home Assistant that records each call. */
  function panelSettings(callWS: CallWS): SidePanel {
    const panel = document.createElement("span-side-panel") as SidePanel;
    document.body.appendChild(panel);
    mounted.push(panel);
    panel.hass = hass({ [SWITCH]: "on" }, callWS);
    panel.errorStore = new ErrorStore();
    panel.open({
      panelMode: true,
      topology: { circuits: { kitchen: KITCHEN } },
      graphSettings: { global_horizon: "5m", circuits: {} },
      configEntryId: "entry-1",
    });
    return panel;
  }

  /** Choose `horizon` for the kitchen, as the user does. */
  function chooseHorizon(panel: SidePanel, horizon: string): void {
    const select = panel.shadowRoot!.querySelector<HTMLSelectElement>('select[data-uuid="kitchen"]')!;
    select.value = horizon;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function horizonWrites(callWS: ReturnType<typeof vi.fn<CallWS>>): unknown[] {
    return callWS.mock.calls.map(([msg]) => msg).filter(msg => msg.service === "set_circuit_graph_horizon");
  }

  it("is sent once, the horizon chosen, where a dashboard moves the panel within the wait", async () => {
    vi.useFakeTimers();
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = panelSettings(callWS);
    chooseHorizon(panel, "1h");

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    mounted.push(parent);
    parent.appendChild(panel);
    expect(horizonWrites(callWS)).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);

    expect(horizonWrites(callWS)).toEqual([
      {
        type: "call_service",
        domain: "span_panel",
        service: "set_circuit_graph_horizon",
        service_data: { circuit_id: "kitchen", horizon: "1h", config_entry_id: "entry-1" },
      },
    ]);
  });

  it("is sent once even where the panel is taken off the page for good", async () => {
    vi.useFakeTimers();
    const callWS = vi.fn<CallWS>(async () => ({}));
    const panel = panelSettings(callWS);
    chooseHorizon(panel, "1h");
    panel.remove();
    await vi.advanceTimersByTimeAsync(500);
    expect(horizonWrites(callWS)).toHaveLength(1);
  });
});

describe("the side panel's relay and priority, for assistive technology", () => {
  it("are named by their labels", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" });
    const root = panel.shadowRoot!;
    expect(root.getElementById(relay(panel).getAttribute("aria-labelledby")!)!.textContent).toBe("Breaker");
    expect(root.getElementById(select(panel).getAttribute("aria-labelledby")!)!.textContent).toBe("Priority");
  });

  it("are described by the note saying why neither can be operated, and by nothing once both can", () => {
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { controlAccess: ADMIN_ONLY });
    const root = panel.shadowRoot!;
    for (const control of [relay(panel), select(panel)]) expect(root.getElementById(control.getAttribute("aria-describedby")!)).toBe(note(panel));

    panel.refreshControlAccess(OPERABLE);
    for (const control of [relay(panel), select(panel)]) expect(control.hasAttribute("aria-describedby")).toBe(false);

    panel.refreshControlAccess(ADMIN_ONLY);
    for (const control of [relay(panel), select(panel)]) expect(root.getElementById(control.getAttribute("aria-describedby")!)).toBe(note(panel));
  });
});

/** Home Assistant's Unauthorized for this one entity, as a service raises it for a user its permissions do not let control it. */
const UNAUTHORIZED = { code: "home_assistant_error", message: "Unauthorized" };
const ENTITY_UNAUTHORIZED = "Your Home Assistant account can't operate this control.";

describe("a relay change refused", () => {
  it('by Home Assistant for this one entity shows the relay as it is, and says the account cannot operate it, not "Unauthorized"', async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject(UNAUTHORIZED) });
    vi.spyOn(panel.errorStore!, "add");
    relay(panel).click();
    await settle();
    expect(relay(panel).checked).toBe(true);
    expect(reported(panel)).toEqual([["service:relay", ENTITY_UNAUTHORIZED]]);
  });

  it("shows the relay as Home Assistant reports it, never as clicked, and says why as the gate says it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject(refusal("admin_only_control")) });
    vi.spyOn(panel.errorStore!, "add");
    relay(panel).click();
    expect(relay(panel).checked).toBe(false);

    await settle();

    expect(relay(panel).checked).toBe(true);
    expect(relay(panel).hasAttribute("checked")).toBe(true);
    expect(reported(panel)).toEqual([["service:relay", "Only a Home Assistant administrator may operate this SPAN panel."]]);
  });

  it("twice in a row shows the relay as it is each time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject(refusal("control_locked")) });
    vi.spyOn(panel.errorStore!, "add");
    relay(panel).click();
    await settle();
    expect(relay(panel).checked).toBe(true);
    relay(panel).click();
    expect(relay(panel).checked).toBe(false);
    await settle();

    expect(relay(panel).checked).toBe(true);
    expect(reported(panel).map(([, message]) => message)).toEqual([
      "The SPAN panel's control lock is armed. Disarm it before operating circuits.",
      "The SPAN panel's control lock is armed. Disarm it before operating circuits.",
    ]);
  });

  it("after one was taken shows the relay as that one left it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const callWS: CallWS = async () => (++calls === 1 ? {} : Promise.reject(refusal("relay_debounced")));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS });
    relay(panel).click();
    await settle();
    // The relay opened, as Home Assistant now reports.
    panel.hass = hass({ [SWITCH]: "off", [SELECT]: "never" }, callWS);
    relay(panel).click();
    expect(relay(panel).checked).toBe(true);

    await settle();

    expect(relay(panel).checked).toBe(false);
  });

  // The live update already shows the relay as it is now; the refusal arriving after it must not put back the state from before the click.
  it("after the relay changed meanwhile shows it as it is now, not as it was before the click", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { callWS, answer } = deferredSend();
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS });
    relay(panel).click();
    // Something else opened the relay while the change was on its way.
    panel.hass = hass({ [SWITCH]: "off", [SELECT]: "never" }, callWS);
    answer(refusal("relay_debounced"));
    await settle();

    expect(relay(panel).checked).toBe(false);
  });

  it("with nothing to say why says the relay could not be toggled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject({}) });
    vi.spyOn(panel.errorStore!, "add");
    relay(panel).click();
    await settle();
    expect(reported(panel)).toEqual([["service:relay", "Unable to toggle relay"]]);
    expect(relay(panel).checked).toBe(true);
  });
});

describe("a priority change refused", () => {
  it("by Home Assistant for this one entity shows the priority as it is, and says the account cannot operate it, in the user's language", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setLanguage("ja");
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject({ code: "unauthorized", message: "Unauthorized" }) });
    vi.spyOn(panel.errorStore!, "add");
    choose(panel, "off_grid");
    await settle();
    expect(select(panel).value).toBe("never");
    expect(reported(panel)).toEqual([["service:shedding", "お使いのHome Assistantアカウントでは、このコントロールを操作できません。"]]);
  });

  it("shows the priority as Home Assistant reports it, never as chosen, and says why as the gate says it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject(refusal("admin_only_control")) });
    vi.spyOn(panel.errorStore!, "add");
    choose(panel, "off_grid");
    await settle();

    expect(select(panel).value).toBe("never");
    expect(reported(panel)).toEqual([["service:shedding", "Only a Home Assistant administrator may operate this SPAN panel."]]);
  });

  it("twice in a row shows the priority as it is each time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS: async () => Promise.reject(refusal("control_locked")) });
    choose(panel, "off_grid");
    await settle();
    choose(panel, "soc_threshold");
    await settle();
    expect(select(panel).value).toBe("never");
  });

  it("after one was taken shows the priority as that one left it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const callWS: CallWS = async () => (++calls === 1 ? {} : Promise.reject(refusal("control_locked")));
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS });
    choose(panel, "off_grid");
    await settle();
    panel.hass = hass({ [SWITCH]: "on", [SELECT]: "off_grid" }, callWS);
    choose(panel, "soc_threshold");
    await settle();
    expect(select(panel).value).toBe("off_grid");
  });

  it("after the priority changed meanwhile shows it as it is now", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { callWS, answer } = deferredSend();
    const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { callWS });
    choose(panel, "off_grid");
    panel.hass = hass({ [SWITCH]: "on", [SELECT]: "soc_threshold" }, callWS);
    answer(refusal("control_locked"));
    await settle();
    expect(select(panel).value).toBe("soc_threshold");
  });
});

describe("the side panel's subtitle", () => {
  it("shows the panel's ratings, unmarked, whatever monitoring judges against", () => {
    const userSet = { ...KITCHEN, monitoring_rating_a: 50, monitoring_rating_user_set: true };
    const pair = [
      { ...KITCHEN, breaker_rating_a: 15, monitoring_rating_a: 15, monitoring_rating_user_set: false },
      { ...KITCHEN, name: "Kitchen 2", breaker_rating_a: 10, monitoring_rating_a: 25, monitoring_rating_user_set: true },
    ];
    const cases: [readonly Circuit[], string][] = [
      [[KITCHEN], "20A"],
      [[userSet], "20A"],
      [pair, "15·10 A"],
    ];
    for (const [slot, text] of cases) {
      const panel = openFor({ [SWITCH]: "on", [SELECT]: "never" }, { slot });
      expect(panel.shadowRoot!.querySelector(".subtitle")!.textContent).toBe(`${text} · 240V · Tabs [2]`);
    }
  });
});
