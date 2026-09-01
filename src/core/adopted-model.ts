// src/core/adopted-model.ts
import type { AdoptedDeviceGroup, AdoptedRow } from "../types.js";

/**
 * The editable state of one adopted row, as the curation form holds it.
 * ``deviceClass`` and ``stateClass`` use ``""`` for "none".
 */
export interface CurationForm {
  enabled: boolean;
  name: string;
  deviceClass: string;
  stateClass: string;
  promote: boolean;
}

/**
 * The registry state one row's editor was seeded from — what Core holds now,
 * so a save can tell an edit from an untouched control and write nothing when
 * nothing registry-owned moved.
 *
 * Every field is a string in the shape its control carries, so comparing the
 * form against the seed is one string comparison per control rather than a
 * per-field coercion at every call site. ``""`` is "no override" throughout.
 */
export interface RegistrySeed {
  /** ``null`` when the entity is enabled; the disabler's name otherwise. */
  disabledBy: string | null;
  /** The user's name override, ``""`` when the entity carries its own name. */
  name: string;
  /** The sensor display-unit override, ``""`` when the reading shows as published. */
  unit: string;
  /** The sensor display precision, ``""`` when Core chooses it. */
  precision: string;
}

/**
 * The two writes one save makes. Renaming and enabling are Core's registry
 * command; a state class, device class, and prominence are the integration's,
 * since Core has nowhere to put them.
 */
export interface SavePlan {
  /** ``config/entity_registry/update`` payload, or null when the row has no entity yet. */
  registryUpdate: Record<string, unknown> | null;
  /** ``span_panel/adopted/curate`` payload, less the panel device id the caller holds. */
  curate: { key: string; record: Record<string, string> };
}

/** Whether ``needle`` appears in ``haystack``, ignoring case and absent names. */
function matches(haystack: string | null, needle: string): boolean {
  return haystack !== null && haystack.toLowerCase().includes(needle);
}

/**
 * Narrow ``groups`` to what a search query names, matching a device name or a
 * row name. A matched device keeps every row; a device with no surviving rows
 * is dropped. An empty query returns the input untouched.
 */
export function filterGroups(groups: AdoptedDeviceGroup[], query: string): AdoptedDeviceGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  const filtered: AdoptedDeviceGroup[] = [];
  for (const group of groups) {
    if (matches(group.name, needle)) {
      filtered.push(group);
      continue;
    }
    const rows = group.rows.filter(row => matches(row.name, needle));
    if (rows.length > 0) filtered.push({ ...group, rows });
  }
  return filtered;
}

/**
 * Split an edited form into the registry write and the curation write it
 * implies. The record replaces the stored one rather than merging into it, so
 * an all-defaults form yields an empty record, which clears the row.
 */
export function buildSavePlan(row: AdoptedRow, form: CurationForm): SavePlan {
  const record: Record<string, string> = {};
  if (form.deviceClass) record.device_class = form.deviceClass;
  if (form.stateClass) record.state_class = form.stateClass;
  if (form.promote) record.entity_category = "none";

  const registryUpdate =
    row.entity_id === null
      ? null
      : {
          type: "config/entity_registry/update",
          entity_id: row.entity_id,
          name: form.name || null,
          disabled_by: form.enabled ? null : "user",
        };

  return { registryUpdate, curate: { key: row.key, record } };
}

/**
 * Which statistics consequence a save carries, if any: ``total_increasing``
 * declares a resetting total, and dropping a state class the row had discards
 * the statistics recorded under it.
 */
export function statisticsConfirmation(row: AdoptedRow, form: CurationForm): "total_increasing" | "clearing" | null {
  if (form.stateClass === "total_increasing") return "total_increasing";
  if (row.curation.state_class && form.stateClass === "") return "clearing";
  return null;
}

/** Read ``field`` off ``source`` when it is a string, else ``""``. */
function stringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  return typeof value === "string" ? value : "";
}

/**
 * Narrow a ``config/entity_registry/get`` reply into the seed the editor reads,
 * or null when the reply is not a registry entry. An entry is recognised by its
 * ``entity_id``, which every registry entry carries and no error reply does.
 */
export function coerceRegistrySeed(raw: unknown): RegistrySeed | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.entity_id !== "string") return null;

  const options = entry.options && typeof entry.options === "object" ? (entry.options as Record<string, unknown>) : {};
  const sensor = options.sensor && typeof options.sensor === "object" ? (options.sensor as Record<string, unknown>) : {};
  const precision = sensor.display_precision;

  return {
    disabledBy: typeof entry.disabled_by === "string" ? entry.disabled_by : null,
    name: stringField(entry, "name"),
    unit: stringField(sensor, "unit_of_measurement"),
    precision: typeof precision === "number" ? String(precision) : "",
  };
}

