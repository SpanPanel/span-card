import { describe, it, expect, afterEach, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { ErrorStore } from "../src/core/error-store.js";
import "../src/core/side-panel.js";
import type { Circuit, HassEntity, HomeAssistant, MonitoringPointInfo } from "../src/types.js";

// The integration lets only a Home Assistant administrator change a panel's
// monitoring. These show the Monitoring tab and a circuit's Monitoring section
// saying so where the integration refuses a change, and drawn read-only for
// anyone else.

type Message = Record<string, unknown>;

const ADMIN_ONLY = "Only an administrator can change monitoring.";
/** What the integration answers a logged-in user who is not an administrator, through the websocket's call_service. */
const UNAUTHORIZED = { code: "home_assistant_error", message: "Unauthorized" };
/** The integration's monitoring services that change something, which it refuses anyone but an administrator. */
const WRITE_SERVICES = new Set([
  "set_global_monitoring",
  "set_circuit_threshold",
  "clear_circuit_threshold",
  "set_mains_threshold",
  "clear_mains_threshold",
  "set_circuit_package_ratings",
  "clear_circuit_package_ratings",
  "test_notification",
]);

const GLOBALS = { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 };
/** Synthetic circuits, by entity id: a copy that applies, one kept on averaged legs, and one with thresholds of its own and monitoring off. */
const OVEN = "sensor.oven_current";
const DRYER = "sensor.washer_dryer_current";
const GARAGE = "sensor.garage_current";
const MAINS = "sensor.span_panel_current_power";
const PHONE = "notify.mobile_app_phone";

function point(name: string, extra: Partial<MonitoringPointInfo> = {}): MonitoringPointInfo {
  return { name, monitoring_enabled: true, has_override: false, breaker_rating_a: 20, monitoring_rating_a: 20, ...GLOBALS, ...extra };
}

/** One panel's monitoring as the integration reports it, every kind of control the tab draws called for. */
function status(offered: boolean): Message {
  return {
    enabled: true,
    monitoring_rating_offered: offered,
    global_settings: {
      ...GLOBALS,
      notify_targets: PHONE,
      notification_priority: "active",
      notification_title_template: "SPAN: {name}",
      notification_message_template: "{name} at {current_a}A",
    },
    circuits: {
      [OVEN]: point("Oven", {
        point_id: "circuit-2",
        package_ratings_form: "one_space",
        package_ratings_a: [20, 20],
        package_ratings_state: "applies",
        monitoring_rating_a: 40,
        monitoring_rating_user_set: true,
      }),
      [DRYER]: point("Washer Dryer", {
        point_id: "circuit-18",
        package_ratings_form: "two_spaces",
        package_ratings_a: [20, 30],
        package_ratings_state: "averaged_legs",
      }),
      [GARAGE]: point("Garage", { point_id: "circuit-7", monitoring_enabled: false, has_override: true, continuous_threshold_pct: 90 }),
    },
    mains: { [MAINS]: point("Mains", { has_override: true, breaker_rating_a: 200, monitoring_rating_a: 200 }) },
  };
}

interface Integration {
  hass: HomeAssistant;
  /** Every service called, the status reads among them, in the order sent. */
  sent: string[];
  /** The monitoring changes among them. */
  writes: () => string[];
}

/**
 * Home Assistant for a user who is `user`, with one panel's monitoring, which
 * offers copies of package ratings unless `offered` is false: every change is
 * stored, or refused with `refusal` where one is given.
 */
function integration(user: HomeAssistant["user"], { offered = true, refusal = null as unknown } = {}): Integration {
  const sent: string[] = [];
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    if (typeof msg.service === "string") sent.push(msg.service);
    if (msg.service === "get_monitoring_status") return { response: status(offered) };
    if (refusal !== null) throw refusal;
    return {};
  });
  const phone: HassEntity = { entity_id: PHONE, state: "unknown", attributes: {}, last_changed: "", last_updated: "" };
  const hass = { states: { [PHONE]: phone }, services: {}, language: "en", user, callService: async () => undefined, callWS } as unknown as HomeAssistant;
  return { hass, sent, writes: () => sent.filter(service => WRITE_SERVICES.has(service)) };
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The tab drawn as the dashboard draws it, in a container inside the panel's shadow root. */
async function shown(panel: Integration, errors = new ErrorStore()): Promise<{ tab: MonitoringTab; container: HTMLElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  const container = document.createElement("div");
  host.attachShadow({ mode: "open" }).appendChild(container);
  const tab = new MonitoringTab();
  tab.errorStore = errors;
  await tab.render(container, panel.hass, "entry-1");
  return { tab, container };
}

