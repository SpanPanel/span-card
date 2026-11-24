import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { MockInstance } from "vitest";
import { Storage } from "happy-dom";
import type { DeviceRegistryEntry } from "../src/core/registry-types.js";
import type { AdoptedListResponse, HomeAssistant, PanelTopology } from "../src/types.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { ErrorStore } from "../src/core/error-store.js";
import { DashboardTab } from "../src/panel/tab-dashboard.js";
import { SpanPanelElement } from "../src/panel/span-panel.js";
import { DEVICE_REGISTRY, ENTRY_RELOADS, FakeConnection, hassWith } from "./fake-connection.js";
import { PANEL, PANEL_STATUS, SECOND_PANEL, SECOND_SPAN_ENTRY, SPAN_ENTRY, hassWithRegistries } from "./hass-registries.js";

/**
 * Until a panel's config entry has loaded, `panel_topology` gives no topology
 * for it, and `adopted/list` no rows: the integration answers `not_loaded`
 * while Home Assistant starts, while setup retries a panel it cannot reach, and
 * during a reload; Home Assistant answers `unknown_command` before the
 * integration has registered the command; and a lost connection rejects the
 * call. The sidebar dashboard then
 * says it is waiting for the panel to load, as the card does, with no error, no
 * retry and no toast, and draws the panel once its entry has loaded. Any other
 * refusal is shown as before.
 *
 * The integration answers `not_loaded` as well for an entry whose setup
 * failed, and for a disabled one, which no wait ends by itself. The entry
 * subscription says which it is, and the dashboard says so, and where to look,
 * and still draws the panel once the entry loads, as after a reauth.
 *
 * The dashboard's own list of panels comes from the device registry, which
 * only a lost connection keeps from it, as across a restart. It then waits too,
 * and lists the panels once the frontend hands it Home Assistant again.
 */

const NOT_LOADED = { code: "not_loaded", message: "SPAN Panel integration is not loaded" };
const UNKNOWN_COMMAND = { code: "unknown_command", message: "Unknown command." };
/** What home-assistant-js-websocket 9.8.0 rejects a command with when the connection is lost. */
const CONNECTION_LOST_RESULT = { type: "result", success: false, error: { code: 3, message: "Connection lost" } };
/** What the integration answers `get_monitoring_status` with for a panel whose entry has not loaded. */
const MONITORING_NOT_LOADED = {
  code: "service_validation_error",
  message: "Validation error: SPAN Panel is not loaded.",
  translation_key: "monitoring_panel_not_loaded",
  translation_placeholders: null,
  translation_domain: "span_panel",
};
/** What the integration answers for a device the registry no longer holds, as once its entry is removed: a refusal waiting does not end. */
const DEVICE_NOT_FOUND = { code: "device_not_found", message: "Device not found" };
const WAITING = "Waiting for SPAN Panel to load...";
const SETUP_FAILED = "SPAN Panel could not be set up. Check Settings → Devices & services.";
const RESTART_NEEDED = "SPAN Panel could not be loaded. Restart Home Assistant to try again.";
const DISABLED = "This SPAN Panel is disabled. Enable it in Settings → Devices & services.";
const NO_RESULTS = "No circuits found";
/** What a view says where the dashboard lists no panel, and so selects none. */
const NO_PANELS = "No SPAN Panel found. Add one in Settings → Devices & services.";

const PENDING: [string, unknown][] = [
  ["not_loaded", NOT_LOADED],
  ["unknown_command", UNKNOWN_COMMAND],
  ["a lost connection", CONNECTION_LOST_RESULT],
];
const PENDING_REFUSALS: ReadonlySet<unknown> = new Set(PENDING.map(([, refusal]) => refusal));

/** A config entry's state and who disabled it, as `config_entries/subscribe` reports them. */
interface EntryState {
  state: string;
  disabled_by: string | null;
}

/** The entry states that a wait ends by itself: before setup, during it, between its retries, and during an unload. */
const WAIT_STATES = ["not_loaded", "setup_in_progress", "setup_retry", "unload_in_progress"];

/** The entry states, and the disabled entry, that no wait ends by itself, and what the dashboard says of each. */
const STUCK: [string, EntryState, string][] = [
  ["setup_error", { state: "setup_error", disabled_by: null }, SETUP_FAILED],
  ["migration_error", { state: "migration_error", disabled_by: null }, RESTART_NEEDED],
  ["failed_unload", { state: "failed_unload", disabled_by: null }, RESTART_NEEDED],
  ["disabled", { state: "not_loaded", disabled_by: "user" }, DISABLED],
];

/** A panel the integration holds: its device, the config entry that owns it, its one circuit and its status entity. */
interface PanelFixture {
  device: DeviceRegistryEntry;
  entry: string;
  circuit: string;
  status: string;
}

const FIRST: PanelFixture = { device: PANEL, entry: SPAN_ENTRY, circuit: "c1", status: PANEL_STATUS.entity_id };
const SECOND: PanelFixture = { device: SECOND_PANEL, entry: SECOND_SPAN_ENTRY, circuit: "c2", status: "binary_sensor.garage_panel_status" };
const PANELS = [FIRST, SECOND];

function topologyOf({ device, entry, circuit, status }: PanelFixture): PanelTopology {
  return {
    circuits: { [circuit]: { name: `Circuit ${circuit}`, tabs: [1], entities: { power: `sensor.${circuit}_power` }, relay_state: "CLOSED" } },
    panel_size: 32,
    panel_entities: { panel_status: status },
    panel_device_id: device.id,
    config_entry_id: entry,
  };
}

