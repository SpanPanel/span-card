import { describe, it, expect, vi } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import type { DeviceRegistryEntry, EntityRegistryEntry } from "../src/core/registry-types.js";
import { discoverEntitiesFallback } from "../src/card/card-discovery.js";
import { findBatteryLevelEntity, findBatterySoeEntity, findSubDevicePowerEntity } from "../src/helpers/entity-finder.js";

const PANEL_ID = "panel-device";
const SERIAL = "nt-0000-test1";
const HEX_ID = "0123456789abcdef0123456789abcdef";

interface Sensor {
  entity_id: string;
  unique_id: string;
  tabs: string;
  original_name: string;
}

// Each circuit has a power, an energy, a current and a breaker-rating sensor, all
// carrying the circuit's tabs; only the power sensor stands for the circuit. The
// integration writes the serial into unique ids lower-cased.
function circuitSensors(serial: string, circuitId: string, slug: string, tabs: string): Sensor[] {
  const prefix = `span_${serial.toLowerCase()}_${circuitId}`;
  return [
    { entity_id: `sensor.${slug}_power`, unique_id: `${prefix}_power`, tabs, original_name: `${slug} Power` },
    { entity_id: `sensor.${slug}_consumed_energy`, unique_id: `${prefix}_energy_consumed`, tabs, original_name: `${slug} Consumed Energy` },
    { entity_id: `sensor.${slug}_current`, unique_id: `${prefix}_current`, tabs, original_name: `${slug} Current` },
    { entity_id: `sensor.${slug}_breaker_rating`, unique_id: `${prefix}_breaker_rating`, tabs, original_name: `${slug} Breaker Rating` },
  ];
}

function sensorsFor(serial: string): Sensor[] {
  return [
    ...circuitSensors(serial, "b-7", "kitchen", "tabs [7]"),
    ...circuitSensors(serial, "sub-b-7", "garage", "tabs [9]"),
    ...circuitSensors(serial, HEX_ID, "dryer", "tabs [10:12]"),
    ...circuitSensors(serial, "c_12", "office", "tabs [14]"),
  ];
}

/**
 * A registry holding the panel and its circuits' sensors, all on the panel
 * device as an install the integration has not converted keeps them, whose
 * unique ids carry `uidSerial`. The panel device names `deviceSerial`, or no
 * serial when it is null. The site power sensor carries `siteAttributes`.
 */
function hassWithRegistry(uidSerial: string = SERIAL, deviceSerial: string | null = uidSerial, siteAttributes: Record<string, unknown> = {}): HomeAssistant {
  const sensors = sensorsFor(uidSerial);
  const sitePower = { entity_id: "sensor.span_panel_site_power", unique_id: `span_${uidSerial.toLowerCase()}_site_power`, original_name: "Site Power" };
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/device_registry/list":
        return [{ id: PANEL_ID, name: "SPAN Panel", identifiers: deviceSerial === null ? [] : [["span_panel", deviceSerial]] }];
      case "config/entity_registry/list":
        return [...sensors, sitePower].map(s => ({
          entity_id: s.entity_id,
          device_id: PANEL_ID,
          unique_id: s.unique_id,
          platform: "span_panel",
          name: null,
          original_name: s.original_name,
        }));
      case "config/area_registry/list":
        return [];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  const states = Object.fromEntries([
    ...sensors.map(s => [s.entity_id, { entity_id: s.entity_id, state: "1", attributes: { tabs: s.tabs }, last_changed: "", last_updated: "" }]),
    [sitePower.entity_id, { entity_id: sitePower.entity_id, state: "1", attributes: siteAttributes, last_changed: "", last_updated: "" }],
  ]);
  return { callWS, states, services: {}, language: "en" } as unknown as HomeAssistant;
}

const CIRCUIT_IDS = [HEX_ID, "b-7", "c_12", "sub-b-7"].sort();

