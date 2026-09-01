import { describe, it, expect } from "vitest";
import {
  appliedSeed,
  coerceRegistrySeed,
  filterGroups,
  buildSavePlan,
  humanizeClass,
  registryDirty,
  registryPayload,
  seedForm,
  sensorOptions,
  sensorOptionsDirty,
  showsDisplayUnit,
  statisticsConfirmation,
} from "../src/core/adopted-model.js";
import type { CurationForm, RegistrySeed } from "../src/core/adopted-model.js";
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

function makeSeed(overrides: Partial<RegistrySeed> = {}): RegistrySeed {
  return { disabledBy: null, name: "", icon: "", unit: "", precision: "", ...overrides };
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

describe("coerceRegistrySeed", () => {
  it("reads the enabled state, the overrides, and the sensor options", () => {
    const seed = coerceRegistrySeed({
      entity_id: "sensor.generator_run_hours",
      disabled_by: null,
      name: "Run Hours",
      icon: "mdi:engine",
      options: { sensor: { unit_of_measurement: "min", display_precision: 1 } },
    });
    expect(seed).toEqual({ disabledBy: null, name: "Run Hours", icon: "mdi:engine", unit: "min", precision: "1" });
  });

  it("reports a disabled entity's disabler verbatim", () => {
    const seed = coerceRegistrySeed({ entity_id: "sensor.x", disabled_by: "integration" });
    expect(seed?.disabledBy).toBe("integration");
  });

  it("renders absent overrides and options as empty strings", () => {
    const seed = coerceRegistrySeed({ entity_id: "sensor.x", disabled_by: null, name: null, icon: null, options: {} });
    expect(seed).toEqual({ disabledBy: null, name: "", icon: "", unit: "", precision: "" });
  });

  it("keeps a zero display precision rather than reading it as absent", () => {
    const seed = coerceRegistrySeed({
      entity_id: "sensor.x",
      disabled_by: null,
      options: { sensor: { display_precision: 0 } },
    });
    expect(seed?.precision).toBe("0");
  });

  it("returns null for a payload that is not a registry entry", () => {
    expect(coerceRegistrySeed(null)).toBeNull();
    expect(coerceRegistrySeed("sensor.x")).toBeNull();
    expect(coerceRegistrySeed({ disabled_by: null })).toBeNull();
  });
});

describe("seedForm", () => {
  it("seeds the curation fields from the stored record", () => {
    const row = makeRow({ curation: { device_class: "power", state_class: "measurement", entity_category: "none" } });
    expect(seedForm(row, makeSeed())).toEqual({ enabled: true, name: "", icon: "", deviceClass: "power", stateClass: "measurement", promote: true });
  });

  it("seeds the name and icon from the registry, not from the wire name", () => {
    const row = makeRow({ name: "Run Hours" });
    const form = seedForm(row, makeSeed({ name: "Generator Hours", icon: "mdi:engine" }));
    expect(form.name).toBe("Generator Hours");
    expect(form.icon).toBe("mdi:engine");
  });

  it("seeds the enable selector from the registry's disabled state", () => {
    expect(seedForm(makeRow(), makeSeed({ disabledBy: "integration" })).enabled).toBe(false);
    expect(seedForm(makeRow(), makeSeed({ disabledBy: null })).enabled).toBe(true);
  });

  it("seeds a row with no registry entry as disabled and unnamed", () => {
    expect(seedForm(makeRow({ entity_id: null }), null)).toEqual({ enabled: false, name: "", icon: "", deviceClass: "", stateClass: "", promote: false });
  });

  it("leaves prominence diagnostic when the record does not promote", () => {
    expect(seedForm(makeRow({ curation: { device_class: "power" } }), makeSeed()).promote).toBe(false);
  });
});

describe("registryDirty", () => {
  it("is false for a form still carrying its seeded registry values", () => {
    const seed = makeSeed({ disabledBy: "integration", name: "Run Hours", icon: "mdi:engine" });
    expect(registryDirty(seed, seedForm(makeRow(), seed))).toBe(false);
  });

  it("stays false when only the curation fields were edited", () => {
    const seed = makeSeed({ disabledBy: "integration" });
    const form = { ...seedForm(makeRow(), seed), deviceClass: "power", stateClass: "measurement", promote: true };
    expect(registryDirty(seed, form)).toBe(false);
  });

  it("is true once the enable selector moves", () => {
    const seed = makeSeed({ disabledBy: "integration" });
    expect(registryDirty(seed, { ...seedForm(makeRow(), seed), enabled: true })).toBe(true);
  });

  it("is true once the name or the icon is edited", () => {
    const seed = makeSeed({ name: "Run Hours" });
    expect(registryDirty(seed, { ...seedForm(makeRow(), seed), name: "Engine Hours" })).toBe(true);
    expect(registryDirty(seed, { ...seedForm(makeRow(), seed), icon: "mdi:engine" })).toBe(true);
  });

  it("is false without a seed, so an unreadable registry is never written blind", () => {
    expect(registryDirty(null, makeForm({ enabled: true, name: "Engine Hours" }))).toBe(false);
  });
});

describe("registryPayload", () => {
  it("omits disabled_by when the enable control was not touched", () => {
    const seed = makeSeed({ disabledBy: "integration" });
    const form = { ...seedForm(makeRow(), seed), name: "Cell Voltage" };
    const payload = registryPayload(buildSavePlan(makeRow(), form), seed, form);

    expect(payload).not.toHaveProperty("disabled_by");
    expect(payload).toEqual({
      type: "config/entity_registry/update",
      entity_id: "sensor.backup_generator_active_power",
      name: "Cell Voltage",
      icon: null,
    });
  });

  it("omits disabled_by on a rename of an already-enabled entity too", () => {
    const seed = makeSeed({ disabledBy: null });
    const form = { ...seedForm(makeRow(), seed), name: "Cell Voltage" };
    expect(registryPayload(buildSavePlan(makeRow(), form), seed, form)).not.toHaveProperty("disabled_by");
  });

  it("clears the disabler when an integration-disabled entity is enabled", () => {
    const seed = makeSeed({ disabledBy: "integration" });
    const form = { ...seedForm(makeRow(), seed), enabled: true };
    expect(registryPayload(buildSavePlan(makeRow(), form), seed, form)).toMatchObject({ disabled_by: null });
  });

  it("disables an enabled entity as the user's own choice", () => {
    const seed = makeSeed({ disabledBy: null });
    const form = { ...seedForm(makeRow(), seed), enabled: false };
    expect(registryPayload(buildSavePlan(makeRow(), form), seed, form)).toMatchObject({ disabled_by: "user" });
  });

  it("carries the enable change alongside a rename", () => {
    const seed = makeSeed({ disabledBy: "integration" });
    const form = { ...seedForm(makeRow(), seed), enabled: true, name: "Cell Voltage" };
    expect(registryPayload(buildSavePlan(makeRow(), form), seed, form)).toMatchObject({ name: "Cell Voltage", disabled_by: null });
  });

  it("is null when nothing registry-owned moved", () => {
    const seed = makeSeed({ disabledBy: "integration", name: "Run Hours" });
    const form = { ...seedForm(makeRow(), seed), stateClass: "measurement" };
    expect(registryPayload(buildSavePlan(makeRow(), form), seed, form)).toBeNull();
  });

  it("is null without a seed, and null for a row with no entity", () => {
    const form = makeForm({ name: "Cell Voltage" });
    expect(registryPayload(buildSavePlan(makeRow(), form), null, form)).toBeNull();
    expect(registryPayload(buildSavePlan(makeRow({ entity_id: null }), form), makeSeed(), form)).toBeNull();
  });
});

describe("appliedSeed", () => {
  it("keeps the integration's disabler when the form left the entity disabled", () => {
    const seed = makeSeed({ disabledBy: "integration" });
    expect(appliedSeed(seed, makeForm({ enabled: false, name: "Cell Voltage" }))).toEqual({
      disabledBy: "integration",
      name: "Cell Voltage",
      icon: "",
      unit: "",
      precision: "",
    });
  });

  it("records the user as the disabler when an enabled entity is disabled", () => {
    expect(appliedSeed(makeSeed({ disabledBy: null }), makeForm({ enabled: false })).disabledBy).toBe("user");
  });

  it("clears the disabler when the entity is enabled", () => {
    expect(appliedSeed(makeSeed({ disabledBy: "integration" }), makeForm({ enabled: true })).disabledBy).toBeNull();
  });

  it("leaves the display options alone", () => {
    const seed = makeSeed({ unit: "mV", precision: "2" });
    expect(appliedSeed(seed, makeForm())).toMatchObject({ unit: "mV", precision: "2" });
  });
});

describe("sensorOptions", () => {
  it("sends the chosen unit and precision", () => {
    expect(sensorOptions("mV", "2")).toEqual({ unit_of_measurement: "mV", display_precision: 2 });
  });

  it("sends null for the as-published unit and the default precision", () => {
    expect(sensorOptions("", "")).toEqual({ unit_of_measurement: null, display_precision: null });
  });

  it("keeps a zero precision rather than dropping it as falsy", () => {
    expect(sensorOptions("V", "0")).toEqual({ unit_of_measurement: "V", display_precision: 0 });
  });

  it("sends null for a precision that is not a number", () => {
    expect(sensorOptions("V", "none")).toEqual({ unit_of_measurement: "V", display_precision: null });
  });
});

describe("sensorOptionsDirty", () => {
  it("is false for the seeded unit and precision", () => {
    expect(sensorOptionsDirty(makeSeed({ unit: "mV", precision: "2" }), "mV", "2")).toBe(false);
  });

  it("is true once either control moves", () => {
    const seed = makeSeed({ unit: "mV", precision: "2" });
    expect(sensorOptionsDirty(seed, "kV", "2")).toBe(true);
    expect(sensorOptionsDirty(seed, "mV", "3")).toBe(true);
  });

  it("is false without a seed", () => {
    expect(sensorOptionsDirty(null, "kV", "3")).toBe(false);
  });
});

describe("showsDisplayUnit", () => {
  it("shows the controls for a convertible device class the row admits", () => {
    expect(showsDisplayUnit("voltage", ["voltage"], ["V", "mV", "kV"])).toBe(true);
  });

  it("hides them while no device class is chosen", () => {
    expect(showsDisplayUnit("", ["voltage"], ["V", "mV"])).toBe(false);
  });

  it("hides them for a device class Core will not convert", () => {
    expect(showsDisplayUnit("power_factor", ["power_factor"], [])).toBe(false);
  });

  it("hides them for a class the row does not admit", () => {
    expect(showsDisplayUnit("energy", ["power"], ["Wh", "kWh"])).toBe(false);
  });
});

describe("humanizeClass", () => {
  it("renders an enum value as a sentence-cased label", () => {
    expect(humanizeClass("total_increasing")).toBe("Total increasing");
    expect(humanizeClass("voltage")).toBe("Voltage");
  });

  it("returns an empty string untouched", () => {
    expect(humanizeClass("")).toBe("");
  });
});