/** The refusal `panel_topology` and `adopted/list` answer for a panel, by its device id; a panel not named here has loaded. */
const refusals = new Map<string, unknown>();
/**
 * The panels whose monitoring status alone is refused, by device id: the entry
 * left `loaded` between the panel's topology and its status, as an options
 * reload does.
 */
const monitoringRefusals = new Set<string>();
/** How often `get_monitoring_status` was asked, by the device id of the panel it named. */
const statusReads = new Map<string, number>();
/** An entry's state as the subscription reports it, by entry id, where a test sets one: else set up while its panel is refused, and loaded otherwise. */
const entryStates = new Map<string, EntryState>();
/** The panels `panel_topology` and `adopted/list` were asked for, by device id, in order. */
let asks: string[] = [];
/** The refusal the device registry list and the config entry list are answered with, where they are refused. */
let registryRefusal: unknown = null;
/** How often the device registry list was asked for. */
let deviceListAsks = 0;
let favorites: Record<string, { circuits: string[]; sub_devices: string[] }> = {};
/** While set, each `adopted/list` answer waits in `heldAdopted` and is decided as it is released. */
let holdAdopted = false;
let heldAdopted: Array<() => void> = [];
/** While set, each `panel_topology` answer waits in `heldTopology` and is decided as it is released. */
let holdTopology = false;
let heldTopology: Array<() => void> = [];
/** The panels' devices the device registry lists; Home Assistant removes a panel's device as it removes its entry. */
let listedDevices: DeviceRegistryEntry[] = [PANEL, SECOND_PANEL];

/** The config entry a service call names, where it names one. */
function entryOf(msg: Record<string, unknown>): unknown {
  const data = msg.service_data;
  return typeof data === "object" && data !== null && "config_entry_id" in data ? data.config_entry_id : undefined;
}

/**
 * What `get_monitoring_status` answers for a panel: monitoring on, with its
 * circuit, once its entry has loaded; the integration's refusal for an entry
 * that has not, or a lost connection where the panel's requests meet one.
 */
function monitoringOf(fixture: PanelFixture): Promise<unknown> {
  statusReads.set(fixture.device.id, (statusReads.get(fixture.device.id) ?? 0) + 1);
  const refusal = refusals.get(fixture.device.id);
  if (refusal === CONNECTION_LOST_RESULT) return Promise.reject(refusal);
  if (PENDING_REFUSALS.has(refusal) || monitoringRefusals.has(fixture.device.id)) return Promise.reject(MONITORING_NOT_LOADED);
  return Promise.resolve({ response: monitoringAnswer(fixture) });
}

/** The status `get_monitoring_status` answers for a panel that has loaded: monitoring on, with its circuit. */
function monitoringAnswer(fixture: PanelFixture): unknown {
  return {
    enabled: true,
    global_settings: { continuous_threshold_pct: 80, spike_threshold_pct: 100, window_duration_m: 15, cooldown_duration_m: 15 },
    circuits: { [`sensor.${fixture.circuit}_power`]: { name: `Circuit ${fixture.circuit}`, monitoring_enabled: true } },
    mains: {},
  };
}

/** What `adopted/list` answers for a panel that has loaded: one device with one row. */
function adoptedOf({ device, circuit }: PanelFixture): AdoptedListResponse {
  return {
    devices: [
      {
        device_id: device.id,
        name: device.name ?? null,
        adopted_device: false,
        rows: [
          {
            key: `${circuit}/run-hours`,
            path: `${circuit}/run-hours`,
            platform: "sensor",
            entity_id: null,
            datatype: "float",
            unit: "h",
            settable: false,
            name: "Run Hours",
            curation: {},
            allowed_device_classes: ["duration"],
            allowed_state_classes: ["measurement"],
            stale_fields: [],
          },
        ],
      },
    ],
  };
}

/** Answer a command for one panel, as `panel_topology` and `adopted/list` do: refused, or with `answer` for a panel that has loaded. */
function forPanel(msg: Record<string, unknown>, answer: (fixture: PanelFixture) => unknown): Promise<unknown> {
  const fixture = PANELS.find(p => p.device.id === msg.device_id);
  if (!fixture) return Promise.reject(new Error(`the dashboard asked for device ${String(msg.device_id)}, which no panel has`));
  asks.push(fixture.device.id);
  return refusals.has(fixture.device.id) ? Promise.reject(refusals.get(fixture.device.id)) : Promise.resolve(answer(fixture));
}

/** An answer for one panel, held in `held` while `hold` is set and then decided as it is released, as Home Assistant decides it as it handles the command. */
function heldAnswer(msg: Record<string, unknown>, answer: (fixture: PanelFixture) => unknown, hold: boolean, held: Array<() => void>): Promise<unknown> {
  if (!hold) return forPanel(msg, answer);
  return new Promise((resolve, reject) => held.push(() => forPanel(msg, answer).then(resolve, reject)));
}

function backend(msg: Record<string, unknown>): Promise<unknown> {
  switch (msg.type) {
    case "config/device_registry/list":
    case "config_entries/get":
      if (msg.type === "config/device_registry/list") deviceListAsks += 1;
      return registryRefusal === null ? hassWithRegistries(listedDevices).callWS(msg) : Promise.reject(registryRefusal);
    case "config/area_registry/list":
    case "config/entity_registry/list":
      return Promise.resolve([]);
    case "span_panel/panel_topology":
      return heldAnswer(msg, topologyOf, holdTopology, heldTopology);
    case "span_panel/adopted/list":
      return heldAnswer(msg, adoptedOf, holdAdopted, heldAdopted);
    case "call_service":
      if (msg.service === "get_favorites") return Promise.resolve({ response: { favorites } });
      if (msg.service === "get_monitoring_status") {
        const fixture = PANELS.find(p => p.entry === entryOf(msg));
        if (!fixture) return Promise.reject(new Error(`the dashboard read the monitoring status of entry ${String(entryOf(msg))}, which no panel has`));
        return monitoringOf(fixture);
      }
      return Promise.resolve({});
    default:
      // History has no points.
      return Promise.resolve({});
  }
}