describe("discoverEntitiesFallback", () => {
  it("finds one circuit per power sensor, whatever its id looks like, `_` included", async () => {
    const { topology } = await discoverEntitiesFallback(hassWithRegistry(), PANEL_ID);

    expect(Object.keys(topology!.circuits).sort()).toEqual(CIRCUIT_IDS);
    expect(topology!.circuits["b-7"]!.tabs).toEqual([7]);
    expect(topology!.circuits["sub-b-7"]!.tabs).toEqual([9]);
    expect(topology!.circuits[HEX_ID]!.tabs).toEqual([10, 12]);
    expect(topology!.circuits["c_12"]!.tabs).toEqual([14]);
  });

  it("takes each circuit's power sensor as its power entity", async () => {
    const { topology } = await discoverEntitiesFallback(hassWithRegistry(), PANEL_ID);

    expect(topology!.circuits["b-7"]!.entities?.power).toBe("sensor.kitchen_power");
    expect(topology!.circuits["sub-b-7"]!.entities?.power).toBe("sensor.garage_power");
    expect(topology!.circuits[HEX_ID]!.entities?.power).toBe("sensor.dryer_power");
    expect(topology!.circuits["c_12"]!.entities?.power).toBe("sensor.office_power");
  });

  it("reads the circuit id after the panel's serial, when the serial holds `_` and upper case", async () => {
    const { topology } = await discoverEntitiesFallback(hassWithRegistry("NT_0000_TEST2"), PANEL_ID);

    expect(Object.keys(topology!.circuits).sort()).toEqual(CIRCUIT_IDS);
  });

  it("reads the circuit id after the second segment when the unique ids do not carry the panel's serial", async () => {
    const { topology } = await discoverEntitiesFallback(hassWithRegistry(SERIAL, null), PANEL_ID);

    expect(Object.keys(topology!.circuits).sort()).toEqual(CIRCUIT_IDS);
  });
});

describe("the panel size the fallback reads", () => {
  it("is the panel_size attribute when it is a positive integer", async () => {
    const { panelSize } = await discoverEntitiesFallback(hassWithRegistry(SERIAL, SERIAL, { panel_size: 32 }), PANEL_ID);
    expect(panelSize).toBe(32);
  });

  it.each([0, -2, 12.5, "32"])("falls back to the circuits when the attribute is %s", async size => {
    const { panelSize } = await discoverEntitiesFallback(hassWithRegistry(SERIAL, SERIAL, { panel_size: size }), PANEL_ID);
    expect(panelSize).toBe(14);
  });
});

// ── Circuits on their own devices ────────────────────────────────────────────
//
// From SPAN Panel 2.3.0 each circuit is a child device of its panel, and its
// entities are named by what they measure. The fixtures below hold registry
// rows as Home Assistant's lists send them; every state carries a
// `friendly_name` no label may be read from.

const BATTERY_ID = "battery-device";
const CHARGER_ID = "charger-device";
const DECOY = "Not the label";
/** The panel's config entry, which owns the panel and each of its devices. */
const SPAN_ENTRY = "span-entry-1";

type Attributes = Record<string, unknown>;

/** Part of an install: devices, entity registry rows, and the attributes of each entity that has a state. */
interface Part {
  devices?: DeviceRegistryEntry[];
  entities?: EntityRegistryEntry[];
  attributes?: Record<string, Attributes>;
}

function hassHolding(...parts: Part[]): HomeAssistant {
  const devices = parts.flatMap(p => p.devices ?? []);
  const entities = parts.flatMap(p => p.entities ?? []);
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/device_registry/list":
        return devices;
      case "config/entity_registry/list":
        return entities;
      case "config/area_registry/list":
        return [];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  const states = Object.fromEntries(
    parts
      .flatMap(p => Object.entries(p.attributes ?? {}))
      .map(([entity_id, attributes]) => [
        entity_id,
        { entity_id, state: "1", attributes: { friendly_name: DECOY, ...attributes }, last_changed: "", last_updated: "" },
      ])
  );
  return { callWS, states, services: {}, language: "en" } as unknown as HomeAssistant;
}

function row(entity_id: string, unique_id: string, device_id: string, names: Pick<EntityRegistryEntry, "name" | "original_name"> = {}): EntityRegistryEntry {
  return { entity_id, unique_id, device_id, platform: "span_panel", area_id: null, name: null, original_name: null, ...names };
}