const at = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`nothing drawn at ${selector}`);
  return el;
};
const cell = (c: HTMLElement, entity: string, field: string): HTMLInputElement =>
  at<HTMLInputElement>(c, `.threshold-input[data-entity="${entity}"][data-field="${field}"]`);
const messages = (errors: ErrorStore): string[] => errors.active.map(e => e.message);

// ── A change the integration refuses as Unauthorized ─────────────────────

describe("the Monitoring tab, where the integration refuses a change as Unauthorized", () => {
  /** An administrator's view drawn before the user's rights were withdrawn: the integration now refuses each change. */
  async function refused(): Promise<{ container: HTMLElement; errors: ErrorStore }> {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = new ErrorStore();
    const { container } = await shown(integration({ is_admin: true }, { refusal: UNAUTHORIZED }), errors);
    return { container, errors };
  }

  it("says so beside the global settings, the Enabled switch put back", async () => {
    const { container } = await refused();
    const enabled = at<HTMLInputElement>(container, "#monitoring-enabled");
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(at(container, "#global-status").textContent).toBe(`Error: ${ADMIN_ONLY}`));
    expect(enabled.checked).toBe(true);
  });

  it("says so for a circuit's switch, put back as it was", async () => {
    const { container, errors } = await refused();
    const toggle = at<HTMLInputElement>(container, `.circuit-toggle[data-entity="${OVEN}"]`);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
    expect(toggle.checked).toBe(true);
  });

  it("says so for a point's Reset, and for a copy's ✕", async () => {
    const { container, errors } = await refused();
    at(container, `.reset-btn[data-entity="${MAINS}"]`).click();
    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));

    errors.clear();
    at(container, `.rating-clear[data-entity="${OVEN}"]`).click();
    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
  });

  it("says so for a threshold entered", async () => {
    const { container, errors } = await refused();
    const field = cell(container, OVEN, "spike_threshold_pct");
    field.value = "120";
    field.dispatchEvent(new Event("input"));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
  });

  it("says so for the notification priority, put back as stored", async () => {
    const { container, errors } = await refused();
    const priority = at<HTMLSelectElement>(container, "#g-priority");
    priority.value = "critical";
    priority.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
    expect(priority.value).toBe("active");
  });

  it("says so for the test notification, beside its button", async () => {
    const { container } = await refused();
    at(container, "#test-notification-btn").click();

    await vi.waitFor(() => expect(at(container, "#test-notification-status").textContent).toBe(`Error: ${ADMIN_ONLY}`));
  });
});

type SidePanel = HTMLElement & {
  hass: HomeAssistant | null;
  errorStore: ErrorStore | null;
  open(config: unknown): void;
  refreshRating(view: unknown): void;
  useGlobalThresholds(): Promise<boolean>;
};

/** A MAIN 32 circuit in one space, holding `copied` as its copy where one is given. */
function oven(copied: number[] | null): Circuit {
  return {
    name: "Oven",
    tabs: [1],
    entities: {},
    breaker_rating_a: 20,
    monitoring_rating_a: copied ? 40 : 20,
    monitoring_rating_user_set: copied !== null,
    package_ratings_a: copied,
    package_ratings_form: "one_space",
    package_ratings_state: copied ? "applies" : null,
  };
}

/**
 * The circuit's side panel as the sidebar dashboard opens it on a MAIN 32: its
 * Monitoring section shown, package ratings offered, with `config` over what the
 * dashboard gives it. `panel` is null for a side panel given no Home Assistant.
 */
