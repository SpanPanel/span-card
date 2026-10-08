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
// carrying the circuit's tabs; only the power sensor stands for the circuit.
function circuitSensors(circuitId: string, slug: string, tabs: string): Sensor[] {
  return [
    { entity_id: `sensor.${slug}_power`, unique_id: `span_${SERIAL}_${circuitId}_power`, tabs, friendly_name: `${slug} Power` },
    {
      entity_id: `sensor.${slug}_consumed_energy`,
      unique_id: `span_${SERIAL}_${circuitId}_energy_consumed`,
      tabs,
      friendly_name: `${slug} Consumed Energy`,
    },
    { entity_id: `sensor.${slug}_current`, unique_id: `span_${SERIAL}_${circuitId}_current`, tabs, friendly_name: `${slug} Current` },
    {
      entity_id: `sensor.${slug}_breaker_rating`,
      unique_id: `span_${SERIAL}_${circuitId}_breaker_rating`,
      tabs,
      friendly_name: `${slug} Breaker Rating`,
    },
  ];
}

const SENSORS: Sensor[] = [
  ...circuitSensors("b-7", "kitchen", "tabs [7]"),
  ...circuitSensors("sub-b-7", "garage", "tabs [9]"),
  ...circuitSensors(HEX_ID, "dryer", "tabs [10:12]"),
  ...circuitSensors("c_12", "office", "tabs [14]"),
];

function hassWithRegistry(): HomeAssistant {
  const callWS = vi.fn(async (msg: { type: string }) => {
    switch (msg.type) {
      case "config/device_registry/list":
        return [{ id: PANEL_ID, name: "SPAN Panel", identifiers: [["span_panel", SERIAL]] }];
      case "config/entity_registry/list":
        return [
          ...SENSORS.map(s => ({ entity_id: s.entity_id, device_id: PANEL_ID, unique_id: s.unique_id, platform: "span_panel" })),
          { entity_id: "sensor.span_panel_site_power", device_id: PANEL_ID, unique_id: `span_${SERIAL}_site_power`, platform: "span_panel" },
        ];
      case "config/area_registry/list":
        return [];
      default:
        throw new Error(`unexpected websocket call ${msg.type}`);
    }
  });
  const states = Object.fromEntries([
    ...SENSORS.map(s => [
      s.entity_id,
      { entity_id: s.entity_id, state: "1", attributes: { tabs: s.tabs, friendly_name: s.friendly_name }, last_changed: "", last_updated: "" },
    ]),
    ["sensor.span_panel_site_power", { entity_id: "sensor.span_panel_site_power", state: "1", attributes: {}, last_changed: "", last_updated: "" }],
  ]);
  return { callWS, states, services: {}, language: "en" } as unknown as HomeAssistant;
}

describe("discoverEntitiesFallback", () => {
  it("finds one circuit per power sensor, whatever its id looks like, `_` included", async () => {
    const { topology } = await discoverEntitiesFallback(hassWithRegistry(), PANEL_ID);

    expect(Object.keys(topology!.circuits).sort()).toEqual([HEX_ID, "b-7", "c_12", "sub-b-7"].sort());
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
});
