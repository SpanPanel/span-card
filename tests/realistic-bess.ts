import type { SubDevice } from "../src/types.js";

export const BATTERY_POWER = "sensor.span_panel_battery_battery_power";
export const METER_POWER = "sensor.span_panel_battery_meter_power";
export const BATTERY_LEVEL = "sensor.span_panel_battery_battery_level";
export const BATTERY_SOE = "sensor.span_panel_battery_state_of_energy";
export const BATTERY_CAPACITY = "sensor.span_panel_battery_nameplate_capacity";
export const BATTERY_VENDOR = "sensor.span_panel_battery_vendor";

export const REALISTIC_BESS: SubDevice = {
  name: "Span Panel Battery",
  type: "bess",
  entities: {
    [BATTERY_LEVEL]: { domain: "sensor", original_name: "Battery Level", unique_id: "span_sp3-test-001_battery_level" },
    [BATTERY_POWER]: { domain: "sensor", original_name: "Battery Power", unique_id: "span_sp3-test-001_battery_power" },
    [METER_POWER]: { domain: "sensor", original_name: "Meter Power", unique_id: "span_sp3-test-001_bess_meter_power" },
    [BATTERY_SOE]: { domain: "sensor", original_name: "State of Energy", unique_id: "span_sp3-test-001_bess_soe_kwh" },
    [BATTERY_CAPACITY]: { domain: "sensor", original_name: "Nameplate Capacity", unique_id: "span_sp3-test-001_bess_nameplate_capacity" },
    [BATTERY_VENDOR]: { domain: "sensor", original_name: "Vendor", unique_id: "span_sp3-test-001_bess_vendor" },
  },
};