function openPanel(
  panel: Integration | null,
  circuit: Circuit,
  monitoringInfo: Partial<MonitoringPointInfo>,
  { errors = new ErrorStore(), config = {} }: { errors?: ErrorStore; config?: Record<string, unknown> } = {}
): SidePanel {
  const side = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(side);
  mounted.push(side);
  side.hass = panel?.hass ?? null;
  side.errorStore = errors;
  side.open({
    uuid: "c-1",
    name: circuit.name,
    entities: {},
    showMonitoring: true,
    monitoringRatingOffered: true,
    monitoringInfo,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
    members: [{ uuid: "c-1", circuit }],
    capacityA: null,
    configEntryId: "entry-1",
    ...config,
  });
  return side;
}

/** The Oven's monitoring with its copy of 20-20 applied and thresholds of its own above 100%, which the editor warns of. */
const OWN_THRESHOLDS: Partial<MonitoringPointInfo> = {
  monitoring_enabled: true,
  has_override: true,
  breaker_rating_a: 20,
  monitoring_rating_a: 40,
  monitoring_rating_user_set: true,
  package_ratings_a: [20, 20],
  package_ratings_state: "applies",
  ...GLOBALS,
  continuous_threshold_pct: 120,
};

describe("a circuit's Monitoring section, where the integration refuses a change as Unauthorized", () => {
  it("says only an administrator can change monitoring, for the copy's reset and the reset to the global thresholds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = new ErrorStore();
    const side = openPanel(integration({ is_admin: true }, { refusal: UNAUTHORIZED }), oven([20, 20]), OWN_THRESHOLDS, { errors });

    at(side.shadowRoot!, '[data-role="rating-reset"]').click();
    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));

    errors.clear();
    at(side.shadowRoot!, '[data-role="rating-threshold-reset"]').click();
    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
  });

  it("says so for the Monitoring switch, which shows monitoring as it was again, the details under it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = new ErrorStore();
    const side = openPanel(integration({ is_admin: true }, { refusal: UNAUTHORIZED }), oven([20, 20]), OWN_THRESHOLDS, { errors });
    const toggle = at<HTMLElement & { checked: boolean }>(side.shadowRoot!, '[data-role="monitoring-toggle"]');
    const details = at(side.shadowRoot!, '[data-role="monitoring-details"]');

    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(details.style.display).toBe("none");

    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
    expect(toggle.hasAttribute("checked")).toBe(true);
    expect(details.style.display).toBe("block");
  });
});

describe("a circuit's Monitoring section, before it is given Home Assistant", () => {
  it("refuses a change, saying why, rather than taking it as stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errors = new ErrorStore();
    const side = openPanel(null, oven([20, 20]), OWN_THRESHOLDS, { errors });

    expect(await side.useGlobalThresholds()).toBe(false);
    expect(messages(errors)).toEqual([ADMIN_ONLY]);
    expect(at<HTMLInputElement>(side.shadowRoot!, 'input[name="monitoring-mode"][value="custom"]').checked).toBe(true);
  });
});

// ── Read-only for a user who is not an administrator ─────────────────────

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Every control of the tab's that changes monitoring, by the selector that finds it. */
const TAB_CONTROLS = [
  "#monitoring-enabled",
  "#g-continuous",
  "#g-spike",
  "#g-window",
  "#g-cooldown",
  "#notify-all-targets",
  "#notify-target-btn",
  ".notify-target-cb",
  "#g-priority",
  "#g-title-template",
  "#g-message-template",
  "#test-notification-btn",
  "#toggle-all-circuits",
  ".circuit-toggle",
  ".mains-toggle",
  ".threshold-input",
  ".rating-input",
  ".rating-clear",
  ".rating-turn-off",
  ".reset-btn",
];
/** The tab's controls whose value is read as text, made read-only rather than disabled. */
const TAB_FIELDS = "#g-continuous, #g-spike, #g-window, #g-cooldown, #g-title-template, #g-message-template, .threshold-input, .rating-input";

