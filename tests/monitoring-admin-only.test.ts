import { describe, it, expect, afterEach, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { ErrorStore } from "../src/core/error-store.js";
import "../src/core/side-panel.js";
import type { Circuit, HassEntity, HomeAssistant, MonitoringPointInfo } from "../src/types.js";

// The integration lets only a Home Assistant administrator change a panel's
// monitoring. These show the Monitoring tab and a circuit's Monitoring section
// saying so where the integration refuses a change.

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

  it("says so for the test notification, beside its button", async () => {
    const { container } = await refused();
    at(container, "#test-notification-btn").click();

    await vi.waitFor(() => expect(at(container, "#test-notification-status").textContent).toBe(`Error: ${ADMIN_ONLY}`));
  });
});

type SidePanel = HTMLElement & {
  hass: HomeAssistant;
  errorStore: ErrorStore | null;
  open(config: unknown): void;
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

/** The circuit's side panel as the sidebar dashboard opens it on a MAIN 32: its Monitoring section shown, package ratings offered. */
function openPanel(panel: Integration, circuit: Circuit, monitoringInfo: Partial<MonitoringPointInfo>, errors = new ErrorStore()): SidePanel {
  const side = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(side);
  mounted.push(side);
  side.hass = panel.hass;
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
    const side = openPanel(integration({ is_admin: true }, { refusal: UNAUTHORIZED }), oven([20, 20]), OWN_THRESHOLDS, errors);

    at(side.shadowRoot!, '[data-role="rating-reset"]').click();
    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));

    errors.clear();
    at(side.shadowRoot!, '[data-role="rating-threshold-reset"]').click();
    await vi.waitFor(() => expect(messages(errors)).toEqual([ADMIN_ONLY]));
  });
});
