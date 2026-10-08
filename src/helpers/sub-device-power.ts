import { SUB_DEVICE_TYPE_BESS } from "../constants.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity } from "./entity-finder.js";
import { readNumber } from "./read-number.js";
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
 *
 * It is exactly what the tile draws: the headline, the site total, and a
 * battery's SoC and SoE, which have charts. Anything else is offered, and
 * shown as a row once it is chosen -- a battery's Meter Power and Nameplate
 * Capacity included, which the tile shows nowhere else.
 */
export function tileRenderedEntityIds(sub: SubDevice): Set<string> {
  const { headlineEid, siteTotalEid } = resolveSubDevicePower(sub);
  const ids: (string | null)[] = [headlineEid, siteTotalEid];
  if (sub.type === SUB_DEVICE_TYPE_BESS) {
    ids.push(findBatteryLevelEntity(sub), findBatterySoeEntity(sub));
  }
  return new Set(ids.filter((eid): eid is string => eid !== null));
}

/** One chart a tile draws: the role that names its key, `sub_{devId}_{role}`, and the entity it plots. */
export interface SubDeviceChart {
  role: string;
  entityId: string;
}

/**
 * The charts a tile draws: its headline's power, and a battery's SoC and SoE.
 * The history loader loads exactly these, and a tile with none has no graph
 * horizon to offer.
 */
export function subDeviceCharts(sub: SubDevice): SubDeviceChart[] {
  const charts: { role: string; entityId: string | null }[] = [{ role: "power", entityId: resolveSubDevicePower(sub).headlineEid }];
  if (sub.type === SUB_DEVICE_TYPE_BESS) {
    charts.push({ role: "soc", entityId: findBatteryLevelEntity(sub) }, { role: "soe", entityId: findBatterySoeEntity(sub) });
  }
  return charts.filter((chart): chart is SubDeviceChart => chart.entityId !== null);
}

/** An entity's state as watts, or null where it has no reading. */
export function stateWatts(hass: HomeAssistant, entityId: string): number | null {
  return readNumber(hass.states[entityId]);
}
