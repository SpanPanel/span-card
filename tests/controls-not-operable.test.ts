import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { CardConfig, ControlAccess, HomeAssistant, PanelTopology } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
  discoverEntitiesFallback: vi.fn(),
}));

import { discoverEntitiesFallback, discoverTopology } from "../src/card/card-discovery.js";
import { CONTROLS_OPERABLE } from "../src/core/control-access.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { updateCircuitDOM } from "../src/core/dom-updater.js";
import { FavoritesController } from "../src/core/favorites-controller.js";
import { renderCircuitSlot } from "../src/core/grid-renderer.js";
import { buildHeaderHTML, buildSlideConfirmHTML } from "../src/core/header-renderer.js";
import { ListViewController } from "../src/core/list-view-controller.js";
import "../src/card/span-panel-card.js";
import { ENTRY_RELOADS, FakeConnection, flush, hassWith } from "./fake-connection.js";

/**
 * A user who may not operate a panel's controls sees every relay and priority
 * control the card draws disabled, saying why, and sends nothing; one who may,
 * or a card over an integration that says nothing of it, sees them as before.
 */

const mockDiscover = vi.mocked(discoverTopology);
const mockFallback = vi.mocked(discoverEntitiesFallback);
type Card = HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };
type Message = Record<string, unknown>;

const SWITCH = "switch.kitchen_breaker";
const SELECT = "select.kitchen_circuit_priority";
const POWER = "sensor.kitchen_power";
const STATUS = "binary_sensor.span_panel_status";
const ADMIN_ONLY_HINT = "Only an administrator can operate this panel's controls.";
const ADMIN_ONLY: ControlAccess = { mayOperate: false, reason: "admin_only" };

const BLOCKED = { may_operate: false, reason: "admin_only" } as const;
const ALLOWED = { may_operate: true, reason: null } as const;

function topology(control_access?: typeof BLOCKED | typeof ALLOWED | { may_operate: false; reason: "control_disabled" }): PanelTopology {
  return {
    circuits: {
      kitchen: {
        name: "Kitchen",
        device_id: "device-kitchen",
        tabs: [1],
        entities: { power: POWER, switch: SWITCH, select: SELECT },
        is_user_controllable: true,
        relay_state: "CLOSED",
        priority: "NEVER",
      },
      garage: {
        name: "Garage",
        device_id: "device-garage",
        tabs: [3],
        entities: { power: "sensor.garage_power", switch: "switch.garage_breaker" },
        is_user_controllable: true,
        relay_state: "OPEN",
      },
    },
    panel_entities: { panel_status: STATUS },
    panel_size: 32,
    panel_device_id: "panel-1",
    config_entry_id: "entry-1",
    ...(control_access ? { control_access } : {}),
  } as unknown as PanelTopology;
}

const state = (entity_id: string, s: string) => ({ entity_id, state: s, attributes: {}, last_changed: "", last_updated: "" });
const STATES = {
  [SWITCH]: state(SWITCH, "on"),
  [SELECT]: state(SELECT, "never"),
  [POWER]: state(POWER, "120"),
  "switch.garage_breaker": state("switch.garage_breaker", "off"),
  "sensor.garage_power": state("sensor.garage_power", "0"),
  [STATUS]: state(STATUS, "on"),
};

/** Every relay or priority change the card sent. */
let controlSends: Message[] = [];

function hassFor(connection: FakeConnection): HomeAssistant {
  return hassWith(connection, {
    states: STATES,
    callWS: (async (msg: Message) => {
      if (msg.type === "call_service" && (msg.domain === "switch" || msg.domain === "select")) controlSends.push(msg);
      if (msg.type === "config/area_registry/list" || msg.type === "config/entity_registry/list" || msg.type === "config/device_registry/list") return [];
      return {};
    }) as HomeAssistant["callWS"],
  });
}

const mounted: HTMLElement[] = [];

beforeEach(() => {
  controlSends = [];
  mockFallback.mockRejectedValue(new Error("no fallback"));
});

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
  mockDiscover.mockReset();
  mockFallback.mockReset();
});