/**
 * Use every control in `root` as a user would, its lock aside: type and commit
 * in each field and leave it, change each choice, press each button.
 */
async function useEveryControl(root: ParentNode): Promise<void> {
  for (const control of [...root.querySelectorAll<HTMLElement>("input, select, button, span-switch")]) {
    if (control instanceof HTMLInputElement && (control.type === "number" || control.type === "text")) {
      control.focus();
      control.value = control.type === "number" ? "42" : "typed";
      control.dispatchEvent(new Event("input"));
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      control.blur();
    } else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
      if (control instanceof HTMLInputElement) control.checked = !control.checked;
      control.dispatchEvent(new Event("change"));
    } else {
      control.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    }
  }
  await vi.advanceTimersByTimeAsync(5000);
}

describe("the Monitoring tab, for a user who is not an administrator", () => {
  it("shows every setting as it stands, with a note under the heading saying only an administrator can change them", async () => {
    const { container } = await shown(integration({ is_admin: false }));

    const note = at(container, '[data-role="monitoring-read-only"]');
    expect(note.textContent).toBe(ADMIN_ONLY);
    expect(note.getAttribute("role")).toBe("note");
    expect(note.previousElementSibling?.tagName).toBe("H2");

    expect(at<HTMLInputElement>(container, "#monitoring-enabled").checked).toBe(true);
    expect(at<HTMLInputElement>(container, "#g-continuous").value).toBe("80");
    // The option drawn chosen: happy-dom's select reads another option's value straight after parsing.
    expect(at(container, '#g-priority option[value="active"]').hasAttribute("selected")).toBe(true);
    expect(at<HTMLInputElement>(container, "#g-title-template").value).toBe("SPAN: {name}");
    expect(at(container, "#notify-target-label").textContent).toBe(PHONE);
    expect(cell(container, GARAGE, "continuous_threshold_pct").value).toBe("90");
    expect(at<HTMLInputElement>(container, `.circuit-toggle[data-entity="${GARAGE}"]`).checked).toBe(false);
    expect(at<HTMLInputElement>(container, `.rating-input[data-entity="${OVEN}"]`).value).toBe("20");
    expect(at(container, `.rating-turn-off[data-entity="${DRYER}"]`)).toBeTruthy();
    expect(at(container, `.reset-btn[data-entity="${MAINS}"]`)).toBeTruthy();
  });

  it("locks every control that changes monitoring: its fields read-only, every other control disabled, each titled with why", async () => {
    const { container } = await shown(integration({ is_admin: false }));

    for (const selector of TAB_CONTROLS) {
      const controls = [...container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector)];
      expect(controls.length, selector).toBeGreaterThan(0);
      for (const control of controls) {
        const field = control.matches(TAB_FIELDS);
        expect(control instanceof HTMLInputElement && control.readOnly, selector).toBe(field);
        expect(control.disabled, selector).toBe(!field);
        expect(control.title, selector).toBe(ADMIN_ONLY);
        expect(control.style.opacity, selector).toBe("0.5");
      }
    }
    // Nothing the settings draw is left usable.
    const settings = at(container, ".monitoring-settings");
    const usable = [...settings.querySelectorAll<HTMLInputElement>("input, select, button")].filter(control => !control.disabled && !control.readOnly);
    expect(usable).toEqual([]);
  });

  it("sends no change whatever is done to its controls, nor as the tab is left", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = integration({ is_admin: false });
    const { tab, container } = await shown(panel);

    await useEveryControl(at(container, ".monitoring-settings"));
    tab.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(panel.writes()).toEqual([]);
    expect(panel.sent).toContain("get_monitoring_status");
  });

  it("leaves the rating marks usable, as they only show where a rating comes from", async () => {
    // A panel not offering copies draws the Oven's copied rating with its mark rather than a field.
    const { container } = await shown(integration({ is_admin: false }, { offered: false }));
    const mark = at<HTMLButtonElement>(container, ".rating-user-set");

    expect(mark.disabled).toBe(false);
    expect(mark.title).not.toBe(ADMIN_ONLY);
    mark.click();
    expect(mark.getAttribute("aria-expanded")).toBe("true");
  });

  it("is read-only too for a user the frontend says nothing of", async () => {
    const { container } = await shown(integration(undefined));
    expect(container.querySelector('[data-role="monitoring-read-only"]')).not.toBeNull();
    expect(at<HTMLInputElement>(container, "#monitoring-enabled").disabled).toBe(true);
  });
});

