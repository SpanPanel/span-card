import { describe, it, expect } from "vitest";
import { filterGroups, buildSavePlan, statisticsConfirmation } from "../src/core/adopted-model.js";
import type { CurationForm } from "../src/core/adopted-model.js";
import type { AdoptedDeviceGroup, AdoptedRow } from "../src/types.js";

function makeRow(overrides: Partial<AdoptedRow> = {}): AdoptedRow {
  return {
    key: "sn-1_adopted_generator-1/meter/active-power",
    path: "meter/active-power",
    platform: "sensor",
    entity_id: "sensor.backup_generator_active_power",
    datatype: "float",
    unit: "W",
    settable: false,
    name: "Active Power",
    curation: {},
    allowed_device_classes: ["power"],
    allowed_state_classes: ["measurement", "total", "total_increasing"],
    stale_fields: [],
    ...overrides,
  };
}

function makeGroup(overrides: Partial<AdoptedDeviceGroup> = {}): AdoptedDeviceGroup {
  return {
    device_id: "abc123def456",
    name: "Backup Generator",
    adopted_device: true,
    rows: [makeRow()],
    ...overrides,
  };
}

function makeForm(overrides: Partial<CurationForm> = {}): CurationForm {
  return {
    enabled: true,
    name: "",
    icon: "",
    deviceClass: "",
    stateClass: "",
    promote: false,
    ...overrides,
  };
}

describe("filterGroups", () => {
  it("returns the input unchanged for an empty query", () => {
    const groups = [makeGroup()];
    expect(filterGroups(groups, "")).toBe(groups);
  });

  it("returns the input unchanged for a whitespace-only query", () => {
    const groups = [makeGroup()];
    expect(filterGroups(groups, "   ")).toBe(groups);
  });

  it("keeps only the rows whose name matches, case-insensitively", () => {
    const groups = [
      makeGroup({
        rows: [makeRow({ key: "a", name: "Active Power" }), makeRow({ key: "b", name: "Coolant Temperature" }), makeRow({ key: "c", name: "Run Hours" })],
      }),
    ];
    const result = filterGroups(groups, "POWER");
    expect(result).toHaveLength(1);
    expect(result[0]!.rows.map(r => r.key)).toEqual(["a"]);
  });

  it("keeps every row of a device whose own name matches", () => {
    const groups = [
      makeGroup({
        name: "Backup Generator",
        rows: [makeRow({ key: "a", name: "Active Power" }), makeRow({ key: "b", name: "Coolant Temperature" })],
      }),
    ];
    const result = filterGroups(groups, "generator");
    expect(result).toHaveLength(1);
    expect(result[0]!.rows.map(r => r.key)).toEqual(["a", "b"]);
  });

  it("drops groups with no surviving rows", () => {
    const groups = [
      makeGroup({ name: "Backup Generator", rows: [makeRow({ key: "a", name: "Active Power" })] }),
      makeGroup({ name: "Well Pump", rows: [makeRow({ key: "b", name: "Coolant Temperature" })] }),
    ];
    const result = filterGroups(groups, "power");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Backup Generator");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterGroups([makeGroup()], "nothing here")).toEqual([]);
  });

  it("matches rows on a group whose name is null", () => {
    const groups = [
      makeGroup({
        device_id: null,
        name: null,
        rows: [makeRow({ key: "a", name: "Active Power" }), makeRow({ key: "b", name: "Run Hours" })],
      }),
    ];
    const result = filterGroups(groups, "run");
    expect(result[0]!.rows.map(r => r.key)).toEqual(["b"]);
  });

  it("does not mutate the groups it filters", () => {
    const group = makeGroup({
      rows: [makeRow({ key: "a", name: "Active Power" }), makeRow({ key: "b", name: "Run Hours" })],
    });
    filterGroups([group], "run");
    expect(group.rows.map(r => r.key)).toEqual(["a", "b"]);
  });
});

describe("buildSavePlan", () => {
  it("builds a registry update for a registered row", () => {
    const plan = buildSavePlan(makeRow({ entity_id: "sensor.generator_active_power" }), makeForm({ name: "Generator Output", icon: "mdi:flash" }));
    expect(plan.registryUpdate).toEqual({
      type: "config/entity_registry/update",
      entity_id: "sensor.generator_active_power",
      name: "Generator Output",
      icon: "mdi:flash",
      disabled_by: null,
    });
  });

  it("sends null rather than an empty string for a blank name and icon", () => {
    const plan = buildSavePlan(makeRow(), makeForm());
    expect(plan.registryUpdate).toMatchObject({ name: null, icon: null });
  });

  it("disables the entity when the form is not enabled", () => {
    const plan = buildSavePlan(makeRow(), makeForm({ enabled: false }));
    expect(plan.registryUpdate).toMatchObject({ disabled_by: "user" });
  });

  it("re-enables the entity when the form is enabled", () => {
    const plan = buildSavePlan(makeRow(), makeForm({ enabled: true }));
    expect(plan.registryUpdate).toMatchObject({ disabled_by: null });
  });

  it("still curates a row that has no entity in the registry yet", () => {
    const plan = buildSavePlan(
      makeRow({ key: "sn-1_adopted_generator-1/meter/active-power", entity_id: null }),
      makeForm({ deviceClass: "power", stateClass: "measurement" })
    );
    expect(plan.registryUpdate).toBeNull();
    expect(plan.curate).toEqual({
      key: "sn-1_adopted_generator-1/meter/active-power",
      record: { device_class: "power", state_class: "measurement" },
    });
  });

  it("carries the device class and state class when they are set", () => {
    const plan = buildSavePlan(makeRow(), makeForm({ deviceClass: "energy", stateClass: "total_increasing" }));
    expect(plan.curate.record).toEqual({ device_class: "energy", state_class: "total_increasing" });
  });

  it("promotes the entity out of the diagnostic category", () => {
    const plan = buildSavePlan(makeRow(), makeForm({ promote: true }));
    expect(plan.curate.record).toEqual({ entity_category: "none" });
  });

  it("yields an empty record for an all-defaults form", () => {
    const plan = buildSavePlan(makeRow(), makeForm());
    expect(plan.curate.record).toEqual({});
  });

  it("keys the curation on the row key", () => {
    const plan = buildSavePlan(makeRow({ key: "sn-1_adopted_pump-2/meter/voltage" }), makeForm());
    expect(plan.curate.key).toBe("sn-1_adopted_pump-2/meter/voltage");
  });
});

describe("statisticsConfirmation", () => {
  it("warns when the user picks total_increasing", () => {
    expect(statisticsConfirmation(makeRow(), makeForm({ stateClass: "total_increasing" }))).toBe("total_increasing");
  });

  it("warns when a stored state class is being cleared", () => {
    const row = makeRow({ curation: { state_class: "measurement" } });
    expect(statisticsConfirmation(row, makeForm({ stateClass: "" }))).toBe("clearing");
  });

  it("does not warn when a stored state class is kept", () => {
    const row = makeRow({ curation: { state_class: "measurement" } });
    expect(statisticsConfirmation(row, makeForm({ stateClass: "measurement" }))).toBeNull();
  });

  it("does not warn when an uncurated row is left without a state class", () => {
    expect(statisticsConfirmation(makeRow(), makeForm({ stateClass: "" }))).toBeNull();
  });

  it("prefers the total_increasing warning over the clearing one", () => {
    const row = makeRow({ curation: { state_class: "measurement" } });
    expect(statisticsConfirmation(row, makeForm({ stateClass: "total_increasing" }))).toBe("total_increasing");
  });
});