async function mount(first: PanelTopology): Promise<{ card: Card; connection: FakeConnection; root: ShadowRoot }> {
  mockDiscover.mockImplementation(async () => ({ topology: first, panelDevice: null, panelSize: 32 }));
  const connection = new FakeConnection();
  const card = document.createElement("span-panel-card") as Card;
  card.setConfig({ device_id: "panel-1" } as CardConfig);
  document.body.appendChild(card);
  mounted.push(card);
  card.hass = hassFor(connection);
  await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".panel-grid")).not.toBeNull());
  await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
  await flush();
  return { card, connection, root: card.shadowRoot! };
}

/** The panel's entry reloads, as after its options change: it sets up again, then is loaded. */
function reload(connection: FakeConnection): void {
  connection.emit(ENTRY_RELOADS, [{ type: null, entry: { entry_id: "entry-1", domain: "span_panel", state: "loaded" } }]);
  connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: "entry-1", domain: "span_panel", state: "setup_in_progress" } }]);
  connection.emit(ENTRY_RELOADS, [{ type: "updated", entry: { entry_id: "entry-1", domain: "span_panel", state: "loaded" } }]);
}

function pills(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".toggle-pill")];
}

/** Drag the slider's knob to its end, as a user arms the switches; the layout is given, which happy-dom has none of. */
function drag(slide: HTMLElement): void {
  const knob = slide.querySelector<HTMLElement>(".slide-confirm-knob")!;
  Object.defineProperty(slide, "offsetWidth", { configurable: true, get: () => 160 });
  Object.defineProperty(knob, "offsetWidth", { configurable: true, get: () => 24 });
  Object.defineProperty(knob, "offsetLeft", { configurable: true, get: () => Number.parseFloat(knob.style.left || "2") });
  knob.dispatchEvent(new MouseEvent("mousedown", { clientX: 2, bubbles: true }));
  slide.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, bubbles: true }));
  slide.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

/** Open the circuit's side panel from its gear, as the user does. */
async function openSidePanel(root: ShadowRoot, uuid: string): Promise<HTMLElement> {
  root.querySelector<HTMLElement>(`.circuit-gear[data-uuid="${uuid}"]`)!.click();
  await vi.waitFor(() => expect(root.querySelector("span-side-panel[open]")).not.toBeNull());
  return root.querySelector<HTMLElement>("span-side-panel[open]")!;
}

function sideRelay(sidePanel: HTMLElement): HTMLElement & { disabled: boolean } {
  return sidePanel.shadowRoot!.querySelector('[data-role="relay-toggle"]') as HTMLElement & { disabled: boolean };
}

describe("the card's By Panel view, for a user who may not operate the panel's controls", () => {
  it("draws every breaker's toggle forbidden, still showing its relay, titled with why", async () => {
    const { root } = await mount(topology(BLOCKED));
    const drawn = pills(root);
    expect(drawn).toHaveLength(2);
    for (const pill of drawn) {
      expect(pill.classList.contains("toggle-forbidden")).toBe(true);
      expect(pill.title).toBe(ADMIN_ONLY_HINT);
    }
    expect(root.querySelector('[data-uuid="kitchen"] .toggle-pill')!.classList.contains("toggle-on")).toBe(true);
    expect(root.querySelector('[data-uuid="garage"] .toggle-pill')!.classList.contains("toggle-off")).toBe(true);
  });

  it("draws Enable Switches forbidden, titled and noted with why, and it cannot be armed", async () => {
    const { root } = await mount(topology(BLOCKED));
    const slide = root.querySelector<HTMLElement>(".slide-confirm")!;
    expect(slide.classList.contains("slide-confirm-forbidden")).toBe(true);
    expect(slide.title).toBe(ADMIN_ONLY_HINT);
    expect(root.querySelector('.panel-identity [data-role="controls-note"]')!.textContent).toBe(ADMIN_ONLY_HINT);

    drag(slide);

    expect(slide.classList.contains("confirmed")).toBe(false);
    expect(root.querySelector(".span-card")!.classList.contains("switches-disabled")).toBe(true);
  });

  it("sends nothing for a click on a toggle, armed or not", async () => {
    const { root } = await mount(topology(BLOCKED));
    const slide = root.querySelector<HTMLElement>(".slide-confirm")!;
    root.querySelector<HTMLElement>('[data-uuid="kitchen"] .toggle-pill')!.click();
    // Even were the slider armed some other way, the toggle says no.
    slide.classList.add("confirmed");
    root.querySelector<HTMLElement>('[data-uuid="kitchen"] .toggle-pill')!.click();
    await flush();
    expect(controlSends).toEqual([]);
  });

  it("keeps the gear, whose side panel draws the relay and priority disabled, saying why", async () => {
    const { root } = await mount(topology(BLOCKED));
    const sidePanel = await openSidePanel(root, "kitchen");
    expect(sideRelay(sidePanel).disabled).toBe(true);
    expect(sidePanel.shadowRoot!.querySelector<HTMLSelectElement>('[data-role="shedding-select"]')!.disabled).toBe(true);
    expect(sidePanel.shadowRoot!.querySelector('[data-role="controls-note"]')!.textContent).toBe(ADMIN_ONLY_HINT);
  });

  it("keeps the toggles forbidden on each live update", async () => {
    const { card, root } = await mount(topology(BLOCKED));
    card.hass = { ...card.hass, states: { ...STATES, [SWITCH]: state(SWITCH, "off") } };
    await flush();
    const kitchen = root.querySelector('[data-uuid="kitchen"] .toggle-pill')!;
    expect(kitchen.classList.contains("toggle-off")).toBe(true);
    expect(kitchen.classList.contains("toggle-forbidden")).toBe(true);
  });
});

