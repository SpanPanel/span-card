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

function circuit(name: string, panel: number | null, effective: number | null, userSet = false): Circuit {
  return { name, tabs: [1], entities: {}, breaker_rating_a: effective, panel_breaker_rating_a: panel, breaker_rating_user_set: userSet };
}

interface Opened {
  panel: SidePanel;
  callWS: ReturnType<typeof vi.fn<CallWS>>;
  errors: ErrorStore;
}

function open(members: { uuid: string; circuit: Circuit }[], extra: Record<string, unknown> = { showBreakerRating: true }, callWS?: CallWS): Opened {
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
    tabs: [1],
    voltage: 240,
    entities: {},
    monitoringInfo: null,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
    members,
    configEntryId: "entry-1",
    ...extra,
  });
  return { panel, callWS: spy, errors };
}

const rows = (p: SidePanel): HTMLElement[] => [...p.shadowRoot!.querySelectorAll<HTMLElement>('[data-role="breaker-row"]')];
const input = (row: HTMLElement): HTMLInputElement => row.querySelector<HTMLInputElement>('[data-role="breaker-input"]')!;
const reset = (row: HTMLElement): HTMLElement | null => row.querySelector<HTMLElement>('[data-role="breaker-reset"]');

function type(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input"));
  vi.advanceTimersByTime(600);
}

const ONE = [{ uuid: "c-1", circuit: circuit("Oven", 30, 30) }];

describe("the Breaker section's visibility", () => {
  it("is absent unless the dashboard asks for it", () => {
    expect(rows(open(ONE, {}).panel)).toHaveLength(0);
    expect(rows(open(ONE, { showBreakerRating: false }).panel)).toHaveLength(0);
  });

  it("is absent for a circuit with no panel rating", () => {
    const { panel } = open([{ uuid: "c-1", circuit: circuit("Meter", null, null) }]);
    expect(rows(panel)).toHaveLength(0);
    expect(panel.shadowRoot!.querySelector('[data-role="breaker-section"]')).toBeNull();
  });

  it("is one row for a lone circuit", () => {
    const { panel } = open(ONE);
    expect(panel.shadowRoot!.querySelector('[data-role="breaker-section"]')).not.toBeNull();
    expect(rows(panel)).toHaveLength(1);
    expect(input(rows(panel)[0]!).value).toBe("30");
    expect(rows(panel)[0]!.textContent).toContain("30 A");
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
      service: "set_circuit_breaker_rating",
      service_data: { circuit_id: "c-b", breaker_rating_a: 13, config_entry_id: "entry-1" },
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
    expect(callWS.mock.calls[0]![0]).toMatchObject({ service_data: { breaker_rating_a: 40 } });
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
    const { panel } = open(ONE);
    type(input(rows(panel)[0]!), "50");
    expect(panel.shadowRoot!.querySelector(".panel-header")?.textContent ?? "").not.toContain("50");
    expect(rows(panel)[0]!.textContent).toContain("30 A");
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

  it("clears the correction of its own circuit", () => {
    const { panel, callWS } = open([
      { uuid: "c-a", circuit: circuit("Lights", 15, 15) },
      { uuid: "c-b", circuit: circuit("Outlets", 10, 12, true) },
    ]);
    reset(rows(panel)[1]!)!.click();
    expect(callWS).toHaveBeenCalledWith({
      type: "call_service",
      domain: "span_panel",
      service: "clear_circuit_breaker_rating",
      service_data: { circuit_id: "c-b", config_entry_id: "entry-1" },
    });
  });
});

describe("a refused change", () => {
  it("shows the service's message", async () => {
    const { panel, errors } = open(ONE, { showBreakerRating: true }, async () => {
      throw { code: "service_validation_error", message: "50 A is above the panel's 40 A service rating" };
    });
    type(input(rows(panel)[0]!), "50");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["50 A is above the panel's 40 A service rating"]);
  });

  it("falls back to the generic message when the error carries none", async () => {
    const { panel, errors } = open(ONE, { showBreakerRating: true }, async () => {
      throw new Error("");
    });
    type(input(rows(panel)[0]!), "50");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.active.map(e => e.message)).toEqual(["Unable to update breaker rating"]);
  });

  it("reports a failed reset the same way", async () => {
    const { panel, errors } = open([{ uuid: "c-1", circuit: circuit("Oven", 30, 50, true) }], { showBreakerRating: true }, async () => {
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

  async function opened(uuid: string, show: boolean): Promise<{ showBreakerRating?: boolean; members?: { uuid: string }[] }> {
    const ctrl = new DashboardController();
    if (show) ctrl.showBreakerRating = true;
    ctrl.init(
      TOPOLOGY,
      {} as CardConfig,
      hass(async () => undefined),
      "entry-1"
    );
    const root = document.createElement("div");
    root.innerHTML = `<button class="gear-icon circuit-gear" data-uuid="${uuid}"></button><span-side-panel></span-side-panel>`;
    document.body.appendChild(root);
    const sp = root.querySelector("span-side-panel") as unknown as { open: (config: unknown) => void };
    const spy = vi.spyOn(sp, "open").mockImplementation(() => {});
    await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);
    root.remove();
    return spy.mock.calls[0]![0] as { showBreakerRating?: boolean; members?: { uuid: string }[] };
  }

  it("is not asked to show the section by default (the standalone card)", async () => {
    expect((await opened("c-m", false)).showBreakerRating).toBe(false);
  });

  it("is asked once the dashboard enables it, passing a shared slot's every member with its id", async () => {
    const cfg = await opened("c-a", true);
    expect(cfg.showBreakerRating).toBe(true);
    expect(cfg.members?.map(m => m.uuid)).toEqual(["c-a", "c-b"]);
  });
});