/** One config entry change, as `config_entries/subscribe` reports it: in a batch of the current entries where `type` is null. */
function change(entry_id: string, state: string, type: "updated" | "removed" | null = null, disabled_by: string | null = null): unknown {
  return { type, entry: { entry_id, domain: "span_panel", state, disabled_by } };
}

/** The state the subscription reports for a panel's entry: the one a test set, else set up while the panel is refused, and loaded otherwise. */
function entryStateOf(fixture: PanelFixture): EntryState {
  return entryStates.get(fixture.entry) ?? { state: refusals.has(fixture.device.id) ? "setup_in_progress" : "loaded", disabled_by: null };
}

/** Each panel's entry as it stands. */
function currentEntries(): unknown[] {
  return PANELS.map(p => {
    const { state, disabled_by } = entryStateOf(p);
    return change(p.entry, state, null, disabled_by);
  });
}

const mounted: HTMLElement[] = [];
let watch: MockInstance<ErrorStore["watchPanelStatus"]>;
let added: MockInstance<ErrorStore["add"]>;

beforeEach(() => {
  // Retries wait on timers, which the tests run through at will.
  vi.useFakeTimers();
  // Node 25+ defines its own `localStorage`, undefined without
  // `--localstorage-file`, and it shadows happy-dom's; the element reads it.
  vi.stubGlobal("localStorage", new Storage());
  refusals.clear();
  monitoringRefusals.clear();
  statusReads.clear();
  entryStates.clear();
  asks = [];
  registryRefusal = null;
  deviceListAsks = 0;
  favorites = {};
  holdAdopted = false;
  heldAdopted = [];
  holdTopology = false;
  heldTopology = [];
  listedDevices = [PANEL, SECOND_PANEL];
  watch = vi.spyOn(ErrorStore.prototype, "watchPanelStatus");
  added = vi.spyOn(ErrorStore.prototype, "add");
  // No interval outlives a test.
  vi.spyOn(DashboardController.prototype, "startIntervals").mockImplementation(() => {});
});

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Every error and toast the dashboard has added, by its key, in order: read from the store's `add`, since a toast is gone after five seconds. */
function errorsAdded(): string[] {
  return added.mock.calls.map(([entry]) => entry.key);
}

function tabContent(panel: SpanPanelElement): HTMLElement {
  const content = panel.shadowRoot?.getElementById("tab-content");
  if (!content) throw new Error("no tab content");
  return content;
}

/** The waiting line the view shows, where it shows one. */
function waitingLine(panel: SpanPanelElement): string | null {
  return tabContent(panel).querySelector('[role="status"]')?.textContent?.trim() ?? null;
}

/** The line the view shows where its panel's entry failed to set up or is disabled, where it shows one. */
function stuckLine(panel: SpanPanelElement): string | null {
  return tabContent(panel).querySelector('[role="alert"]')?.textContent?.trim() ?? null;
}

function bannerMessages(panel: SpanPanelElement): string[] {
  const banner = panel.shadowRoot?.querySelector("span-error-banner")?.shadowRoot;
  return [...(banner?.querySelectorAll(".banner-row .message") ?? [])].map(el => el.textContent ?? "");
}

/** Each panel's status entity, `on` unless `off` names it: a panel whose entity is off is unreachable. */
function statusStates(off: string[] = []): HomeAssistant["states"] {
  return Object.fromEntries(
    PANELS.map(({ status }) => [status, { entity_id: status, state: off.includes(status) ? "off" : "on", attributes: {}, last_changed: "", last_updated: "" }])
  );
}

/** Home Assistant as the frontend hands it to the dashboard, for an administrator, who may open every tab. */
function hassFor(connection: FakeConnection, off: string[] = []): HomeAssistant {
  return hassWith(connection, { states: statusStates(off), user: { is_admin: true }, callWS: backend as HomeAssistant["callWS"] });
}

/** Attach the dashboard. */
function attachOnly(connection: FakeConnection): SpanPanelElement {
  const panel = new SpanPanelElement();
  panel.hass = hassFor(connection);
  document.body.appendChild(panel);
  mounted.push(panel);
  return panel;
}

/** Attach the dashboard, and wait for it to subscribe to its panels' entries. */
async function attach(connection: FakeConnection): Promise<SpanPanelElement> {
  const panel = attachOnly(connection);
  await vi.waitFor(() => expect(connection.live(ENTRY_RELOADS)).toBe(1));
  return panel;
}

/** Mount the dashboard and hand its entry subscription the first batch, which only seeds: each entry as it stands. */
async function mount(connection: FakeConnection): Promise<SpanPanelElement> {
  const panel = await attach(connection);
  connection.emit(ENTRY_RELOADS, currentEntries());
  await vi.waitFor(() => expect(panel.shadowRoot?.getElementById("tab-content")).toBeTruthy());
  return panel;
}