describe("the card's By Panel view, for a user who may operate the panel's controls", () => {
  it.each([
    ["says so", ALLOWED],
    ["says nothing of it, as an older one does", undefined],
  ])("draws the toggles and Enable Switches as before where the integration %s", async (_says, access) => {
    const { root } = await mount(topology(access));
    for (const pill of pills(root)) {
      expect(pill.classList.contains("toggle-forbidden")).toBe(false);
      expect(pill.hasAttribute("title")).toBe(false);
    }
    const slide = root.querySelector<HTMLElement>(".slide-confirm")!;
    expect(slide.classList.contains("slide-confirm-forbidden")).toBe(false);
    expect(root.querySelector('[data-role="controls-note"]')).toBeNull();

    drag(slide);
    expect(slide.classList.contains("confirmed")).toBe(true);
    root.querySelector<HTMLElement>('[data-uuid="kitchen"] .toggle-pill')!.click();
    await flush();
    expect(controlSends.map(msg => [msg.domain, msg.service])).toEqual([["switch", "turn_off"]]);
  });
});

describe("the card's list views, for a user who may not operate the panel's controls", () => {
  it.each(["activity", "area"])("draw every row's toggle forbidden on By %s, with Enable Switches forbidden", async tab => {
    const { root } = await mount(topology(BLOCKED));
    root.querySelector<HTMLElement>(`#card-tabs [data-tab="${tab}"]`)!.click();
    await vi.waitFor(() => expect(root.querySelector(".list-row")).not.toBeNull());

    const drawn = pills(root);
    expect(drawn.length).toBeGreaterThan(0);
    for (const pill of drawn) expect(pill.classList.contains("toggle-forbidden")).toBe(true);
    expect(root.querySelector(".slide-confirm")!.classList.contains("slide-confirm-forbidden")).toBe(true);

    for (const pill of drawn) pill.click();
    await flush();
    expect(controlSends).toEqual([]);
  });
});

describe("the card, as the access the user has changes", () => {
  it("draws the toggles forbidden once a refresh says the user may no longer operate them, and as before once it says they may", async () => {
    const { connection, root } = await mount(topology(ALLOWED));
    mockDiscover.mockImplementation(async () => ({ topology: topology(BLOCKED), panelDevice: null, panelSize: 32 }));
    reload(connection);
    await vi.waitFor(() => expect(root.querySelector(".toggle-pill.toggle-forbidden")).not.toBeNull());
    expect(root.querySelector(".slide-confirm")!.classList.contains("slide-confirm-forbidden")).toBe(true);

    mockDiscover.mockImplementation(async () => ({ topology: topology(ALLOWED), panelDevice: null, panelSize: 32 }));
    reload(connection);
    await vi.waitFor(() => expect(root.querySelector(".toggle-pill.toggle-forbidden")).toBeNull());
    expect(root.querySelector(".slide-confirm")!.classList.contains("slide-confirm-forbidden")).toBe(false);
    expect(root.querySelector('[data-role="controls-note"]')).toBeNull();
  });

  it("gives an open side panel the new access, which disables its relay without closing it", async () => {
    const { connection, root } = await mount(topology(ALLOWED));
    const sidePanel = await openSidePanel(root, "kitchen");
    expect(sideRelay(sidePanel).disabled).toBe(false);

    mockDiscover.mockImplementation(async () => ({ topology: topology({ may_operate: false, reason: "control_disabled" }), panelDevice: null, panelSize: 32 }));
    reload(connection);

    await vi.waitFor(() => expect(sideRelay(sidePanel).disabled).toBe(true));
    expect(sidePanel.hasAttribute("open")).toBe(true);
    expect(sidePanel.shadowRoot!.querySelector('[data-role="controls-note"]')!.textContent).toBe("Control of this panel is switched off in its options.");
  });
});