/** The panel and its site power sensor, which says how many spaces the panel has. */
function panel(device: Partial<DeviceRegistryEntry> = {}, serial: string = SERIAL): Part {
  return {
    devices: [
      {
        id: PANEL_ID,
        name: "SPAN Panel",
        name_by_user: null,
        config_entry_id: SPAN_ENTRY,
        identifiers: [["span_panel", serial]],
        via_device_id: null,
        parent_device_id: null,
        ...device,
      },
    ],
    entities: [row("sensor.span_panel_site_power", `span_${serial.toLowerCase()}_site_power`, PANEL_ID, { original_name: "Site Power" })],
    attributes: { "sensor.span_panel_site_power": { panel_size: 32 } },
  };
}

/** A circuit's device as the device list sends a child device: no `via_device_id`, `model` or `sw_version` key. */
function circuitDevice(circuitId: string, name: string, device: Partial<DeviceRegistryEntry> = {}, serial: string = SERIAL): DeviceRegistryEntry {
  return {
    id: `device-${circuitId}`,
    name,
    name_by_user: null,
    config_entry_id: SPAN_ENTRY,
    identifiers: [["span_panel", `${serial}_circuit_${circuitId}`]],
    parent_device_id: PANEL_ID,
    area_id: null,
    ...device,
  };
}

interface CircuitOptions {
  /** The entity ids of the circuit's entities; by default all share `slug`. */
  ids?: { power?: string; breakerRating?: string; breakerSwitch?: string | null };
  device?: Partial<DeviceRegistryEntry>;
  serial?: string;
  /** The power sensor's own names in the registry. */
  powerNames?: Pick<EntityRegistryEntry, "name" | "original_name">;
}

/**
 * A circuit on a device of its own: its power, current and breaker-rating
 * sensors and its breaker switch, named by what they are. The integration
 * lower-cases the serial in a sensor's unique id and not in a switch's.
 */
function circuitOnItsDevice(circuitId: string, slug: string, name: string, tabs: string, options: CircuitOptions = {}): Part {
  const serial = options.serial ?? SERIAL;
  const device = circuitDevice(circuitId, name, options.device, serial);
  const sensorPrefix = `span_${serial.toLowerCase()}_${circuitId}`;
  const power = options.ids?.power ?? `sensor.${slug}_power`;
  const current = `sensor.${slug}_current`;
  const breakerRating = options.ids?.breakerRating ?? `sensor.${slug}_breaker_rating`;
  const breakerSwitch = options.ids?.breakerSwitch === undefined ? `switch.${slug}_breaker` : options.ids.breakerSwitch;
  return {
    devices: [device],
    entities: [
      row(power, `${sensorPrefix}_power`, device.id, options.powerNames ?? { original_name: "Power" }),
      row(current, `${sensorPrefix}_current`, device.id, { original_name: "Current" }),
      // Disabled until the user enables it, so it has a registry row and no state.
      row(breakerRating, `${sensorPrefix}_breaker_rating`, device.id, { original_name: "Breaker Rating" }),
      ...(breakerSwitch === null ? [] : [row(breakerSwitch, `span_${serial}_relay_${circuitId}`, device.id, { original_name: "Breaker" })]),
    ],
    attributes: {
      [power]: { tabs },
      [current]: { tabs },
      ...(breakerSwitch === null ? {} : { [breakerSwitch]: {} }),
    },
  };
}

/** A circuit's power sensor still on the panel device, as before the integration gives circuits devices. */
function circuitOnThePanel(circuitId: string, slug: string, tabs: string, powerNames: Pick<EntityRegistryEntry, "name" | "original_name">): Part {
  const prefix = `span_${SERIAL}_${circuitId}`;
  return {
    entities: [
      row(`sensor.${slug}_power`, `${prefix}_power`, PANEL_ID, powerNames),
      row(`sensor.${slug}_breaker_rating`, `${prefix}_breaker_rating`, PANEL_ID, { original_name: "Breaker Rating" }),
      row(`switch.${slug}_breaker`, `span_${SERIAL}_relay_${circuitId}`, PANEL_ID, { original_name: "Breaker" }),
    ],
    attributes: { [`sensor.${slug}_power`]: { tabs }, [`switch.${slug}_breaker`]: {} },
  };
}