/** Open `tab`, as the user does from the tab bar, and wait for it to ask for its panel; By Panel is open from the start. */
async function openTab(panel: SpanPanelElement, tab: string): Promise<void> {
  if (tab === "dashboard") {
    await vi.waitFor(() => expect(asks).toContain(PANEL.id));
    return;
  }
  const asked = asks.length;
  const shown = tabContent(panel).firstElementChild;
  const button = panel.shadowRoot?.querySelector<HTMLElement>(`.panel-tabs [data-tab="${tab}"]`);
  if (!button) throw new Error(`no ${tab} tab`);
  button.click();
  await vi.waitFor(() => expect(asks.length).toBeGreaterThan(asked));
  await vi.waitFor(() => expect(tabContent(panel).firstElementChild).not.toBe(shown));
}

/** Choose `fixture`'s panel in the dashboard's panel dropdown, as the user does. */
function choosePanel(panel: SpanPanelElement, fixture: PanelFixture): void {
  const select = panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select");
  if (!select) throw new Error("no panel dropdown");
  select.value = fixture.device.id;
  select.dispatchEvent(new Event("change"));
}

/** The panel's entry moves to `state`, as `config_entries/subscribe` reports it. */
function entryChanges(connection: FakeConnection, fixture: PanelFixture, { state, disabled_by }: EntryState): void {
  entryStates.set(fixture.entry, { state, disabled_by });
  connection.emit(ENTRY_RELOADS, [change(fixture.entry, state, "updated", disabled_by)]);
}

/** The panel's entry reaches `loaded`, as `config_entries/subscribe` reports it. */
function load(connection: FakeConnection, fixture: PanelFixture): void {
  refusals.delete(fixture.device.id);
  monitoringRefusals.delete(fixture.device.id);
  entryStates.delete(fixture.entry);
  connection.emit(ENTRY_RELOADS, [change(fixture.entry, "loaded", "updated")]);
}

/** Run through every retry a rejection could start, and the toast its last one would show. */
async function runRetries(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000);
}

const TABS = [
  { name: "By Panel", tab: "dashboard", drawn: ".panel-grid" },
  { name: "By Activity", tab: "activity", drawn: ".list-row" },
  { name: "By Area", tab: "area", drawn: ".list-row" },
  { name: "Monitoring", tab: "monitoring", drawn: ".circuit-toggle" },
  { name: "Adopted", tab: "adopted", drawn: ".adopted-row-header" },
];

describe.each(TABS)("the sidebar dashboard's $name tab, while the panel's config entry has not loaded", ({ tab, drawn }) => {
  it.each(PENDING)("says it is waiting, with no error, no retry and no toast, where the panel's request is refused with %s", async (_name, refusal) => {
    refusals.set(PANEL.id, refusal);
    const panel = await mount(new FakeConnection());

    await openTab(panel, tab);

    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
    expect(tabContent(panel).textContent?.trim()).toBe(WAITING);
    expect(tabContent(panel).querySelector(drawn)).toBeNull();
    const asked = asks.length;
    await runRetries();
    expect(asks.length).toBe(asked);
    expect(errorsAdded()).toEqual([]);
    expect(waitingLine(panel)).toBe(WAITING);
  });

  it("draws the panel once its entry loads", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await openTab(panel, tab);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    load(connection, FIRST);

    await vi.waitFor(() => expect(tabContent(panel).querySelector(drawn)).not.toBeNull());
    expect(tabContent(panel).textContent).not.toContain(WAITING);
  });

  it("draws the panel on the re-seed that follows a reconnect, where the connection was lost as it asked", async () => {
    refusals.set(PANEL.id, CONNECTION_LOST_RESULT);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await openTab(panel, tab);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    // Home Assistant is back, the entry loaded meanwhile, and the replayed subscription re-seeds.
    refusals.delete(PANEL.id);
    connection.emit(ENTRY_RELOADS, currentEntries());

    await vi.waitFor(() => expect(tabContent(panel).querySelector(drawn)).not.toBeNull());
    expect(tabContent(panel).textContent).not.toContain(WAITING);
  });
});

describe.each(TABS.filter(({ tab }) => tab !== "adopted"))(
  "the sidebar dashboard's $name tab, where the panel's monitoring status is refused as its entry reloads",
  ({ tab, drawn }) => {
    it("says it is waiting, with no retry and no toast, though the panel's topology answered, and draws the panel once the entry loads", async () => {
      monitoringRefusals.add(PANEL.id);
      entryStates.set(SPAN_ENTRY, { state: "setup_in_progress", disabled_by: null });
      const connection = new FakeConnection();
      const panel = await mount(connection);

      await openTab(panel, tab);

      await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
      expect(tabContent(panel).querySelector(drawn)).toBeNull();
      const read = statusReads.get(PANEL.id);
      await runRetries();
      expect(statusReads.get(PANEL.id)).toBe(read);
      expect(errorsAdded()).toEqual([]);

      load(connection, FIRST);

      await vi.waitFor(() => expect(tabContent(panel).querySelector(drawn)).not.toBeNull());
      expect(tabContent(panel).textContent).not.toContain(WAITING);
    });
  }
);