/**
 * The form one row's editor opens with: the registry's own values for what the
 * registry owns, and the stored record for what the overlay owns.
 *
 * A row with no registry entry seeds as disabled, which is what it is —
 * adopted entities are registered disabled, and a row whose entity does not
 * exist yet is not enabled by any reading of the word.
 */
export function seedForm(row: AdoptedRow, seed: RegistrySeed | null): CurationForm {
  return {
    enabled: seed !== null && seed.disabledBy === null,
    name: seed === null ? "" : seed.name,
    deviceClass: row.curation.device_class ?? "",
    stateClass: row.curation.state_class ?? "",
    promote: row.curation.entity_category === "none",
  };
}

/**
 * Whether a save has anything to say to Core's registry — used to skip the
 * registry write entirely when it would not change anything.
 *
 * This is what makes "curating never enables" true by construction rather than
 * by the payload happening to echo the current state: an untouched enable
 * selector produces no registry call at all, so a row disabled by the
 * integration is not quietly re-disabled *by the user* on its way past.
 *
 * No seed means the registry was never read, and a write built on a guess is
 * worse than no write, so an unseeded form is never dirty.
 */
export function registryDirty(seed: RegistrySeed | null, form: CurationForm): boolean {
  if (seed === null) return false;
  return form.enabled !== (seed.disabledBy === null) || form.name !== seed.name;
}

/** Whether the enable control still says what the registry says. */
function enableUntouched(seed: RegistrySeed, form: CurationForm): boolean {
  return form.enabled === (seed.disabledBy === null);
}

/**
 * The registry write a save should actually issue, or null when it has nothing
 * to say.
 *
 * ``buildSavePlan`` spells ``disabled_by`` as a two-valued control — enabled or
 * disabled-by-user — because those are the only two values Core's command
 * accepts. But an adopted entity is disabled *by the integration*, which is a
 * third state the payload cannot express, so sending the plan's value verbatim
 * on a save that only renamed something would rewrite that entity as
 * user-disabled while the enable control sat untouched.
 *
 * So the key is dropped whenever the control did not move. Core builds its
 * changes from the keys present in the message
 * (``components/config/entity_registry.py:215-225``), so an absent
 * ``disabled_by`` leaves the disabler exactly as it was — which is the whole
 * point: only a deliberate move of the enable control ever writes it.
 */
export function registryPayload(plan: SavePlan, seed: RegistrySeed | null, form: CurationForm): Record<string, unknown> | null {
  if (plan.registryUpdate === null || seed === null || !registryDirty(seed, form)) return null;
  const payload = { ...plan.registryUpdate };
  if (enableUntouched(seed, form)) delete payload.disabled_by;
  return payload;
}

/**
 * The registry state a write from ``registryPayload`` leaves behind, so a
 * second save of the same form finds nothing to write.
 *
 * The disabler follows the same rule the payload does: an entity left disabled
 * keeps whichever disabler it had, because that is what omitting the key did to
 * it; one the user just disabled becomes theirs.
 */
export function appliedSeed(seed: RegistrySeed, form: CurationForm): RegistrySeed {
  return {
    ...seed,
    disabledBy: form.enabled ? null : (seed.disabledBy ?? "user"),
    name: form.name,
  };
}

/**
 * The ``sensor`` registry options for a display unit and precision. Core
 * replaces the domain's options wholesale on each write, so both fields go on
 * every call; ``null`` restores Core's own choice.
 */
export function sensorOptions(unit: string, precision: string): { unit_of_measurement: string | null; display_precision: number | null } {
  const parsed = Number(precision);
  return {
    unit_of_measurement: unit || null,
    display_precision: precision !== "" && Number.isFinite(parsed) ? parsed : null,
  };
}

/** Whether either display control moved off what the registry holds. */
export function sensorOptionsDirty(seed: RegistrySeed | null, unit: string, precision: string): boolean {
  if (seed === null) return false;
  return unit !== seed.unit || precision !== seed.precision;
}

/**
 * Whether the display unit and precision controls belong on this row: a device
 * class is chosen, the row admits it, and Core reports units to convert
 * between. Core's converter gate makes the controls meaningless otherwise, and
 * ``convertibleUnits`` is Core's own answer for the chosen class rather than a
 * table restated here.
 */
export function showsDisplayUnit(deviceClass: string, allowed: string[], convertibleUnits: string[]): boolean {
  return deviceClass !== "" && allowed.includes(deviceClass) && convertibleUnits.length > 0;
}

/**
 * Render an enum value as a label: ``total_increasing`` reads "Total
 * increasing". Device and state classes are Core's vocabulary, so they are
 * shaped for display rather than translated key by key.
 */
export function humanizeClass(value: string): string {
  if (!value) return "";
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
