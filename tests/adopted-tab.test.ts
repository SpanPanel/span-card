import { describe, it, expect, beforeEach } from "vitest";
import { AdoptedTab } from "../src/panel/tab-adopted.js";
import type { AdoptedListResponse, AdoptedRow, HomeAssistant } from "../src/types.js";

/** Let the tab's fire-and-forget handlers settle before asserting. */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function row(overrides: Partial<AdoptedRow> = {}): AdoptedRow {
  return {
    key: "example-vendor-bess/battery-2/cell-voltage",
    path: "battery-2/cell-voltage",
    platform: "sensor",
    entity_id: "sensor.battery_2_cell_voltage",
    datatype: "float",
    unit: "V",
    settable: false,
    name: "Battery 2 Cell Voltage",
    curation: {},
    allowed_device_classes: ["voltage"],
    allowed_state_classes: ["measurement", "total", "total_increasing"],
    stale_fields: [],
    ...overrides,
  };
}

const VOLTAGE_KEY = "example-vendor-bess/battery-2/cell-voltage";
const HOURS_KEY = "sn-1_adopted_generator/engine/run-hours";
const RELAY_KEY = "sn-1_adopted_generator/engine/starter";

function listResponse(): AdoptedListResponse {
  return {
    devices: [
      {
        device_id: "dev-battery",
        name: "Battery",
        adopted_device: false,
        rows: [
          row(),
          row({
            key: "example-vendor-bess/battery-2/balancer",
            path: "battery-2/balancer",
            platform: "binary_sensor",
            entity_id: "binary_sensor.battery_2_balancer",
            datatype: "boolean",
            unit: null,
            name: "Battery 2 Balancer Status",
            curation: { device_class: "problem" },
            allowed_device_classes: ["problem", "running"],
            allowed_state_classes: [],
          }),
        ],
      },
      {
        device_id: "dev-generator",
        name: "Backup Generator",
        adopted_device: true,
        rows: [
          row({
            key: HOURS_KEY,
            path: "engine/run-hours",
            entity_id: "sensor.backup_generator_run_hours",
            unit: "h",
            name: "Run Hours",
            curation: { state_class: "total" },
            allowed_device_classes: ["duration"],
            stale_fields: ["device_class"],
          }),
          row({
            key: RELAY_KEY,
            path: "engine/starter",
            platform: "switch",
            entity_id: null,
            datatype: "boolean",
            unit: null,
            settable: true,
            name: "Starter",
            allowed_device_classes: [],
            allowed_state_classes: [],
          }),
        ],
      },
    ],
  };
}

const CONVERTIBLE: Record<string, string[]> = {
  voltage: ["V", "kV", "mV"],
  duration: ["h", "min", "s"],
};

interface FakeHass extends HomeAssistant {
  calls: Record<string, unknown>[];
}

function makeHass(options: { disabledBy?: string | null; failCurate?: string; warnings?: string[] } = {}): FakeHass {
  const calls: Record<string, unknown>[] = [];
  const hass = {
    calls,
    states: {},
    services: {},
    language: "en",
    user: { is_admin: true },
    callService: async (): Promise<void> => undefined,
    callWS: async <T>(msg: Record<string, unknown>): Promise<T> => {
      calls.push(msg);
      switch (msg.type) {
        case "span_panel/adopted/list":
          return listResponse() as T;
        case "config/entity_registry/get":
          return {
            entity_id: msg.entity_id,
            disabled_by: options.disabledBy === undefined ? "integration" : options.disabledBy,
            name: null,
            options: {},
          } as T;
        case "sensor/device_class_convertible_units":
          return { units: CONVERTIBLE[String(msg.device_class)] ?? [] } as T;
        case "config/entity_registry/update":
          return {} as T;
        case "span_panel/adopted/curate":
          if (options.failCurate) throw new Error(options.failCurate);
          return { record: msg.record, warnings: options.warnings ?? [] } as T;
        default:
          throw new Error(`unexpected websocket command ${String(msg.type)}`);
      }
    },
  } as unknown as FakeHass;
  return hass;
}

function writes(hass: FakeHass): Record<string, unknown>[] {
  return hass.calls.filter(call => call.type === "config/entity_registry/update" || call.type === "span_panel/adopted/curate");
}

function click(container: HTMLElement, selector: string): void {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`no element matched ${selector}`);
  element.dispatchEvent(new Event("click", { bubbles: true }));
}

function header(container: HTMLElement, key: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`.adopted-row-header[data-key="${key}"]`);
  if (!element) throw new Error(`no row header for ${key}`);
  return element;
}

