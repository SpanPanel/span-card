import { describe, it, expect } from "vitest";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity, findBatteryCapacityEntity } from "../src/helpers/entity-finder.js";
import type { SubDevice } from "../src/types.js";

function makeSubDevice(entities: Record<string, { domain: string; original_name?: string; unique_id?: string }>): SubDevice {
  return { entities } as SubDevice;
}

describe("findSubDevicePowerEntity", () => {
  it("finds power entity by name", () => {
    const sub = makeSubDevice({
      "sensor.bess_power": { domain: "sensor", original_name: "Power" },
    });
    expect(findSubDevicePowerEntity(sub)).toBe("sensor.bess_power");
  });

  it("finds power entity by unique_id suffix", () => {
    const sub = makeSubDevice({
      "sensor.bess_1": { domain: "sensor", original_name: "Something", unique_id: "span_bess_power" },
    });
    expect(findSubDevicePowerEntity(sub)).toBe("sensor.bess_1");
  });

  it("returns null when no power entity exists", () => {
    const sub = makeSubDevice({
      "sensor.bess_temp": { domain: "sensor", original_name: "Temperature" },
    });
    expect(findSubDevicePowerEntity(sub)).toBeNull();
  });

  it("skips non-sensor entities", () => {
    const sub = makeSubDevice({
      "switch.bess_power": { domain: "switch", original_name: "Power" },
    });
    expect(findSubDevicePowerEntity(sub)).toBeNull();
  });
});

describe("findBatteryLevelEntity", () => {
  it("finds by name", () => {
    const sub = makeSubDevice({
      "sensor.batt": { domain: "sensor", original_name: "Battery Level" },
    });
    expect(findBatteryLevelEntity(sub)).toBe("sensor.batt");
  });

  it("finds by unique_id suffix", () => {
    const sub = makeSubDevice({
      "sensor.batt": { domain: "sensor", original_name: "Other", unique_id: "span_battery_level" },
    });
    expect(findBatteryLevelEntity(sub)).toBe("sensor.batt");
  });
});

describe("findBatterySoeEntity", () => {
  it("finds state of energy entity", () => {
    const sub = makeSubDevice({
      "sensor.soe": { domain: "sensor", original_name: "State of Energy" },
    });
    expect(findBatterySoeEntity(sub)).toBe("sensor.soe");
  });
});

describe("findBatteryCapacityEntity", () => {
  it("finds nameplate capacity entity", () => {
    const sub = makeSubDevice({
      "sensor.cap": { domain: "sensor", original_name: "Nameplate Capacity" },
    });
    expect(findBatteryCapacityEntity(sub)).toBe("sensor.cap");
  });
});