describe("the sidebar dashboard's Monitoring tab, whose redraw after a save is refused as the panel's entry reloads", () => {
  it("keeps the table it drew, with no toast, and draws it again once the entry loads", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await openTab(panel, "monitoring");
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".circuit-toggle")).not.toBeNull());
    const reads = statusReads.get(PANEL.id) ?? 0;

    // The user turns the circuit's monitoring off; the entry starts to reload before the tab reads its status again.
    monitoringRefusals.add(PANEL.id);
    entryChanges(connection, FIRST, { state: "setup_in_progress", disabled_by: null });
    const toggle = tabContent(panel).querySelector<HTMLInputElement>(".circuit-toggle")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(statusReads.get(PANEL.id)).toBe(reads + 1));
    await vi.advanceTimersByTimeAsync(100);

    expect(tabContent(panel).querySelector(".circuit-toggle")).not.toBeNull();
    expect(waitingLine(panel)).toBeNull();
    expect(errorsAdded()).toEqual([]);

    load(connection, FIRST);

    await vi.waitFor(() => expect(statusReads.get(PANEL.id)).toBe(reads + 2));
    await vi.waitFor(() => expect(tabContent(panel).querySelector<HTMLInputElement>(".circuit-toggle")?.checked).toBe(true));
  });
});

describe("the sidebar dashboard's By Panel tab, with a circuit panel open as the panel's entry loads", () => {
  it("brings the circuit panel's monitoring up to date, as one opened while the entry had not loaded read none", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
    const refreshed = vi.spyOn(DashboardTab.prototype, "refreshSidePanel").mockResolvedValue(undefined);

    entryChanges(connection, FIRST, { state: "setup_in_progress", disabled_by: null });
    load(connection, FIRST);

    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith(SPAN_ENTRY, expect.objectContaining({ config_entry_id: SPAN_ENTRY }), null));
  });
});

describe.each(TABS)("the sidebar dashboard's $name tab, where the panel's entry failed to set up or is disabled", ({ tab, drawn }) => {
  it.each(STUCK)("says so, and how to set it right, with no waiting line and no toast, where the entry is %s", async (_name, entryState, said) => {
    refusals.set(PANEL.id, NOT_LOADED);
    entryStates.set(SPAN_ENTRY, entryState);
    const panel = await mount(new FakeConnection());

    await openTab(panel, tab);

    await vi.waitFor(() => expect(stuckLine(panel)).toBe(said));
    expect(tabContent(panel).textContent?.trim()).toBe(said);
    expect(waitingLine(panel)).toBeNull();
    await runRetries();
    expect(errorsAdded()).toEqual([]);
  });

  it("says set-up failed once the entry fails while the tab waits, waits again as the entry is set up again, and draws the panel once it loads, as after a reauth", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await openTab(panel, tab);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    entryChanges(connection, FIRST, { state: "setup_error", disabled_by: null });
    await vi.waitFor(() => expect(stuckLine(panel)).toBe(SETUP_FAILED));

    entryChanges(connection, FIRST, { state: "setup_in_progress", disabled_by: null });
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    load(connection, FIRST);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(drawn)).not.toBeNull());
    expect(stuckLine(panel)).toBeNull();
  });
});

describe("the sidebar dashboard's By Panel tab, while the panel's entry is on its way to loading", () => {
  it.each(WAIT_STATES)("keeps waiting while the entry is %s", async state => {
    refusals.set(PANEL.id, NOT_LOADED);
    entryStates.set(SPAN_ENTRY, { state, disabled_by: null });
    const panel = await mount(new FakeConnection());

    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
    expect(stuckLine(panel)).toBeNull();
  });
});

describe("the sidebar dashboard, where the panel's entry is removed while it waits", () => {
  it("ends the wait with the error the panel's request now answers", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    // Home Assistant removes the entry's devices, then reports the entry removed.
    refusals.set(PANEL.id, DEVICE_NOT_FOUND);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "not_loaded", "removed")]);

    await vi.waitFor(() => expect(tabContent(panel).textContent).toContain(DEVICE_NOT_FOUND.message));
    expect(waitingLine(panel)).toBeNull();
  });
});

describe.each(TABS.filter(({ tab }) => tab !== "monitoring"))("the sidebar dashboard's $name tab, for a refusal waiting does not end", ({ tab }) => {
  it("shows the error, as before, and no waiting line, where the panel's device is gone as its entry is removed", async () => {
    refusals.set(PANEL.id, DEVICE_NOT_FOUND);
    const panel = await mount(new FakeConnection());

    await openTab(panel, tab);
    await runRetries();

    await vi.waitFor(() => expect(tabContent(panel).textContent).toContain(DEVICE_NOT_FOUND.message));
    expect(waitingLine(panel)).toBeNull();
  });
});

describe("the sidebar dashboard's Monitoring tab, for a refusal waiting does not end", () => {
  it("draws the tab, as before, its rows going by what the monitoring status calls them, where the panel's device is gone as its entry is removed", async () => {
    refusals.set(PANEL.id, DEVICE_NOT_FOUND);
    const panel = await mount(new FakeConnection());

    await openTab(panel, "monitoring");

    await vi.waitFor(() => expect(tabContent(panel).querySelector(".circuit-toggle")).not.toBeNull());
    expect(waitingLine(panel)).toBeNull();
  });
});

describe("the sidebar dashboard's Adopted tab, re-reading its rows as the panel's entry loads", () => {
  it("paints nothing over the tab the user opened while the re-read was in flight", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await openTab(panel, "adopted");
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
    holdAdopted = true;
    load(connection, FIRST);
    await vi.waitFor(() => expect(heldAdopted).toHaveLength(1));

    await openTab(panel, "activity");
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".list-row")).not.toBeNull());
    for (const release of heldAdopted.splice(0)) release();
    await vi.advanceTimersByTimeAsync(100);

    expect(tabContent(panel).querySelector(".list-row")).not.toBeNull();
    expect(tabContent(panel).querySelector("#adopted-filter")).toBeNull();
  });

  it("shows the error, as before, where the re-read after the wait finds the panel's device gone, its entry removed as it loaded", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await openTab(panel, "adopted");
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    refusals.set(PANEL.id, DEVICE_NOT_FOUND);
    connection.emit(ENTRY_RELOADS, [change(SPAN_ENTRY, "loaded", "updated")]);

    await vi.waitFor(() => expect(tabContent(panel).textContent).toContain(DEVICE_NOT_FOUND.message));
    expect(waitingLine(panel)).toBeNull();
  });
});