describe("the fallback on an install whose circuits have devices", () => {
  it("fallback finds circuits on child devices of the panel", async () => {
    const hass = hassHolding(
      panel(),
      circuitOnItsDevice("b-7", "kitchen_outlets", "Kitchen Outlets", "tabs [7]"),
      circuitOnItsDevice(HEX_ID, "dryer", "Dryer", "tabs [10:12]")
    );

    const { topology, panelSize } = await discoverEntitiesFallback(hass, PANEL_ID);

    expect(Object.keys(topology!.circuits).sort()).toEqual([HEX_ID, "b-7"].sort());
    expect(topology!.circuits["b-7"]).toMatchObject({ tabs: [7], device_id: "device-b-7", entities: { power: "sensor.kitchen_outlets_power" } });
    expect(topology!.circuits[HEX_ID]).toMatchObject({ tabs: [10, 12], device_id: `device-${HEX_ID}`, entities: { power: "sensor.dryer_power" } });
    expect(panelSize).toBe(32);
  });

  it("leaves out a circuit on a child device of another panel", async () => {
    const other = circuitOnItsDevice("z-1", "other_panel_oven", "Oven", "tabs [3]", { device: { parent_device_id: "another-panel" }, serial: "nt-9999-other" });

    const { topology } = await discoverEntitiesFallback(hassHolding(panel(), circuitOnItsDevice("b-7", "kitchen", "Kitchen", "tabs [7]"), other), PANEL_ID);

    expect(Object.keys(topology!.circuits)).toEqual(["b-7"]);
  });

  it("does not take a circuit's device for a battery or a charger", async () => {
    const { topology } = await discoverEntitiesFallback(hassHolding(panel(), circuitOnItsDevice("b-7", "kitchen", "Kitchen", "tabs [7]")), PANEL_ID);

    expect(topology!.sub_devices).toEqual({});
  });

  it("fallback labels a circuit by its device name, the user's rename first", async () => {
    const hass = hassHolding(
      panel(),
      circuitOnItsDevice("b-7", "kitchen_outlets", "Kitchen Outlets", "tabs [7]"),
      circuitOnItsDevice("b-9", "bar", "Bar Outlets", "tabs [9]", { device: { name_by_user: "Coffee Bar" } }),
      // The device names the circuit, whatever its power sensor is called.
      circuitOnItsDevice("b-11", "fridge", "Fridge", "tabs [11]", { powerNames: { name: "Cold Stuff Power", original_name: "Power" } })
    );

    const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

    expect(topology!.circuits["b-7"]!.name).toBe("Kitchen Outlets");
    expect(topology!.circuits["b-9"]!.name).toBe("Coffee Bar");
    expect(topology!.circuits["b-11"]!.name).toBe("Fridge");
  });

  // An install the integration has not converted keeps every circuit entity on
  // the panel device, named by its circuit. The card may be newer than the
  // integration, and must label that install as it always has.
  describe("fallback labels an entity still on the panel device from its own registry name", () => {
    it.each([
      ["never renamed", { name: null, original_name: "Kitchen Outlets Power" }, {}, "Kitchen Outlets"],
      ["renamed without the panel's name", { name: "Coffee Bar Power", original_name: "Kitchen Outlets Power" }, {}, "Coffee Bar"],
      ["renamed with the panel's name in front", { name: "SPAN Panel Coffee Bar Power", original_name: "Kitchen Outlets Power" }, {}, "Coffee Bar"],
      ["renamed to a name that does not end in Power", { name: "Coffee Bar", original_name: "Kitchen Outlets Power" }, {}, "Coffee Bar"],
      [
        "on a panel the user renamed",
        { name: "Main Panel Coffee Bar Power", original_name: "Kitchen Outlets Power" },
        { name_by_user: "Main Panel" },
        "Coffee Bar",
      ],
      [
        "renamed with the integration's name for the panel in front, on a panel the user renamed",
        { name: "SPAN Panel Coffee Bar Power", original_name: "Kitchen Outlets Power" },
        { name_by_user: "Main Panel" },
        "Coffee Bar",
      ],
      ["with no name of its own", { name: null, original_name: null }, {}, "sensor.kitchen_outlets_power"],
    ])("%s", async (_case, powerNames, panelDevice, label) => {
      const hass = hassHolding(panel(panelDevice), circuitOnThePanel("b-7", "kitchen_outlets", "tabs [7]", powerNames));

      const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

      expect(topology!.circuits["b-7"]!.name).toBe(label);
      expect(topology!.circuits["b-7"]!.device_id).toBeUndefined();
    });
  });

  describe("fallback finds the breaker switch and rating among the circuit device's entities by unique id", () => {
    it("whatever their entity ids are", async () => {
      // None of the three shares a base: the user renamed two, and nothing ties an entity id to its siblings'.
      const ids = { power: "sensor.kitchen_outlets_power", breakerRating: "sensor.amps_allowed", breakerSwitch: "switch.coffee_bar" };

      const { topology } = await discoverEntitiesFallback(hassHolding(panel(), circuitOnItsDevice("b-7", "kitchen", "Kitchen", "tabs [7]", { ids })), PANEL_ID);

      expect(topology!.circuits["b-7"]!.entities).toEqual({
        power: "sensor.kitchen_outlets_power",
        switch: "switch.coffee_bar",
        breaker_rating: "sensor.amps_allowed",
      });
    });

    it("and names no switch for a circuit that has none", async () => {
      const hass = hassHolding(panel(), circuitOnItsDevice("b-7", "kitchen", "Kitchen", "tabs [7]", { ids: { breakerSwitch: null } }));

      const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

      expect(topology!.circuits["b-7"]!.entities).toEqual({ power: "sensor.kitchen_power", breaker_rating: "sensor.kitchen_breaker_rating" });
    });

    it("never another circuit's, though its id ends with this one's", async () => {
      const hass = hassHolding(
        panel(),
        circuitOnItsDevice("b-7", "kitchen", "Kitchen", "tabs [7]", { ids: { breakerSwitch: null } }),
        circuitOnItsDevice("sub-b-7", "garage", "Garage", "tabs [9]")
      );

      const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

      expect(topology!.circuits["b-7"]!.entities.switch).toBeUndefined();
      expect(topology!.circuits["sub-b-7"]!.entities.switch).toBe("switch.garage_breaker");
    });

    it("on a panel whose serial holds upper case, which a switch's unique id keeps and a sensor's does not", async () => {
      const serial = "NT_0000_TEST2";
      const hass = hassHolding(panel({}, serial), circuitOnItsDevice("b-7", "kitchen", "Kitchen", "tabs [7]", { serial }));

      const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

      expect(topology!.circuits["b-7"]!.entities).toEqual({
        power: "sensor.kitchen_power",
        switch: "switch.kitchen_breaker",
        breaker_rating: "sensor.kitchen_breaker_rating",
      });
    });

    it("among the panel device's entities on an install the integration has not converted", async () => {
      const hass = hassHolding(panel(), circuitOnThePanel("b-7", "kitchen_outlets", "tabs [7]", { original_name: "Kitchen Outlets Power" }));

      const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

      expect(topology!.circuits["b-7"]!.entities).toEqual({
        power: "sensor.kitchen_outlets_power",
        switch: "switch.kitchen_outlets_breaker",
        breaker_rating: "sensor.kitchen_outlets_breaker_rating",
      });
    });
  });
});

