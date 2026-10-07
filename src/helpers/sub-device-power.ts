import { SUB_DEVICE_TYPE_BESS } from "../constants.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity, findBatteryCapacityEntity } from "./entity-finder.js";
import type { HomeAssistant, SubDevice } from "../types.js";

export interface SubDevicePower {
  /** The reading the tile's header shows and its chart draws. */
  headlineEid: string | null;
  /** Whether that reading is the site's total rather than one inverter's. */
  headlineIsSiteTotal: boolean;
  /** The site total, shown as its own row, when the headline is an inverter's circuit. */
  siteTotalEid: string | null;
}

/**
 * The one answer to "what is this tile's power", for every reader of it: the
 * renderer, the live updater and the history loader.
 *
 * A solar tile's power is what the integration's `solar` block says: the
 * feeding circuit's reading, or the site total where the Solar device
 * describes no single metered inverter. Without a block (another device type,
 * or an integration that predates it) the tile keeps today's lookup, which
 * takes the first power-like sensor in registry order.
 */
export function resolveSubDevicePower(sub: SubDevice): SubDevicePower {
  const solar = sub.solar;
  if (!solar) return { headlineEid: findSubDevicePowerEntity(sub), headlineIsSiteTotal: false, siteTotalEid: null };
  if (solar.role === "inverter") return { headlineEid: solar.power_entity_id, headlineIsSiteTotal: false, siteTotalEid: null };
  if (solar.power_entity_id) {
    return { headlineEid: solar.power_entity_id, headlineIsSiteTotal: false, siteTotalEid: solar.site_power_entity_id };
  }
  return { headlineEid: solar.site_power_entity_id, headlineIsSiteTotal: solar.site_power_entity_id !== null, siteTotalEid: null };
}

/**
 * The entities a tile draws itself, which its entity rows leave out and the
 * editor offers no checkbox for. One set for both, so the two cannot disagree.
 * A battery's Meter Power is not among them: the tile does not draw it, so the
 * editor offers it, and the renderer shows it as a row once it is chosen.
 */
export function tileRenderedEntityIds(sub: SubDevice): Set<string> {
  const { headlineEid, siteTotalEid } = resolveSubDevicePower(sub);
  const ids: (string | null)[] = [headlineEid, siteTotalEid];
  if (sub.type === SUB_DEVICE_TYPE_BESS) {
    ids.push(findBatteryLevelEntity(sub), findBatterySoeEntity(sub), findBatteryCapacityEntity(sub));
  }
  return new Set(ids.filter((eid): eid is string => eid !== null));
}

/** An entity's state as watts, or 0 where it has none, as tiles have always read it. */
export function stateWatts(hass: HomeAssistant, entityId: string): number {
  const state = hass.states[entityId];
  return state ? parseFloat(state.state) || 0 : 0;
}