describe("the sidebar dashboard, switching panels while one waits", () => {
  it("draws the panel chosen, and leaves it drawn as the first panel's entry loads", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    choosePanel(panel, SECOND);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
    expect(waitingLine(panel)).toBeNull();
    const drawn = vi.spyOn(DashboardTab.prototype, "render");

    load(connection, FIRST);
    await vi.advanceTimersByTimeAsync(100);

    expect(drawn).not.toHaveBeenCalled();
    expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull();
  });
});

describe("the sidebar dashboard's watch of the panel's status", () => {
  it("asks once while the panel's entry has not loaded, with no toast, and watches the status once the entry loads", async () => {
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    await mount(connection);
    // By Panel asks once, and so does the watch.
    await vi.waitFor(() => expect(asks).toHaveLength(2));

    await runRetries();

    expect(asks).toEqual([PANEL.id, PANEL.id]);
    expect(errorsAdded()).toEqual([]);
    expect(watch).not.toHaveBeenCalled();

    load(connection, FIRST);

    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(FIRST.status));
  });

  it("asks once where the connection is lost, with no toast, and watches the status on the re-seed that follows the reconnect", async () => {
    refusals.set(PANEL.id, CONNECTION_LOST_RESULT);
    const connection = new FakeConnection();
    await mount(connection);
    await vi.waitFor(() => expect(asks).toHaveLength(2));

    await runRetries();

    expect(asks).toEqual([PANEL.id, PANEL.id]);
    expect(errorsAdded()).toEqual([]);
    expect(watch).not.toHaveBeenCalled();

    refusals.delete(PANEL.id);
    connection.emit(ENTRY_RELOADS, currentEntries());

    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(FIRST.status));
  });

  it("stops watching a panel once another is chosen, though the other's status cannot be watched yet", async () => {
    refusals.set(SECOND_PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(FIRST.status));

    choosePanel(panel, SECOND);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
    // The first panel goes offline after the user left it.
    panel.hass = hassFor(connection, [FIRST.status]);
    await vi.advanceTimersByTimeAsync(100);

    expect(bannerMessages(panel)).not.toContain("SPAN Panel unreachable");
  });
});

