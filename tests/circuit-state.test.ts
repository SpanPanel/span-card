import { describe, it, expect } from "vitest";
import {
  getCircuitStateClasses,
  priorityKeyFromWire,
  relayClosed,
  selectOperable,
  shedPriorityKey,
  switchPresence,
  type CircuitControlFields,
} from "../src/core/circuit-state.js";
import type { Circuit, HomeAssistant, MonitoringPointInfo } from "../src/types.js";

const baseCircuit = { name: "Test" } as Circuit;

describe("getCircuitStateClasses", () => {
  it("returns empty string when circuit is on, not producer, no monitoring info", () => {
    expect(getCircuitStateClasses(baseCircuit, null, true, false)).toBe("");
  });

  it("adds circuit-off when isOn is false", () => {
    expect(getCircuitStateClasses(baseCircuit, null, false, false)).toBe("circuit-off");
  });

  it("adds circuit-producer when isProducer is true", () => {
    expect(getCircuitStateClasses(baseCircuit, null, true, true)).toBe("circuit-producer");
  });

  it("adds both when off and producer", () => {
    const result = getCircuitStateClasses(baseCircuit, null, false, true);
    expect(result).toContain("circuit-off");
    expect(result).toContain("circuit-producer");
  });

  it("adds circuit-alert when monitoringInfo indicates alert", () => {
    const info: MonitoringPointInfo = { utilization_pct: 95, over_threshold_since: "2024-01-01T00:00:00Z" };
    const result = getCircuitStateClasses(baseCircuit, info, true, false);
    expect(result).toContain("circuit-alert");
  });

  it("ignores continuous_threshold_pct (custom-monitoring indicator was removed)", () => {
    const info: MonitoringPointInfo = { continuous_threshold_pct: 80 };
    const result = getCircuitStateClasses(baseCircuit, info, true, false);
    expect(result).toBe("");
  });

  it("handles all classes together", () => {
    const info: MonitoringPointInfo = {
      utilization_pct: 99,
      over_threshold_since: "2024-01-01T00:00:00Z",
      continuous_threshold_pct: 80,
    };
    const result = getCircuitStateClasses(baseCircuit, info, false, true);
    expect(result).toContain("circuit-off");
    expect(result).toContain("circuit-producer");
    expect(result).toContain("circuit-alert");
  });
});

const SWITCH = "switch.kitchen_breaker";
const SELECT = "select.kitchen_circuit_priority";
const POWER = "sensor.kitchen_power";

function hassWith(states: Record<string, { state: string; attributes?: Record<string, unknown> }>): HomeAssistant {
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, s]) => [
      entity_id,
      { entity_id, state: s.state, attributes: s.attributes ?? {}, last_changed: "", last_updated: "" },
    ])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

function circuit(overrides: Partial<CircuitControlFields> = {}): CircuitControlFields {
  return { entities: { switch: SWITCH, select: SELECT, power: POWER }, is_user_controllable: true, relay_state: "CLOSED", ...overrides };
}

describe("switchPresence", () => {
  it.each([
    ["on", "operable"],
    ["off", "operable"],
    ["unavailable", "inert"],
    ["unknown", "inert"],
  ])("is %s → %s with a switch role", (state, expected) => {
    expect(switchPresence(circuit(), hassWith({ [SWITCH]: { state } }))).toBe(expected);
  });

  it("is none with no state object", () => {
    expect(switchPresence(circuit(), hassWith({}))).toBe("none");
  });

  it("is none without a switch role, whatever the state", () => {
    expect(switchPresence(circuit({ entities: { power: POWER } }), hassWith({ [SWITCH]: { state: "on" } }))).toBe("none");
  });

  it("is none for a circuit the panel does not let the user control", () => {
    expect(switchPresence(circuit({ is_user_controllable: false }), hassWith({ [SWITCH]: { state: "on" } }))).toBe("none");
  });

  it("is none for a non-admin's guessed switch that does not exist (fallback topology)", () => {
    const guessed = circuit({ entities: { power: POWER, switch: "switch.solar_breaker" } });
    expect(switchPresence(guessed, hassWith({ [POWER]: { state: "0" } }))).toBe("none");
  });
});

describe("relayClosed", () => {
  it("follows an on/off switch", () => {
    expect(relayClosed(circuit({ relay_state: "OPEN" }), hassWith({ [SWITCH]: { state: "on" } }))).toBe(true);
    expect(relayClosed(circuit(), hassWith({ [SWITCH]: { state: "off" } }))).toBe(false);
  });

  it("reads the power sensor's live relay_state while the switch is unavailable", () => {
    const hass = hassWith({ [SWITCH]: { state: "unavailable" }, [POWER]: { state: "0", attributes: { relay_state: "OPEN" } } });
    expect(relayClosed(circuit({ relay_state: "CLOSED" }), hass)).toBe(false);
  });

  it("falls back to the topology's relay_state", () => {
    expect(relayClosed(circuit({ relay_state: "CLOSED" }), hassWith({ [SWITCH]: { state: "unavailable" } }))).toBe(true);
    expect(relayClosed(circuit({ entities: {}, relay_state: "OPEN" }), hassWith({}))).toBe(false);
  });
});

describe("shedPriorityKey", () => {
  it("is always_on for an always-on circuit", () => {
    expect(shedPriorityKey(circuit({ always_on: true }), hassWith({ [SELECT]: { state: "never" } }))).toBe("always_on");
  });

  it("is the select's state when it is a known option", () => {
    expect(shedPriorityKey(circuit(), hassWith({ [SELECT]: { state: "off_grid" } }))).toBe("off_grid");
  });

  it("falls back to the power sensor's shed_priority, then the topology's priority, mapped from the wire", () => {
    const fromAttribute = hassWith({ [SELECT]: { state: "unavailable" }, [POWER]: { state: "0", attributes: { shed_priority: "SOC_THRESHOLD" } } });
    expect(shedPriorityKey(circuit({ priority: "NEVER" }), fromAttribute)).toBe("soc_threshold");
    expect(shedPriorityKey(circuit({ priority: "NEVER" }), hassWith({ [SELECT]: { state: "unavailable" } }))).toBe("never");
  });

  it("is unknown when nothing is known", () => {
    expect(shedPriorityKey(circuit({ priority: "UNKNOWN" }), hassWith({ [SELECT]: { state: "unknown" } }))).toBe("unknown");
  });

  it("never falls back without a select role", () => {
    const noSelect = circuit({ entities: { switch: SWITCH, power: POWER }, priority: "NEVER" });
    expect(shedPriorityKey(noSelect, hassWith({ [POWER]: { state: "0", attributes: { shed_priority: "NEVER" } } }))).toBe("unknown");
  });
});

describe("priorityKeyFromWire", () => {
  it.each([
    ["NEVER", "never"],
    ["SOC_THRESHOLD", "soc_threshold"],
    ["OFF_GRID", "off_grid"],
    ["UNKNOWN", undefined],
    [undefined, undefined],
  ])("maps %s to %s", (wire, key) => {
    expect(priorityKeyFromWire(wire)).toBe(key);
  });
});

describe("selectOperable", () => {
  it("is true only for a select role whose state is a known option", () => {
    expect(selectOperable(circuit(), hassWith({ [SELECT]: { state: "never" } }))).toBe(true);
    expect(selectOperable(circuit(), hassWith({ [SELECT]: { state: "unavailable" } }))).toBe(false);
    expect(selectOperable(circuit(), hassWith({}))).toBe(false);
    expect(selectOperable(circuit({ entities: {} }), hassWith({ [SELECT]: { state: "never" } }))).toBe(false);
  });
});
