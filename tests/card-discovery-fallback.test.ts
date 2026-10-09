import { describe, it, expect, vi } from "vitest";
import type { HomeAssistant } from "../src/types.js";
import { discoverEntitiesFallback } from "../src/card/card-discovery.js";

const PANEL_ID = "panel-device";
const SERIAL = "nt-0000-test1";
const HEX_ID = "0123456789abcdef0123456789abcdef";

interface Sensor {
  entity_id: string;
  unique_id: string;
  tabs: string;
  friendly_name: string;
}

// Each circuit has a power, an energy, a current and a breaker-rating sensor, all
// carrying the circuit's tabs; only the power sensor stands for the circuit. The
// integration writes the serial into unique ids lower-cased.
function circuitSensors(serial: string, circuitId: string, slug: string, tabs: string): Sensor[] {
  const prefix = `span_${serial.toLowerCase()}_${circuitId}`;
  return [
    { entity_id: `sensor.${slug}_power`, unique_id: `${prefix}_power`, tabs, friendly_name: `${slug} Power` },
    { entity_id: `sensor.${slug}_consumed_energy`, unique_id: `${prefix}_energy_consumed`, tabs, friendly_name: `${slug} Consumed Energy` },
    { entity_id: `sensor.${slug}_current`, unique_id: `${prefix}_current`, tabs, friendly_name: `${slug} Current` },
    { entity_id: `sensor.${slug}_breaker_rating`, unique_id: `${prefix}_breaker_rating`, tabs, friendly_name: `${slug} Breaker Rating` },
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
 * A registry holding the panel and its circuits' sensors, whose unique ids carry
 * `uidSerial`. The panel device names `deviceSerial`, or no serial when it is null.
 * The site power sensor carries `siteAttributes`.
 */
function hassWithRegistry(uidSerial: string = SERIAL, deviceSerial: string | null = uidSerial, siteAttributes: Record<string, unknown> = {}): HomeAssistant {
  const sensors = sensorsFor(uidSerial);
  const sitePower = { entity_id: "sensor.span_panel_site_power", unique_id: `span_${uidSerial.toLowerCase()}_site_power` };
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/device_registry/list":
        return [{ id: PANEL_ID, name: "SPAN Panel", identifiers: deviceSerial === null ? [] : [["span_panel", deviceSerial]] }];
      case "config/entity_registry/list":
        return [...sensors, sitePower].map(s => ({ entity_id: s.entity_id, device_id: PANEL_ID, unique_id: s.unique_id, platform: "span_panel" }));
      case "config/area_registry/list":
        return [];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  const states = Object.fromEntries([
    ...sensors.map(s => [
      s.entity_id,
      { entity_id: s.entity_id, state: "1", attributes: { tabs: s.tabs, friendly_name: s.friendly_name }, last_changed: "", last_updated: "" },
    ]),
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