describe("the sidebar dashboard's Favorites view, while a panel with favorites has not loaded", () => {
  /** The favorites view's circuit rows, by their composite ids. */
  function favoriteRows(panel: SpanPanelElement): string[] {
    return [...tabContent(panel).querySelectorAll<HTMLElement>(".list-row[data-row-uuid]")].map(row => row.dataset.rowUuid ?? "");
  }

  beforeEach(() => {
    localStorage.setItem("span_panel_selected", "favorites");
  });

  it.each(PENDING)(
    "says it is waiting, not that it found nothing, with no retry and no toast, where the only panel with favorites answers %s",
    async (_name, refusal) => {
      favorites = { [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] } };
      refusals.set(PANEL.id, refusal);
      const panel = await mount(new FakeConnection());

      await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
      expect(tabContent(panel).textContent).not.toContain(NO_RESULTS);
      const asked = asks.length;
      await runRetries();
      expect(asks.length).toBe(asked);
      expect(errorsAdded()).toEqual([]);
    }
  );

  it("draws the favorites once the panel's entry loads", async () => {
    favorites = { [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] } };
    refusals.set(PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));

    load(connection, FIRST);

    await vi.waitFor(() => expect(favoriteRows(panel)).toEqual([`${PANEL.id}|${FIRST.circuit}`]));
    expect(tabContent(panel).textContent).not.toContain(WAITING);
  });

  it("draws the favorites of a panel that has loaded at once, with no toast, and adds those of one that loads later", async () => {
    favorites = {
      [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] },
      [SECOND_PANEL.id]: { circuits: [SECOND.circuit], sub_devices: [] },
    };
    refusals.set(SECOND_PANEL.id, NOT_LOADED);
    const connection = new FakeConnection();

    const panel = await mount(connection);

    // Well inside the first retry's one-second wait.
    await vi.waitFor(() => expect(favoriteRows(panel)).toEqual([`${PANEL.id}|${FIRST.circuit}`]), { timeout: 500 });
    expect(waitingLine(panel)).toBeNull();
    await runRetries();
    expect(errorsAdded()).toEqual([]);

    load(connection, SECOND);

    await vi.waitFor(() => expect(favoriteRows(panel)).toHaveLength(2));
  });

  it.each(STUCK)("says so, and how to set it right, where the only panel with favorites has an entry that is %s", async (_name, entryState, said) => {
    favorites = { [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] } };
    refusals.set(PANEL.id, NOT_LOADED);
    entryStates.set(SPAN_ENTRY, entryState);
    const panel = await mount(new FakeConnection());

    await vi.waitFor(() => expect(stuckLine(panel)).toBe(said));
    expect(waitingLine(panel)).toBeNull();
  });

  it("waits while any of its panels can still load, though another's entry failed to set up", async () => {
    favorites = {
      [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] },
      [SECOND_PANEL.id]: { circuits: [SECOND.circuit], sub_devices: [] },
    };
    refusals.set(PANEL.id, NOT_LOADED);
    refusals.set(SECOND_PANEL.id, NOT_LOADED);
    entryStates.set(SPAN_ENTRY, { state: "setup_error", disabled_by: null });
    const panel = await mount(new FakeConnection());

    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
    expect(stuckLine(panel)).toBeNull();
  });

  it("waits for the panel still loading, and not for one whose entry was removed as the view was built", async () => {
    favorites = {
      [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] },
      [SECOND_PANEL.id]: { circuits: [SECOND.circuit], sub_devices: [] },
    };
    refusals.set(PANEL.id, NOT_LOADED);
    refusals.set(SECOND_PANEL.id, NOT_LOADED);
    holdTopology = true;
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(heldTopology).toHaveLength(2));

    // The first panel's entry, not loaded yet, is refused at once; then Home Assistant removes it, its device with it, while the second's answer is on its way.
    heldTopology.shift()?.();
    listedDevices = [SECOND_PANEL];
    connection.emit(DEVICE_REGISTRY, { event_type: DEVICE_REGISTRY, data: { action: "remove", device_id: PANEL.id } });
    const listed = (): string[] => [...(panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select")?.options ?? [])].map(option => option.value);
    await vi.waitFor(() => expect(listed()).not.toContain(PANEL.id));
    holdTopology = false;
    for (const release of heldTopology.splice(0)) release();

    await vi.waitFor(() => expect(waitingLine(panel)).toBe(WAITING));
    expect(tabContent(panel).textContent).not.toContain(NO_RESULTS);
  });

  it("draws the favorites of a panel whose monitoring status is refused as its entry reloads, with no toast, and draws them again once it loads", async () => {
    favorites = { [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] } };
    monitoringRefusals.add(PANEL.id);
    entryStates.set(SPAN_ENTRY, { state: "setup_in_progress", disabled_by: null });
    const connection = new FakeConnection();
    const panel = await mount(connection);

    await vi.waitFor(() => expect(favoriteRows(panel)).toEqual([`${PANEL.id}|${FIRST.circuit}`]));
    const reads = statusReads.get(PANEL.id) ?? 0;
    await runRetries();
    expect(statusReads.get(PANEL.id)).toBe(reads);
    expect(errorsAdded()).toEqual([]);

    load(connection, FIRST);

    await vi.waitFor(() => expect(statusReads.get(PANEL.id)).toBe(reads + 1));
    await vi.waitFor(() => expect(favoriteRows(panel)).toEqual([`${PANEL.id}|${FIRST.circuit}`]));
  });

  it("says, in the Monitoring tab's block of a panel whose status is refused as its entry reloads, that it is waiting, and draws the block once the entry loads", async () => {
    favorites = {
      [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] },
      [SECOND_PANEL.id]: { circuits: [SECOND.circuit], sub_devices: [] },
    };
    monitoringRefusals.add(PANEL.id);
    entryStates.set(SPAN_ENTRY, { state: "setup_in_progress", disabled_by: null });
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(favoriteRows(panel)).toHaveLength(2));
    panel.shadowRoot?.querySelector<HTMLElement>('.panel-tabs [data-tab="monitoring"]')?.click();
    const blocks = (): HTMLElement[] => [...tabContent(panel).querySelectorAll<HTMLElement>(".favorites-monitoring-block")];

    await vi.waitFor(() => expect(blocks()).toHaveLength(2));
    await vi.waitFor(() => expect(blocks()[0]!.querySelector('[role="status"]')?.textContent?.trim()).toBe(WAITING));
    expect(blocks()[1]!.querySelector(".circuit-toggle")).not.toBeNull();
    expect(errorsAdded()).toEqual([]);

    load(connection, FIRST);

    await vi.waitFor(() => expect(blocks()[0]!.querySelector(".circuit-toggle")).not.toBeNull());
    expect(blocks()[0]!.textContent).not.toContain(WAITING);
  });

  it("says it found nothing, as before, where the only panel with favorites has its device gone as its entry is removed", async () => {
    favorites = { [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] } };
    refusals.set(PANEL.id, DEVICE_NOT_FOUND);
    const panel = await mount(new FakeConnection());

    await runRetries();

    await vi.waitFor(() => expect(tabContent(panel).textContent).toContain(NO_RESULTS));
    expect(waitingLine(panel)).toBeNull();
  });
});

