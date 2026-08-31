// src/core/adopted-model.ts
import type { AdoptedDeviceGroup, AdoptedRow } from "../types.js";

/**
 * The editable state of one adopted row, as the curation form holds it.
 * ``deviceClass`` and ``stateClass`` use ``""`` for "none".
 */
export interface CurationForm {
  enabled: boolean;
  name: string;
  icon: string;
  deviceClass: string;
  stateClass: string;
  promote: boolean;
}

/**
 * The two writes one save makes. Renaming, icons, and enabling are Core's
 * registry command; a state class, device class, and prominence are the
 * integration's, since Core has nowhere to put them.
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
          icon: form.icon || null,
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