// A charger's feed circuit keeps its sensors on the charger's device, named by
// what they measure, while its breaker switch sits on the circuit's own device.
// The integration names a charger's device with the panel's name in front, as
// it names the panel: `SPAN Panel EV Charger (FLEX⁺)`.
describe("the fallback on a charger's feed circuit", () => {
  function charger(device: Partial<DeviceRegistryEntry> = {}, serial: string = SERIAL): DeviceRegistryEntry {
    return {
      id: CHARGER_ID,
      name: "SPAN Panel EV Charger (FLEX⁺)",
      name_by_user: null,
      config_entry_id: SPAN_ENTRY,
      identifiers: [["span_panel", `${serial}_evse_e1`]],
      via_device_id: PANEL_ID,
      parent_device_id: null,
      model: "SPAN Drive",
      ...device,
    };
  }

  /** The feed circuit's power sensor, on the charger's device and named `Power` alone. */
  function feedSensors(device: Partial<DeviceRegistryEntry> = {}, serial: string = SERIAL): Part {
    return {
      devices: [charger(device, serial)],
      entities: [row("sensor.span_drive_power", `span_${serial.toLowerCase()}_ev-1_power`, CHARGER_ID, { original_name: "Power" })],
      attributes: { "sensor.span_drive_power": { tabs: "tabs [30:32]" } },
    };
  }

  /** The feed circuit's own device, which holds its breaker switch. */
  function feedDevice(serial: string = SERIAL): Part {
    return {
      devices: [circuitDevice("ev-1", "Garage Charger", {}, serial)],
      entities: [row("switch.garage_charger_breaker", `span_${serial}_relay_ev-1`, "device-ev-1", { original_name: "Breaker" })],
      attributes: { "switch.garage_charger_breaker": {} },
    };
  }

  it("labels it by the circuit's own device, which holds its breaker switch", async () => {
    const { topology } = await discoverEntitiesFallback(hassHolding(panel(), feedSensors(), feedDevice()), PANEL_ID);

    expect(topology!.circuits["ev-1"]).toMatchObject({
      name: "Garage Charger",
      device_id: "device-ev-1",
      entities: { power: "sensor.span_drive_power", switch: "switch.garage_charger_breaker" },
    });
  });

  // The circuit's device carries the serial as the panel's device spells it; a sensor's unique id lower-cases it.
  it("finds the circuit's own device on a panel whose serial holds upper case", async () => {
    const serial = "NT_0000_TEST2";

    const { topology } = await discoverEntitiesFallback(hassHolding(panel({}, serial), feedSensors({}, serial), feedDevice(serial)), PANEL_ID);

    expect(topology!.circuits["ev-1"]).toMatchObject({
      name: "Garage Charger",
      device_id: "device-ev-1",
      entities: { power: "sensor.span_drive_power", switch: "switch.garage_charger_breaker" },
    });
  });

  // Without a breaker switch the circuit has no device, and its sensor says only what it measures.
  describe("labels it by the charger, without the panel's name in front, where the circuit has no device", () => {
    it.each<[string, Partial<DeviceRegistryEntry>, Partial<DeviceRegistryEntry>, string]>([
      ["as the integration names the charger", {}, {}, "EV Charger (FLEX⁺)"],
      ["as the integration names another charger", { name: "SPAN Panel EV Charger (SPAN Drive)" }, {}, "EV Charger (SPAN Drive)"],
      // The charger's name is built from the integration's name for the panel, whatever the user calls the panel.
      ["on a panel the user renamed", {}, { name_by_user: "Main Panel" }, "EV Charger (FLEX⁺)"],
      ["renamed by the user", { name_by_user: "Garage Charger" }, {}, "Garage Charger"],
      ["renamed by the user with their name for the panel in front", { name_by_user: "Main Panel Charger" }, { name_by_user: "Main Panel" }, "Charger"],
      // The longer of the panel's names is the one in front.
      ["on a panel whose two names start alike", { name: "SPAN Panel EV Charger (FLEX⁺)" }, { name_by_user: "SPAN" }, "EV Charger (FLEX⁺)"],
      ["named as the panel is, and nothing more", { name: "SPAN Panel" }, {}, "SPAN Panel"],
    ])("%s", async (_case, chargerDevice, panelDevice, label) => {
      const { topology } = await discoverEntitiesFallback(hassHolding(panel(panelDevice), feedSensors(chargerDevice)), PANEL_ID);

      expect(topology!.circuits["ev-1"]!.name).toBe(label);
      expect(topology!.circuits["ev-1"]!.device_id).toBeUndefined();
    });
  });

  it("leaves the charger's own tile its device's name whole", async () => {
    const { topology } = await discoverEntitiesFallback(hassHolding(panel(), feedSensors()), PANEL_ID);

    expect(topology!.sub_devices![CHARGER_ID]!.name).toBe("SPAN Panel EV Charger (FLEX⁺)");
  });
});