async function expand(container: HTMLElement, key: string): Promise<void> {
  header(container, key).dispatchEvent(new Event("click", { bubbles: true }));
  await flush();
}

function select(container: HTMLElement, field: string): HTMLSelectElement {
  const element = container.querySelector<HTMLSelectElement>(`select[data-field="${field}"]`);
  if (!element) throw new Error(`no select for ${field}`);
  return element;
}

/** The option the view marked selected, which is what a browser would show. */
function selectedOption(container: HTMLElement, field: string): string | null {
  return select(container, field).querySelector<HTMLOptionElement>("option[selected]")?.value ?? null;
}

async function choose(container: HTMLElement, field: string, value: string): Promise<void> {
  const element = select(container, field);
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}

function type(container: HTMLElement, field: string, value: string): void {
  const element = container.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
  if (!element) throw new Error(`no input for ${field}`);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function press(container: HTMLElement, action: string): Promise<void> {
  click(container, `[data-action="${action}"]`);
  await flush();
}

async function pressValue(container: HTMLElement, action: string, value: string): Promise<void> {
  click(container, `[data-action="${action}"][data-value="${value}"]`);
  await flush();
}

describe("AdoptedTab", () => {
  let container: HTMLElement;
  let tab: AdoptedTab;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    tab = new AdoptedTab();
  });

  describe("the list", () => {
    it("asks the integration for the selected panel's rows", async () => {
      const hass = makeHass();
      await tab.render(container, hass, "panel-device-1");
      expect(hass.calls[0]).toEqual({ type: "span_panel/adopted/list", device_id: "panel-device-1" });
    });

    it("groups rows under their device, badged by where the card came from", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      expect(container.textContent).toContain("Battery");
      expect(container.textContent).toContain("VENDOR READINGS");
      expect(container.textContent).toContain("Backup Generator");
      expect(container.textContent).toContain("ADOPTED DEVICE");
    });

    it("shows a collapsed row's platform and unit, and marks a curated one", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      const collapsed = header(container, VOLTAGE_KEY).textContent ?? "";
      expect(collapsed).toContain("Battery 2 Cell Voltage");
      expect(collapsed).toContain("sensor · V");
      expect(collapsed).not.toContain("CURATED");
      expect(header(container, HOURS_KEY).textContent).toContain("CURATED");
    });

    it("shows no enable state on a collapsed row, even beside an expanded one", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      expect(header(container, HOURS_KEY).textContent).toContain("Run Hours");
      for (const key of [VOLTAGE_KEY, HOURS_KEY, RELAY_KEY]) {
        expect(header(container, key).textContent).not.toContain("ENABLED");
        expect(header(container, key).textContent).not.toContain("DISABLED");
      }
    });

    it("marks a row whose stored record the wire has outgrown", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      expect(header(container, HOURS_KEY).textContent).toContain("STALE");
      await expand(container, HOURS_KEY);
      expect(container.textContent).toContain("device_class");
    });

    it("narrows the list as the filter is typed, without losing the filter box", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      const filter = container.querySelector<HTMLInputElement>("#adopted-filter");
      filter!.value = "run";
      filter!.dispatchEvent(new Event("input", { bubbles: true }));
      expect(container.textContent).toContain("Run Hours");
      expect(container.textContent).not.toContain("Battery 2 Cell Voltage");
      expect(container.querySelector("#adopted-filter")).toBe(filter);
    });

    it("reports a refused list rather than rendering an empty view", async () => {
      const hass = makeHass();
      hass.callWS = async (): Promise<never> => {
        throw new Error("SPAN Panel integration is not loaded");
      };
      await tab.render(container, hass, "panel-device-1");
      expect(container.textContent).toContain("SPAN Panel integration is not loaded");
    });
  });

  describe("the editor", () => {
    it("seeds the enable selector from the entity's registry state", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      expect(hass.calls).toContainEqual({ type: "config/entity_registry/get", entity_id: "sensor.battery_2_cell_voltage" });
      expect(container.textContent).toContain("DISABLED");
    });

    it("offers only the device and state classes the row admits", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      const deviceClasses = [...select(container, "device_class").options].map(option => option.value);
      expect(deviceClasses).toEqual(["", "voltage"]);
      const stateClasses = [...select(container, "state_class").options].map(option => option.value);
      expect(stateClasses).toEqual(["", "measurement", "total", "total_increasing"]);
    });

    it("opens on what was stored for the row", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, HOURS_KEY);
      // The rendered ``selected`` attribute rather than ``select.value``:
      // happy-dom does not apply the attribute when it parses innerHTML.
      expect(selectedOption(container, "state_class")).toBe("total");
      expect(selectedOption(container, "device_class")).toBe("");
    });

    it("drops both class selects on a control row, keeping prominence", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, RELAY_KEY);
      expect(container.querySelector('select[data-field="device_class"]')).toBeNull();
      expect(container.querySelector('select[data-field="state_class"]')).toBeNull();
      expect(container.textContent).toContain("Prominence");
    });

    it("hides the registry-owned fields for a row that has no entity yet", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, RELAY_KEY);
      expect(container.querySelector('[data-action="toggle-enable"]')).toBeNull();
      expect(container.querySelector('input[data-field="name"]')).toBeNull();
      expect(container.textContent).toContain("Enable and name become available");
    });

    it("collapses the row again on a second click", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      expect(container.querySelector('[data-action="save"]')).not.toBeNull();
      await expand(container, VOLTAGE_KEY);
      expect(container.querySelector('[data-action="save"]')).toBeNull();
    });
  });

  describe("the display unit controls", () => {
    it("stay hidden until a device class is chosen", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      expect(container.querySelector('select[data-field="unit"]')).toBeNull();
    });

    it("appear for a device class Core will convert", async () => {
      const hass = makeHass();
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "device_class", "voltage");
      expect(hass.calls).toContainEqual({ type: "sensor/device_class_convertible_units", device_class: "voltage" });
      expect([...select(container, "unit").options].map(option => option.value)).toEqual(["", "V", "kV", "mV"]);
      expect(container.querySelector('select[data-field="precision"]')).not.toBeNull();
    });

    it("stay hidden for a device class Core converts nothing for", async () => {
      await tab.render(container, makeHass(), "panel-device-1");
      await expand(container, "example-vendor-bess/battery-2/balancer");
      await choose(container, "device_class", "problem");
      expect(container.querySelector('select[data-field="unit"]')).toBeNull();
    });
  });

  describe("saving", () => {
    it("routes device class, state class, and prominence to the curate command alone", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "device_class", "voltage");
      await choose(container, "state_class", "measurement");
      await pressValue(container, "prominence", "standard");
      await press(container, "save");

      expect(writes(hass)).toEqual([
        {
          type: "span_panel/adopted/curate",
          device_id: "panel-device-1",
          key: VOLTAGE_KEY,
          record: { device_class: "voltage", state_class: "measurement", entity_category: "none" },
        },
      ]);
      tab.stop();
    });

    it("leaves a row diagnostic when prominence is put back", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await pressValue(container, "prominence", "standard");
      await pressValue(container, "prominence", "diagnostic");
      await press(container, "save");

      expect(writes(hass)).toEqual([{ type: "span_panel/adopted/curate", device_id: "panel-device-1", key: VOLTAGE_KEY, record: {} }]);
      tab.stop();
    });

    it("never touches disabled_by when only curation was edited", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "state_class", "measurement");
      await press(container, "save");

      expect(hass.calls.some(call => call.type === "config/entity_registry/update")).toBe(false);
      tab.stop();
    });

    it("routes the enable selector to Core's registry update, before the curate call", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await press(container, "toggle-enable");
      await press(container, "save");

      expect(writes(hass)).toEqual([
        {
          type: "config/entity_registry/update",
          entity_id: "sensor.battery_2_cell_voltage",
          name: null,
          disabled_by: null,
        },
        { type: "span_panel/adopted/curate", device_id: "panel-device-1", key: VOLTAGE_KEY, record: {} },
      ]);
      tab.stop();
    });

    it("routes a rename to Core's registry update", async () => {
      const hass = makeHass({ disabledBy: null });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      type(container, "name", "Cell Voltage");
      await press(container, "save");

      expect(writes(hass)[0]).toEqual({
        type: "config/entity_registry/update",
        entity_id: "sensor.battery_2_cell_voltage",
        name: "Cell Voltage",
      });
      tab.stop();
    });

    it("renames an integration-disabled entity without rewriting its disabler", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      type(container, "name", "Cell Voltage");
      await press(container, "save");

      // The enable control never moved, so the payload must not carry
      // ``disabled_by`` at all — sending it would turn an entity the
      // integration disabled into one the user disabled.
      expect(writes(hass)[0]).not.toHaveProperty("disabled_by");
      expect(writes(hass)[0]).toEqual({
        type: "config/entity_registry/update",
        entity_id: "sensor.battery_2_cell_voltage",
        name: "Cell Voltage",
      });
      tab.stop();
    });

    it("disables an enabled entity as the user's own choice", async () => {
      const hass = makeHass({ disabledBy: null });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await press(container, "toggle-enable");
      await press(container, "save");

      expect(writes(hass)[0]).toMatchObject({ disabled_by: "user" });
      tab.stop();
    });

    it("writes the disabler once, not again on a second save of the same form", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await press(container, "toggle-enable");
      await press(container, "save");
      await press(container, "save");

      const registryWrites = writes(hass).filter(call => call.type === "config/entity_registry/update");
      expect(registryWrites).toEqual([
        {
          type: "config/entity_registry/update",
          entity_id: "sensor.battery_2_cell_voltage",
          name: null,
          disabled_by: null,
        },
      ]);
      tab.stop();
    });

    it("routes the display unit and precision to the sensor options", async () => {
      const hass = makeHass({ disabledBy: null });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "device_class", "voltage");
      await choose(container, "unit", "mV");
      await choose(container, "precision", "2");
      await press(container, "save");

      expect(writes(hass)).toEqual([
        {
          type: "config/entity_registry/update",
          entity_id: "sensor.battery_2_cell_voltage",
          options_domain: "sensor",
          options: { unit_of_measurement: "mV", display_precision: 2 },
        },
        {
          type: "span_panel/adopted/curate",
          device_id: "panel-device-1",
          key: VOLTAGE_KEY,
          record: { device_class: "voltage" },
        },
      ]);
      tab.stop();
    });

    it("clears a record without writing anything to the registry", async () => {
      const hass = makeHass({ disabledBy: "integration" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, "example-vendor-bess/battery-2/balancer");
      await press(container, "clear");

      expect(writes(hass)).toEqual([
        {
          type: "span_panel/adopted/curate",
          device_id: "panel-device-1",
          key: "example-vendor-bess/battery-2/balancer",
          record: {},
        },
      ]);
      tab.stop();
    });

    it("renders a refusal on the row it came from", async () => {
      const hass = makeHass({ failCurate: "state_class is not admissible on a binary sensor" });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "state_class", "measurement");
      await press(container, "save");
      expect(container.textContent).toContain("state_class is not admissible on a binary sensor");
      tab.stop();
    });

    it("reports the statistics consequences the saved record does not show", async () => {
      const hass = makeHass({ warnings: ["statistics_removed"] });
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await press(container, "save");
      expect(container.textContent).toContain("repair against the statistics already collected");
      tab.stop();
    });
  });

  describe("the statistics confirmations", () => {
    it("holds a total_increasing save until it is confirmed", async () => {
      const hass = makeHass();
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "state_class", "total_increasing");
      await press(container, "save");

      expect(writes(hass)).toEqual([]);
      expect(container.textContent).toContain("Confirm statistics class");
      expect(container.textContent).toContain("Total increasing treats every drop");

      await press(container, "confirm-save");
      expect(writes(hass)).toEqual([
        {
          type: "span_panel/adopted/curate",
          device_id: "panel-device-1",
          key: VOLTAGE_KEY,
          record: { state_class: "total_increasing" },
        },
      ]);
      tab.stop();
    });

    it("writes nothing when the confirmation is cancelled", async () => {
      const hass = makeHass();
      await tab.render(container, hass, "panel-device-1");
      await expand(container, VOLTAGE_KEY);
      await choose(container, "state_class", "total_increasing");
      await press(container, "save");
      await press(container, "confirm-cancel");

      expect(writes(hass)).toEqual([]);
      expect(container.textContent).not.toContain("Confirm statistics class");
      tab.stop();
    });

    it("holds a save that drops a stored state class until it is confirmed", async () => {
      const hass = makeHass();
      await tab.render(container, hass, "panel-device-1");
      await expand(container, HOURS_KEY);
      await choose(container, "state_class", "");
      await press(container, "save");

      expect(writes(hass)).toEqual([]);
      expect(container.textContent).toContain("You are clearing the statistics class on Run Hours");

      await press(container, "confirm-save");
      expect(writes(hass)).toEqual([{ type: "span_panel/adopted/curate", device_id: "panel-device-1", key: HOURS_KEY, record: {} }]);
      tab.stop();
    });

    it("confirms a clear that discards a stored state class", async () => {
      const hass = makeHass();
      await tab.render(container, hass, "panel-device-1");
      await expand(container, HOURS_KEY);
      await press(container, "clear");

      expect(writes(hass)).toEqual([]);
      expect(container.textContent).toContain("Confirm statistics class");
      tab.stop();
    });
  });
});