describe("the sidebar dashboard, once every panel is removed", () => {
  /** Home Assistant removes every SPAN entry, their devices with them, and the dashboard lists its panels again. */
  async function removeEveryPanel(panel: SpanPanelElement, connection: FakeConnection): Promise<void> {
    listedDevices = [];
    refusals.set(PANEL.id, DEVICE_NOT_FOUND);
    refusals.set(SECOND_PANEL.id, DEVICE_NOT_FOUND);
    connection.emit(DEVICE_REGISTRY, { event_type: DEVICE_REGISTRY, data: { action: "remove", device_id: PANEL.id } });
    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select")?.options).toHaveLength(favorites[PANEL.id] ? 1 : 0));
  }

  it("waits for no panel the list no longer holds, where the view's request, sent before the last panel left, is cut off by a lost connection", async () => {
    // Node reports a rejection nothing handled once the tick it happened in is over: the test runs on real timers to see one.
    vi.useRealTimers();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const connection = new FakeConnection();
      const panel = await mount(connection);
      await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
      holdTopology = true;
      panel.shadowRoot?.querySelector<HTMLElement>('.panel-tabs [data-tab="activity"]')?.click();
      await vi.waitFor(() => expect(heldTopology).toHaveLength(1));

      // Home Assistant removes every SPAN entry, the devices with them, while the view's request is on its way; the connection is then lost before it is answered.
      listedDevices = [];
      connection.emit(DEVICE_REGISTRY, { event_type: DEVICE_REGISTRY, data: { action: "remove", device_id: PANEL.id } });
      await vi.waitFor(() => expect(panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select")?.options).toHaveLength(0));
      refusals.set(PANEL.id, CONNECTION_LOST_RESULT);
      holdTopology = false;
      for (const release of heldTopology.splice(0)) release();

      await vi.waitFor(() => expect(tabContent(panel).textContent?.trim()).toBe(NO_PANELS));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("selects no panel, so a tab opened while the connection is down asks for none and says no panel is found, in words of its own", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
    await removeEveryPanel(panel, connection);
    const asked = asks.length;

    // Home Assistant restarts, and the user opens By Activity while the connection is down.
    refusals.set(PANEL.id, CONNECTION_LOST_RESULT);
    panel.shadowRoot?.querySelector<HTMLElement>('.panel-tabs [data-tab="activity"]')?.click();
    await vi.advanceTimersByTimeAsync(200);

    expect(asks.length).toBe(asked);
    expect(tabContent(panel).textContent?.trim()).toBe(NO_PANELS);
    expect(tabContent(panel).textContent).not.toContain("device_id");
    expect(waitingLine(panel)).toBeNull();
  });

  it("says no panel is found, in words of its own, where the dashboard opens with none listed", async () => {
    listedDevices = [];

    const panel = await mount(new FakeConnection());

    await vi.waitFor(() => expect(tabContent(panel).textContent?.trim()).toBe(NO_PANELS));
    expect(asks).toEqual([]);
  });

  it("selects Favorites where it is still listed", async () => {
    favorites = { [PANEL.id]: { circuits: [FIRST.circuit], sub_devices: [] } };
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());

    await removeEveryPanel(panel, connection);

    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select")?.value).toBe("favorites"));
    await vi.waitFor(() => expect(tabContent(panel).textContent).toContain(NO_RESULTS));
  });
});

describe("the sidebar dashboard's Adopted tab, which the frontend discards while it reads", () => {
  it("paints nothing, and listens to nothing, once the read lands", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
    holdAdopted = true;
    panel.shadowRoot?.querySelector<HTMLElement>('.panel-tabs [data-tab="adopted"]')?.click();
    await vi.waitFor(() => expect(heldAdopted).toHaveLength(1));
    const listened = vi.spyOn(HTMLElement.prototype, "addEventListener");

    // The user navigates away: the frontend detaches the dashboard and discards it.
    panel.remove();
    holdAdopted = false;
    for (const release of heldAdopted.splice(0)) release();
    await vi.advanceTimersByTimeAsync(50);

    expect(tabContent(panel).querySelector(".adopted-row-header")).toBeNull();
    expect(listened.mock.contexts).not.toContain(tabContent(panel));
  });
});

describe("the sidebar dashboard's list of panels", () => {
  /** The line the dashboard shows while it has no list of panels to show. */
  function shellStatus(panel: SpanPanelElement): string | null {
    return panel.shadowRoot?.querySelector('.view [role="status"]')?.textContent?.trim() ?? null;
  }

  it("says it is waiting, with no error, no retry and no toast, where the device registry list is refused by a lost connection", async () => {
    registryRefusal = CONNECTION_LOST_RESULT;
    const panel = await attach(new FakeConnection());

    await vi.waitFor(() => expect(shellStatus(panel)).toBe(WAITING));
    const asked = deviceListAsks;
    await runRetries();
    expect(deviceListAsks).toBe(asked);
    expect(errorsAdded()).toEqual([]);
    expect(shellStatus(panel)).toBe(WAITING);
  });

  it("lists the panels again, with no error, once the frontend hands it Home Assistant again, where a lost connection cut a refresh of the list off", async () => {
    const connection = new FakeConnection();
    const panel = await mount(connection);
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
    const listed = (): string[] => [...(panel.shadowRoot?.querySelector<HTMLSelectElement>("#panel-select")?.options ?? [])].map(option => option.value);
    expect(listed()).toEqual([PANEL.id, SECOND_PANEL.id]);

    // The second panel's device is removed, and the connection is lost as the list is asked for again.
    listedDevices = [PANEL];
    registryRefusal = CONNECTION_LOST_RESULT;
    connection.emit(DEVICE_REGISTRY, { event_type: DEVICE_REGISTRY, data: { action: "remove", device_id: SECOND_PANEL.id } });
    await runRetries();
    expect(listed()).toEqual([PANEL.id, SECOND_PANEL.id]);
    expect(errorsAdded()).toEqual([]);

    registryRefusal = null;
    panel.hass = hassFor(connection);

    await vi.waitFor(() => expect(listed()).toEqual([PANEL.id]));
    expect(errorsAdded()).toEqual([]);
  });

  it("lists the panels, with no error, once the frontend hands it Home Assistant again on reconnecting", async () => {
    registryRefusal = CONNECTION_LOST_RESULT;
    const connection = new FakeConnection();
    const panel = await attach(connection);
    await vi.waitFor(() => expect(shellStatus(panel)).toBe(WAITING));
    await runRetries();

    registryRefusal = null;
    panel.hass = hassFor(connection);

    await vi.waitFor(() => expect(panel.shadowRoot?.querySelector("#panel-select")).not.toBeNull());
    await vi.waitFor(() => expect(tabContent(panel).querySelector(".panel-grid")).not.toBeNull());
    expect(errorsAdded()).toEqual([]);
  });
});