describe("the live updates of a view's toggles", () => {
  const hass = { states: STATES, services: {}, language: "en", callWS: async () => ({}) } as unknown as HomeAssistant;
  const config = {} as CardConfig;

  it("draw a grid slot's toggle forbidden, or as before, as the topology says", () => {
    const root = document.createElement("div");
    const blocked = topology(BLOCKED);
    root.innerHTML = renderCircuitSlot("kitchen", blocked.circuits.kitchen!, 1, "1", "single", hass, config, null, "never", CONTROLS_OPERABLE);
    updateCircuitDOM(root, hass, blocked, config, new Map(), undefined, null);
    expect(root.querySelector(".toggle-pill")!.classList.contains("toggle-forbidden")).toBe(true);
    updateCircuitDOM(root, hass, topology(), config, new Map(), undefined, null);
    expect(root.querySelector(".toggle-pill")!.classList.contains("toggle-forbidden")).toBe(false);
  });

  it("draw a list row's toggle forbidden, or as before, as the topology says", () => {
    const container = document.createElement("div");
    const list = new ListViewController(new DashboardController());
    list.renderActivityView(container, hass, topology(), config, null, "");
    expect(container.querySelector(".toggle-pill.toggle-forbidden")).toBeNull();
    list.updateCollapsedRows(container, hass, topology(BLOCKED), config);
    expect(container.querySelectorAll(".toggle-pill.toggle-forbidden")).toHaveLength(2);
  });
});

describe("Enable Switches", () => {
  it("is not drawn where the view has no switches to arm", () => {
    const html = buildHeaderHTML(topology(BLOCKED), {} as CardConfig, { showSwitches: false });
    expect(html).not.toContain("slide-confirm");
    expect(html).not.toContain("controls-note");
  });

  it("drawn forbidden, is left unbound, so no drag arms it", () => {
    const host = document.createElement("div");
    host.innerHTML = buildSlideConfirmHTML(ADMIN_ONLY);
    const slide = host.querySelector<HTMLElement>(".slide-confirm")!;
    const parent = document.createElement("div");
    parent.classList.add("switches-disabled");
    new DashboardController().bindSlideConfirm(slide, parent);
    drag(slide);
    expect(slide.classList.contains("confirmed")).toBe(false);
    expect(parent.classList.contains("switches-disabled")).toBe(true);
  });
});

describe("the Favorites view's circuits", () => {
  it("each keep the access their own panel gives", async () => {
    mockDiscover.mockImplementation(async (_hass, deviceId) => ({
      topology: deviceId === "panel-1" ? topology(BLOCKED) : topology(),
      panelDevice: null,
      panelSize: 32,
    }));
    const panels = [
      { id: "panel-1", name: "One", config_entry_id: "entry-1", identifiers: [], via_device_id: null },
      { id: "panel-2", name: "Two", config_entry_id: "entry-2", identifiers: [], via_device_id: null },
    ];
    const favorites = { "panel-1": { circuits: ["kitchen"], sub_devices: [] }, "panel-2": { circuits: ["kitchen"], sub_devices: [] } };

    const { topology: merged } = await new FavoritesController().build({} as HomeAssistant, favorites, panels);

    expect(merged._favoriteRefs["panel-1|kitchen"]?.controlAccess).toEqual(ADMIN_ONLY);
    expect(merged._favoriteRefs["panel-2|kitchen"]?.controlAccess).toEqual(CONTROLS_OPERABLE);
  });
});