describe("the fallback's battery", () => {
  const LEVEL = "sensor.span_panel_battery_battery_level";
  const POWER = "sensor.span_panel_battery_battery_power";
  const SOE = "sensor.span_panel_battery_state_of_energy";
  const battery: DeviceRegistryEntry = {
    id: BATTERY_ID,
    name: "SPAN Panel Battery",
    name_by_user: null,
    config_entry_id: SPAN_ENTRY,
    identifiers: [["span_panel", `${SERIAL}_bess`]],
    via_device_id: PANEL_ID,
    parent_device_id: null,
    model: "Battery Storage",
  };

  function batteryWith(names: Record<string, Pick<EntityRegistryEntry, "name" | "original_name">>): Part {
    return {
      devices: [battery],
      entities: [
        row(LEVEL, `span_${SERIAL}_battery_level`, BATTERY_ID, names[LEVEL]),
        row(POWER, `span_${SERIAL}_battery_power`, BATTERY_ID, names[POWER]),
        row(SOE, `span_${SERIAL}_bess_soe_kwh`, BATTERY_ID, names[SOE]),
      ],
      attributes: { [LEVEL]: {}, [POWER]: {}, [SOE]: {} },
    };
  }

  it("fallback battery tile finds its power, level and energy", async () => {
    const hass = hassHolding(
      panel(),
      batteryWith({ [LEVEL]: { original_name: "Battery Level" }, [POWER]: { original_name: "Battery Power" }, [SOE]: { original_name: "State of Energy" } })
    );

    const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

    const tile = topology!.sub_devices![BATTERY_ID]!;
    expect(tile).toMatchObject({ name: "SPAN Panel Battery", type: "bess" });
    expect(tile.entities![LEVEL]).toEqual({ domain: "sensor", original_name: "Battery Level", unique_id: `span_${SERIAL}_battery_level` });
    expect(findSubDevicePowerEntity(tile)).toBe(POWER);
    expect(findBatteryLevelEntity(tile)).toBe(LEVEL);
    expect(findBatterySoeEntity(tile)).toBe(SOE);
  });

  it("finds them by unique id once the user has renamed them", async () => {
    const hass = hassHolding(
      panel(),
      batteryWith({
        [LEVEL]: { name: "Charge", original_name: "Battery Level" },
        [POWER]: { name: "Flow", original_name: "Battery Power" },
        [SOE]: { name: "Stored", original_name: "State of Energy" },
      })
    );

    const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

    const tile = topology!.sub_devices![BATTERY_ID]!;
    expect(tile.entities![LEVEL]!.original_name).toBe("Charge");
    expect(findSubDevicePowerEntity(tile)).toBe(POWER);
    expect(findBatteryLevelEntity(tile)).toBe(LEVEL);
    expect(findBatterySoeEntity(tile)).toBe(SOE);
  });

  it("gives an entity with no name of its own none, never its entity id", async () => {
    const hass = hassHolding(panel(), batteryWith({ [LEVEL]: { name: "", original_name: "Battery Level" } }));

    const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

    const entities = topology!.sub_devices![BATTERY_ID]!.entities!;
    expect(entities[LEVEL]).toEqual({ domain: "sensor", unique_id: `span_${SERIAL}_battery_level` });
    expect(entities[POWER]).toEqual({ domain: "sensor", unique_id: `span_${SERIAL}_battery_power` });
  });

  // Home Assistant 2026.8 split a device a helper had linked itself to into one
  // per config entry, each with the device's identifiers, name and
  // via_device_id, and moved the helper's entities onto the helper's copy.
  it("draws no tile for the copy of the battery a helper owns, though it points at the panel", async () => {
    const copyId = "battery-device-helper-copy";
    const helperCopy: Part = {
      devices: [{ ...battery, id: copyId, config_entry_id: "helper-entry-1" }],
      entities: [
        { ...row("sensor.battery_energy_daily", "helper_daily_energy", copyId, { original_name: "Battery Energy Daily" }), platform: "utility_meter" },
      ],
      attributes: { "sensor.battery_energy_daily": {} },
    };
    const hass = hassHolding(
      panel(),
      helperCopy,
      batteryWith({ [LEVEL]: { original_name: "Battery Level" }, [POWER]: { original_name: "Battery Power" }, [SOE]: { original_name: "State of Energy" } })
    );

    const { topology } = await discoverEntitiesFallback(hass, PANEL_ID);

    expect(Object.keys(topology!.sub_devices!)).toEqual([BATTERY_ID]);
    expect(Object.keys(topology!.sub_devices![BATTERY_ID]!.entities!).sort()).toEqual([LEVEL, POWER, SOE].sort());
  });
});