describe("the Monitoring tab, for an administrator", () => {
  it("draws no note, and every control usable", async () => {
    const { container } = await shown(integration({ is_admin: true }));

    expect(container.querySelector('[data-role="monitoring-read-only"]')).toBeNull();
    for (const selector of TAB_CONTROLS) {
      for (const control of container.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(selector)) {
        expect(control.disabled, selector).toBe(false);
        expect(control instanceof HTMLInputElement && control.readOnly, selector).toBe(false);
        expect(control.title, selector).not.toBe(ADMIN_ONLY);
      }
    }
  });

  it("sends a change the user makes", async () => {
    const panel = integration({ is_admin: true });
    const { container } = await shown(panel);

    const toggle = at<HTMLInputElement>(container, `.circuit-toggle[data-entity="${GARAGE}"]`);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await settle();

    expect(panel.writes()).toEqual(["set_circuit_threshold"]);
  });

  it("sends every kind of change from the controls a user who is not an administrator cannot use", async () => {
    vi.useFakeTimers();
    const panel = integration({ is_admin: true });
    const { container } = await shown(panel);

    await useEveryControl(at(container, ".monitoring-settings"));

    expect(new Set(panel.writes())).toEqual(WRITE_SERVICES);
  });
});

/** A MAIN 32 circuit across two spaces, its copy kept on averaged legs. */
const DRYER_CIRCUIT: Circuit = {
  name: "Washer Dryer",
  tabs: [3, 5],
  entities: {},
  breaker_rating_a: 20,
  monitoring_rating_a: 20,
  monitoring_rating_user_set: false,
  package_ratings_a: [20, 30],
  package_ratings_form: "two_spaces",
  package_ratings_state: "averaged_legs",
};

const monitoringSection = (side: SidePanel): HTMLElement => at(side.shadowRoot!, '[data-role="monitoring-section"]');

