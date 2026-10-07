import { describe, it, expect } from "vitest";
import { loadHistory } from "../src/core/history-loader.js";
import type { CardConfig, HistoryMap, HomeAssistant, PanelTopology } from "../src/types.js";

/**
 * One entity can feed several charts. A circuit-fed inverter's tile charts the
 * same circuit power sensor as that circuit's breaker chart, and a Drive's tile
 * charts its feed circuit's sensor, which sits on the charger's device. The
 * recorder answers once per entity, so the loader must give that one answer to
 * every chart that draws it, at every horizon.
 */

const CIRCUIT = "sensor.span_panel_commissioned_pv_system_power";
const SITE_TOTAL = "sensor.span_panel_pv_power";
const DRIVE_CIRCUIT = "sensor.span_panel_garage_charger_power";

interface Call {
  type: string;
  ids: string[];
}

/** A recorder that answers every requested entity with two readings, and records what it was asked. */
function recorder(): { hass: HomeAssistant; calls: Call[] } {
  const calls: Call[] = [];
  const now = Date.now();
  const callWS = async (msg: Record<string, unknown>): Promise<unknown> => {
    const type = msg.type as string;
    if (type === "history/history_during_period") {
      const ids = msg.entity_ids as string[];
      calls.push({ type, ids });
      return Object.fromEntries(
        ids.map(id => [
          id,
          [
            { s: "3100", lu: (now - 120_000) / 1000 },
            { s: "3200", lu: (now - 60_000) / 1000 },
          ],
        ])
      );
    }
    if (type === "recorder/statistics_during_period") {
      const ids = msg.statistic_ids as string[];
      calls.push({ type, ids });
      return Object.fromEntries(
        ids.map(id => [
          id,
          [
            { start: now - 7_200_000, mean: 3000 },
            { start: now - 3_600_000, mean: 3050 },
          ],
        ])
      );
    }
    throw new Error(`unexpected ${type}`);
  };
  return { hass: { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant, calls };
}

const PV_TOPOLOGY = {
  circuits: { c36: { name: "Commissioned PV System", tabs: [36, 38], entities: { power: CIRCUIT }, device_type: "pv" } },
  sub_devices: {
    site: {
      name: "Span Panel Solar",
      type: "pv",
      entities: {},
      solar: { role: "site", vendor: null, model: null, feed_circuit_id: "c36", power_entity_id: CIRCUIT, site_power_entity_id: SITE_TOTAL },
    },
  },
} as unknown as PanelTopology;

const DRIVE_TOPOLOGY = {
  circuits: { c12: { name: "Garage Charger", tabs: [12, 14], entities: { power: DRIVE_CIRCUIT } } },
  sub_devices: {
    drive: {
      name: "Span Panel Drive (Garage Charger)",
      type: "evse",
      entities: { [DRIVE_CIRCUIT]: { domain: "sensor", original_name: "Garage Charger Power", unique_id: "span_sp3-test-001_c12_power" } },
    },
  },
} as unknown as PanelTopology;

function filled(history: HistoryMap, key: string): number {
  return history.get(key)?.length ?? 0;
}

describe("loadHistory with an entity shared by two charts", () => {
  it("fills both the PV breaker chart and the Solar tile chart at the 5-minute horizon, asking for the entity once", async () => {
    const { hass, calls } = recorder();
    const history: HistoryMap = new Map();

    await loadHistory(hass, PV_TOPOLOGY, {} as CardConfig, history);

    expect(filled(history, "c36")).toBe(2);
    expect(filled(history, "sub_site_power")).toBe(2);
    expect(calls).toEqual([{ type: "history/history_during_period", ids: [CIRCUIT] }]);
  });

  it("fills both charts at a long horizon, from statistics, asking for the entity once", async () => {
    const { hass, calls } = recorder();
    const history: HistoryMap = new Map();

    await loadHistory(hass, PV_TOPOLOGY, {} as CardConfig, history, new Map([["c36", "1w"]]), new Map([["site", "1w"]]));

    expect(filled(history, "c36")).toBe(2);
    expect(filled(history, "sub_site_power")).toBe(2);
    expect(calls).toEqual([{ type: "recorder/statistics_during_period", ids: [CIRCUIT] }]);
  });

  it("gives each chart its own array, so a live sample on one does not land on the other", async () => {
    const { hass } = recorder();
    const history: HistoryMap = new Map();

    await loadHistory(hass, PV_TOPOLOGY, {} as CardConfig, history);

    const circuitChart = history.get("c36");
    const tileChart = history.get("sub_site_power");
    expect(circuitChart).toBeDefined();
    expect(tileChart).toBeDefined();
    expect(circuitChart).not.toBe(tileChart);
  });

  it("fills a Drive's breaker chart and its tile chart, whose sensor sits on the charger's device", async () => {
    const { hass, calls } = recorder();
    const history: HistoryMap = new Map();

    await loadHistory(hass, DRIVE_TOPOLOGY, {} as CardConfig, history, new Map([["c12", "1d"]]), new Map([["drive", "1d"]]));

    expect(filled(history, "c12")).toBe(2);
    expect(filled(history, "sub_drive_power")).toBe(2);
    expect(calls).toEqual([{ type: "history/history_during_period", ids: [DRIVE_CIRCUIT] }]);
  });
});
