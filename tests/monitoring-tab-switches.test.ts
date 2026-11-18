import { describe, it, expect, afterEach, vi } from "vitest";
import { MonitoringTab } from "../src/panel/tab-monitoring.js";
import { ErrorStore } from "../src/core/error-store.js";
import type { HomeAssistant, MonitoringPointInfo } from "../src/types.js";

// The Monitoring tab's switches after changes the integration refuses: each
// shows what the integration holds once its changes settle, never the opposite
// of the last click, however many were sent in a row.

type Message = Record<string, unknown>;

const ADMIN_ONLY = "Only an administrator can change monitoring.";
/** What the integration answers a user who may not make a change, through the websocket's call_service. */
const UNAUTHORIZED = { code: "home_assistant_error", message: "Unauthorized" };
const GLOBALS = { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 };
const OVEN = "sensor.oven_current";
const MAINS = "sensor.span_panel_current_power";

/** Whether monitoring is on, as the integration holds it: for the panel, the Oven, and the mains. */
interface Stored {
  enabled: boolean;
  oven: boolean;
  mains: boolean;
}

interface Integration {
  hass: HomeAssistant;
  /** What the integration holds, which a test may change as another browser would. */
  stored: Stored;
  /** Refuse every later change, as Unauthorized, while `on`; store each otherwise. */
  refuse(on: boolean): void;
}

function point(name: string, on: boolean): MonitoringPointInfo {
  return { name, monitoring_enabled: on, has_override: !on, breaker_rating_a: 20, monitoring_rating_a: 20, ...GLOBALS };
}

/**
 * One panel's monitoring as the integration holds it, for an administrator: a
 * change it stores turns monitoring on or off for the panel, the Oven or the
 * mains, and the status reads it.
 */
function integration(): Integration {
  const stored: Stored = { enabled: true, oven: true, mains: true };
  let refusing = false;
  const callWS = vi.fn(async (msg: Message): Promise<unknown> => {
    if (msg.service === "get_monitoring_status") {
      return {
        response: {
          enabled: stored.enabled,
          global_settings: GLOBALS,
          circuits: { [OVEN]: point("Oven", stored.oven) },
          mains: { [MAINS]: point("Mains", stored.mains) },
        },
      };
    }
    if (refusing) throw UNAUTHORIZED;
    const data = (msg.service_data ?? {}) as Message;
    const on = data.monitoring_enabled;
    if (msg.service === "set_circuit_threshold" && data.circuit_id === OVEN && typeof on === "boolean") stored.oven = on;
    if (msg.service === "set_mains_threshold" && data.leg === MAINS && typeof on === "boolean") stored.mains = on;
    // Turning monitoring on sends the global thresholds; turning it off says so.
    if (msg.service === "set_global_monitoring") stored.enabled = data.enabled !== false;
    return {};
  });
  const hass = { states: {}, services: {}, language: "en", user: { is_admin: true }, callService: async () => undefined, callWS } as unknown as HomeAssistant;
  return { hass, stored, refuse: on => (refusing = on) };
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
});

/** The tab drawn as the dashboard draws it, in a container inside the panel's shadow root. */
async function shown(panel: Integration): Promise<{ tab: MonitoringTab; container: HTMLElement; errors: ErrorStore }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  mounted.push(host);
  const container = document.createElement("div");
  host.attachShadow({ mode: "open" }).appendChild(container);
  const tab = new MonitoringTab();
  const errors = new ErrorStore();
  tab.errorStore = errors;
  await tab.render(container, panel.hass, "entry-1");
  return { tab, container, errors };
}

/** Every answer, and every read and redraw each brings, handled. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Each of the tab's switches, by what it is, where it is drawn, and what it turns on or off. */
const SWITCHES = [
  ["a circuit's switch", `.circuit-toggle[data-entity="${OVEN}"]`, "oven"],
  ["the mains' switch", `.mains-toggle[data-entity="${MAINS}"]`, "mains"],
  ["the Enabled switch", "#monitoring-enabled", "enabled"],
] as const;

describe.each(SWITCHES)("%s", (_what, selector, key) => {
  /** The switch as drawn now: a read of the tab draws it afresh. */
  const switchIn = (container: HTMLElement): HTMLInputElement => {
    const el = container.querySelector<HTMLInputElement>(selector);
    if (!el) throw new Error(`nothing drawn at ${selector}`);
    return el;
  };
  /** Turn the switch, as drawn now, to `on`, as a click does. */
  function turn(container: HTMLElement, on: boolean): void {
    const el = switchIn(container);
    el.checked = on;
    el.dispatchEvent(new Event("change"));
  }

  it("shows what is stored where two changes in a row are both refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = integration();
    const { container } = await shown(panel);
    panel.refuse(true);

    turn(container, false);
    turn(container, true);
    await settle();

    expect(switchIn(container).checked).toBe(true);
    expect(panel.stored[key]).toBe(true);
  });

  it("shows the change stored where the two after it are refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = integration();
    const { container } = await shown(panel);

    turn(container, false);
    await settle();
    expect(panel.stored[key]).toBe(false);

    panel.refuse(true);
    turn(container, true);
    turn(container, false);
    await settle();

    expect(switchIn(container).checked).toBe(false);
  });

  it("shows what a refresh read where the changes after it are refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = integration();
    const { tab, container } = await shown(panel);
    // Another browser turns it off, and the tab is read again, as an event for its panel makes it.
    panel.stored[key] = false;
    await tab.render(container, panel.hass);
    expect(switchIn(container).checked).toBe(false);

    panel.refuse(true);
    turn(container, true);
    turn(container, false);
    await settle();

    expect(switchIn(container).checked).toBe(false);
  });
});

describe("the Enabled switch, refused", () => {
  it("dims the global fields as stored, and says why beside them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const panel = integration();
    const { container } = await shown(panel);
    panel.refuse(true);

    const enabled = container.querySelector<HTMLInputElement>("#monitoring-enabled")!;
    enabled.checked = false;
    enabled.dispatchEvent(new Event("change"));
    await settle();

    expect(container.querySelector<HTMLElement>("#global-fields")!.style.opacity).toBe("");
    expect(container.querySelector("#global-status")!.textContent).toBe(`Error: ${ADMIN_ONLY}`);
  });
});