describe("a circuit's Monitoring section, for a user who is not an administrator", () => {
  it("shows what monitoring is set to, with a note under the switch saying only an administrator can change it", () => {
    const side = openPanel(integration({ is_admin: false }), oven([20, 20]), OWN_THRESHOLDS);
    const section = monitoringSection(side);

    const note = at(section, '[data-role="monitoring-read-only"]');
    expect(note.textContent).toBe(ADMIN_ONLY);
    expect(note.previousElementSibling?.classList.contains("monitoring-header")).toBe(true);
    expect(at(section, '[data-role="monitoring-toggle"]').hasAttribute("checked")).toBe(true);
    expect(at(section, '[data-role="judged-against"]').textContent).toBe("Judged against 40 A: 20-20 from your SPAN app (the panel publishes 20 A)");
    expect(at<HTMLInputElement>(section, 'input[name="monitoring-mode"][value="custom"]').checked).toBe(true);
    expect(at<HTMLInputElement>(section, '[data-role="threshold-continuous"]').value).toBe("120");
    expect(at<HTMLInputElement>(section, '[data-role="rating-input"]').value).toBe("20");
  });

  it("says why while monitoring is off and the details are hidden", () => {
    const side = openPanel(integration({ is_admin: false }), oven(null), { monitoring_enabled: false });
    expect(at(monitoringSection(side), '[data-role="monitoring-details"]').style.display).toBe("none");
    expect(at(monitoringSection(side), '[data-role="monitoring-read-only"]').textContent).toBe(ADMIN_ONLY);
  });

  it("locks the switch, the Global/Custom choice, the thresholds, and the package ratings editor's field, reset and warning buttons", () => {
    const side = openPanel(integration({ is_admin: false }), oven([20, 20]), OWN_THRESHOLDS);
    const section = monitoringSection(side);

    expect(at(section, '[data-role="monitoring-toggle"]').hasAttribute("disabled")).toBe(true);
    for (const radio of section.querySelectorAll<HTMLInputElement>('input[name="monitoring-mode"]')) expect(radio.disabled).toBe(true);
    const thresholds = [...section.querySelectorAll<HTMLInputElement>('input[data-role^="threshold-"]')];
    expect(thresholds).toHaveLength(4);
    for (const field of thresholds) expect(field.readOnly).toBe(true);
    expect(at<HTMLInputElement>(section, '[data-role="rating-input"]').readOnly).toBe(true);
    expect(at<HTMLButtonElement>(section, '[data-role="rating-reset"]').disabled).toBe(true);
    expect(at<HTMLButtonElement>(section, '[data-role="rating-threshold-reset"]').disabled).toBe(true);
    for (const control of section.querySelectorAll<HTMLElement>("input, button, span-switch")) expect(control.title).toBe(ADMIN_ONLY);
  });

  it("locks the averaged-legs warning's button", () => {
    const side = openPanel(integration({ is_admin: false }), DRYER_CIRCUIT, { monitoring_enabled: true });
    expect(at<HTMLButtonElement>(monitoringSection(side), '[data-role="rating-turn-off-monitoring"]').disabled).toBe(true);
  });

  it("locks what a refresh draws: the reset a copy stored elsewhere brings", () => {
    const side = openPanel(integration({ is_admin: false }), oven(null), { monitoring_enabled: true });
    expect(side.shadowRoot!.querySelector('[data-role="rating-reset"]')).toBeNull();

    side.refreshRating({
      members: [{ uuid: "c-1", circuit: oven([20, 20]) }],
      capacityA: null,
      monitoringInfo: { monitoring_enabled: true },
      monitoringGlobals: null,
    });

    const reset = at<HTMLButtonElement>(monitoringSection(side), '[data-role="rating-reset"]');
    expect(reset.disabled).toBe(true);
    expect(reset.title).toBe(ADMIN_ONLY);
  });

  it("sends no change whatever is done to its controls", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = integration({ is_admin: false });
    const side = openPanel(panel, oven([20, 20]), OWN_THRESHOLDS);

    await useEveryControl(monitoringSection(side));

    expect(panel.writes()).toEqual([]);
  });

  it("leaves the rest of the side panel as it is: the graph horizon stays usable", () => {
    const side = openPanel(integration({ is_admin: false }), oven(null), { monitoring_enabled: true });
    const segments = [...side.shadowRoot!.querySelectorAll<HTMLButtonElement>(".horizon-segment")];
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.disabled).toBe(false);
      expect(segment.title).not.toBe(ADMIN_ONLY);
    }
  });
});

describe("a circuit's Monitoring section, for an administrator", () => {
  it("draws no note, and its controls usable", () => {
    const side = openPanel(integration({ is_admin: true }), oven([20, 20]), OWN_THRESHOLDS);
    const section = monitoringSection(side);

    expect(section.querySelector('[data-role="monitoring-read-only"]')).toBeNull();
    expect(at(section, '[data-role="monitoring-toggle"]').hasAttribute("disabled")).toBe(false);
    for (const control of section.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) {
      expect(control.disabled).toBe(false);
      expect(control instanceof HTMLInputElement && control.readOnly).toBe(false);
    }
  });

  it("sends each change its controls make, from the controls a user who is not an administrator cannot use", async () => {
    vi.useFakeTimers();
    const panel = integration({ is_admin: true });
    const side = openPanel(panel, oven([20, 20]), OWN_THRESHOLDS);

    await useEveryControl(monitoringSection(side));

    expect(new Set(panel.writes())).toEqual(
      new Set(["set_circuit_threshold", "clear_circuit_threshold", "set_circuit_package_ratings", "clear_circuit_package_ratings"])
    );
  });
});
