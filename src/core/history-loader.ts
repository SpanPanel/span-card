import { getHistoryDurationMs, getMaxHistoryPoints, getMinGapMs, deduplicateAndTrim, getHorizonDurationMs } from "../helpers/history.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity } from "../helpers/entity-finder.js";
import { SUB_DEVICE_TYPE_BESS, SUB_DEVICE_KEY_PREFIX, STATISTICS_PERIOD_THRESHOLD_HOURS } from "../constants.js";
import type { HomeAssistant, PanelTopology, CardConfig, HistoryMap, HistoryPoint, SubDeviceEntityRef } from "../types.js";

interface StatisticsEntry {
  start: number;
  mean: number | null;
}

interface RawHistoryEntry {
  s: string;
  lu?: number;
  lc?: number;
}

interface DurationGroup {
  entityIds: string[];
  uuidByEntity: Map<string, string>;
}

async function loadStatisticsHistory(
  hass: HomeAssistant,
  entityIds: string[],
  uuidByEntity: Map<string, string>,
  durationMs: number,
  powerHistory: HistoryMap
): Promise<void> {
  const startTime = new Date(Date.now() - durationMs).toISOString();
  const durationHours = durationMs / (60 * 60 * 1000);
  const period = durationHours > STATISTICS_PERIOD_THRESHOLD_HOURS ? "hour" : "5minute";

  const result = await hass.callWS<Record<string, StatisticsEntry[]>>({
    type: "recorder/statistics_during_period",
    start_time: startTime,
    statistic_ids: entityIds,
    period,
    types: ["mean"],
  });

  for (const [entityId, stats] of Object.entries(result)) {
    const uuid = uuidByEntity.get(entityId);
    if (!uuid || !stats) continue;

    const hist: HistoryPoint[] = [];
    for (const entry of stats) {
      const val = entry.mean;
      if (val == null || !Number.isFinite(val)) continue;
      // HA statistics WS API returns start as epoch milliseconds
      const time = entry.start;
      if (time > 0) hist.push({ time, value: val });
    }

    if (hist.length > 0) {
      const existing = powerHistory.get(uuid) || [];
      const merged = [...hist, ...existing];
      merged.sort((a: HistoryPoint, b: HistoryPoint) => a.time - b.time);
      powerHistory.set(uuid, merged);
    }
  }
}

async function loadRawHistory(
  hass: HomeAssistant,
  entityIds: string[],
  uuidByEntity: Map<string, string>,
  durationMs: number,
  powerHistory: HistoryMap
): Promise<void> {
  const startTime = new Date(Date.now() - durationMs).toISOString();
  const result = await hass.callWS<Record<string, RawHistoryEntry[]>>({
    type: "history/history_during_period",
    start_time: startTime,
    entity_ids: entityIds,
    minimal_response: true,
    significant_changes_only: true,
    no_attributes: true,
  });

  const maxPoints = getMaxHistoryPoints(durationMs);
  const minGapMs = getMinGapMs(durationMs);
  for (const [entityId, states] of Object.entries(result)) {
    const uuid = uuidByEntity.get(entityId);
    if (!uuid || !states) continue;

    const hist: HistoryPoint[] = [];
    for (const entry of states) {
      const val = parseFloat(entry.s);
      if (!Number.isFinite(val)) continue;
      const tsSec = entry.lu || entry.lc || 0;
      const time = tsSec * 1000;
      if (time > 0) hist.push({ time, value: val });
    }

    if (hist.length > 0) {
      const existing = powerHistory.get(uuid) || [];
      const merged = [...hist, ...existing];
      powerHistory.set(uuid, deduplicateAndTrim(merged, maxPoints, minGapMs));
    }
  }
}

/**
 * Build the entity ID list for all sub-devices.
 * Returns an array of { entityId, key, devId } so callers can record live samples.
 */
export function collectSubDeviceEntityIds(topology: PanelTopology): SubDeviceEntityRef[] {
  if (!topology.sub_devices) return [];
  const results: SubDeviceEntityRef[] = [];
  for (const [devId, sub] of Object.entries(topology.sub_devices)) {
    const eidMap: Record<string, string | null> = { power: findSubDevicePowerEntity(sub) };
    if (sub.type === SUB_DEVICE_TYPE_BESS) {
      eidMap.soc = findBatteryLevelEntity(sub);
      eidMap.soe = findBatterySoeEntity(sub);
    }
    for (const [role, eid] of Object.entries(eidMap)) {
      if (eid) {
        results.push({ entityId: eid, key: `${SUB_DEVICE_KEY_PREFIX}${devId}_${role}`, devId });
      }
    }
  }
  return results;
}

/**
 * Load historical power data from HA recorder into the powerHistory Map.
 * Supports per-circuit horizons by grouping circuits by their effective duration.
 */
export async function loadHistory(
  hass: HomeAssistant,
  topology: PanelTopology,
  config: CardConfig,
  powerHistory: HistoryMap,
  horizonMap?: Map<string, string>,
  subDeviceHorizonMap?: Map<string, string>
): Promise<void> {
  if (!topology || !hass) return;

  // Group circuits by effective duration
  const groups = new Map<number, DurationGroup>();

  for (const [uuid, circuit] of Object.entries(topology.circuits)) {
    const eid = getCircuitChartEntity(circuit, config);
    if (!eid) continue;

    let durationMs: number;
    if (horizonMap && horizonMap.has(uuid)) {
      durationMs = getHorizonDurationMs(horizonMap.get(uuid)!);
    } else {
      durationMs = getHistoryDurationMs(config);
    }

    if (!groups.has(durationMs)) {
      groups.set(durationMs, { entityIds: [], uuidByEntity: new Map<string, string>() });
    }
    const group = groups.get(durationMs)!;
    group.entityIds.push(eid);
    group.uuidByEntity.set(eid, uuid);
  }

  // Add sub-device entities grouped by their effective horizon
  for (const { entityId, key, devId } of collectSubDeviceEntityIds(topology)) {
    let durationMs: number;
    if (subDeviceHorizonMap && subDeviceHorizonMap.has(devId)) {
      durationMs = getHorizonDurationMs(subDeviceHorizonMap.get(devId)!);
    } else {
      durationMs = getHistoryDurationMs(config);
    }
    if (!groups.has(durationMs)) {
      groups.set(durationMs, { entityIds: [], uuidByEntity: new Map<string, string>() });
    }
    const group = groups.get(durationMs)!;
    group.entityIds.push(entityId);
    group.uuidByEntity.set(entityId, key);
  }

  // Load each group in parallel
  const promises: Promise<void>[] = [];
  for (const [durationMs, group] of groups) {
    if (group.entityIds.length === 0) continue;
    const useStatistics = durationMs > STATISTICS_PERIOD_THRESHOLD_HOURS * 60 * 60 * 1000;
    if (useStatistics) {
      promises.push(loadStatisticsHistory(hass, group.entityIds, group.uuidByEntity, durationMs, powerHistory));
    } else {
      promises.push(loadRawHistory(hass, group.entityIds, group.uuidByEntity, durationMs, powerHistory));
    }
  }
  await Promise.all(promises);
}
