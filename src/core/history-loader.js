import { getHistoryDurationMs, getMaxHistoryPoints, getMinGapMs, deduplicateAndTrim } from "../helpers/history.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity } from "../helpers/entity-finder.js";
import { SUB_DEVICE_TYPE_BESS, SUB_DEVICE_KEY_PREFIX } from "../constants.js";

async function loadStatisticsHistory(hass, entityIds, uuidByEntity, durationMs, powerHistory) {
  const startTime = new Date(Date.now() - durationMs).toISOString();
  const durationHours = durationMs / (60 * 60 * 1000);
  const period = durationHours > 72 ? "hour" : "5minute";

  const result = await hass.callWS({
    type: "recorder/statistics_during_period",
    start_time: startTime,
    statistic_ids: entityIds,
    period,
    types: ["mean"],
  });

  for (const [entityId, stats] of Object.entries(result)) {
    const uuid = uuidByEntity.get(entityId);
    if (!uuid || !stats) continue;

    const hist = [];
    for (const entry of stats) {
      const val = entry.mean;
      if (val == null || !Number.isFinite(val)) continue;
      const time = entry.start;
      if (time > 0) hist.push({ time, value: val });
    }

    if (hist.length > 0) {
      const existing = powerHistory.get(uuid) || [];
      const merged = [...hist, ...existing];
      merged.sort((a, b) => a.time - b.time);
      powerHistory.set(uuid, merged);
    }
  }
}

async function loadRawHistory(hass, entityIds, uuidByEntity, durationMs, powerHistory) {
  const startTime = new Date(Date.now() - durationMs).toISOString();
  const result = await hass.callWS({
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

    const hist = [];
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
 * Collect entity IDs for sub-devices into the provided arrays.
 *
 * @param {object} topology
 * @param {string[]} entityIds - mutated in place
 * @param {Map<string,string>} uuidByEntity - mutated in place
 */
function _collectSubDeviceEntityIdsInto(topology, entityIds, uuidByEntity) {
  for (const { entityId, key } of collectSubDeviceEntityIds(topology)) {
    entityIds.push(entityId);
    uuidByEntity.set(entityId, key);
  }
}

/**
 * Build the entity ID list for all sub-devices.
 * Returns an array of { entityId, key } pairs so callers can record live samples.
 *
 * @param {object} topology
 * @returns {{ entityId: string, key: string }[]}
 */
export function collectSubDeviceEntityIds(topology) {
  if (!topology.sub_devices) return [];
  const results = [];
  for (const [devId, sub] of Object.entries(topology.sub_devices)) {
    const eidMap = { power: findSubDevicePowerEntity(sub) };
    if (sub.type === SUB_DEVICE_TYPE_BESS) {
      eidMap.soc = findBatteryLevelEntity(sub);
      eidMap.soe = findBatterySoeEntity(sub);
    }
    for (const [role, eid] of Object.entries(eidMap)) {
      if (eid) {
        results.push({ entityId: eid, key: `${SUB_DEVICE_KEY_PREFIX}${devId}_${role}` });
      }
    }
  }
  return results;
}

/**
 * Load historical power data from HA recorder into the powerHistory Map.
 *
 * @param {object} hass
 * @param {object} topology
 * @param {object} config
 * @param {Map<string, {time: number, value: number}[]>} powerHistory - mutated in place
 */
export async function loadHistory(hass, topology, config, powerHistory) {
  if (!topology || !hass) return;

  const durationMs = getHistoryDurationMs(config);
  const entityIds = [];
  const uuidByEntity = new Map();

  for (const [uuid, circuit] of Object.entries(topology.circuits)) {
    const eid = getCircuitChartEntity(circuit, config);
    if (eid) {
      entityIds.push(eid);
      uuidByEntity.set(eid, uuid);
    }
  }

  _collectSubDeviceEntityIdsInto(topology, entityIds, uuidByEntity);

  if (entityIds.length === 0) return;

  const useStatistics = durationMs > 2 * 60 * 60 * 1000;

  if (useStatistics) {
    await loadStatisticsHistory(hass, entityIds, uuidByEntity, durationMs, powerHistory);
  } else {
    await loadRawHistory(hass, entityIds, uuidByEntity, durationMs, powerHistory);
  }
}
