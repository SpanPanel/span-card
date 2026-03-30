import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { t } from "../i18n.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity, findBatteryCapacityEntity } from "../helpers/entity-finder.js";
import { SUB_DEVICE_TYPE_BESS, SUB_DEVICE_TYPE_EVSE, SUB_DEVICE_KEY_PREFIX } from "../constants.js";

/**
 * Build the HTML for all sub-devices (BESS, EVSE, etc.) in the topology.
 *
 * @param {object} topology - Discovered panel topology
 * @param {object} hass - Home Assistant object
 * @param {object} config - Card configuration
 * @param {number} _durationMs - History duration in milliseconds (reserved)
 * @returns {string} HTML string
 */
export function buildSubDevicesHTML(topology, hass, config, _durationMs) {
  const showBattery = config.show_battery !== false;
  const showEvse = config.show_evse !== false;
  let subDevHTML = "";

  if (!topology.sub_devices) return subDevHTML;

  for (const [devId, sub] of Object.entries(topology.sub_devices)) {
    if (sub.type === SUB_DEVICE_TYPE_BESS && !showBattery) continue;
    if (sub.type === SUB_DEVICE_TYPE_EVSE && !showEvse) continue;

    const label =
      sub.type === SUB_DEVICE_TYPE_EVSE ? t("subdevice.ev_charger") : sub.type === SUB_DEVICE_TYPE_BESS ? t("subdevice.battery") : t("subdevice.fallback");
    const powerEid = findSubDevicePowerEntity(sub);
    const powerState = powerEid ? hass.states[powerEid] : null;
    const powerW = powerState ? parseFloat(powerState.state) || 0 : 0;

    const isBess = sub.type === SUB_DEVICE_TYPE_BESS;
    const battLevelEid = isBess ? findBatteryLevelEntity(sub) : null;
    const battSoeEid = isBess ? findBatterySoeEntity(sub) : null;
    const battCapEid = isBess ? findBatteryCapacityEntity(sub) : null;

    const hideEids = new Set([powerEid, battLevelEid, battSoeEid, battCapEid].filter(Boolean));
    const entHTML = buildSubEntityHTML(sub, hass, config, hideEids);
    const chartsHTML = buildSubDeviceChartsHTML(devId, sub, isBess, powerEid, battLevelEid, battSoeEid);

    subDevHTML += `
      <div class="sub-device ${isBess ? "sub-device-bess" : ""}" data-subdev="${escapeHtml(devId)}">
        <div class="sub-device-header">
          <span class="sub-device-type">${escapeHtml(label)}</span>
          <span class="sub-device-name">${escapeHtml(sub.name || "")}</span>
          ${powerEid ? `<span class="sub-power-value"><strong>${formatPowerSigned(powerW)}</strong> <span class="power-unit">${formatPowerUnit(powerW)}</span></span>` : ""}
        </div>
        ${chartsHTML}
        ${entHTML}
      </div>
    `;
  }
  return subDevHTML;
}

/**
 * Build the HTML for the visible entities of a single sub-device.
 *
 * @param {object} sub - Sub-device object from topology
 * @param {object} hass - Home Assistant object
 * @param {object} config - Card configuration
 * @param {Set<string>} hideEids - Entity IDs to suppress (already shown elsewhere)
 * @returns {string} HTML string
 */
export function buildSubEntityHTML(sub, hass, config, hideEids) {
  const visibleEnts = config.visible_sub_entities || {};
  let entHTML = "";
  if (!sub.entities) return entHTML;

  for (const [entityId, info] of Object.entries(sub.entities)) {
    if (hideEids.has(entityId)) continue;
    if (visibleEnts[entityId] !== true) continue;
    const state = hass.states[entityId];
    if (!state) continue;
    let name = info.original_name || state.attributes.friendly_name || entityId;
    const devName = sub.name || "";
    if (name.startsWith(devName + " ")) name = name.slice(devName.length + 1);
    let displayValue;
    if (hass.formatEntityState) {
      displayValue = hass.formatEntityState(state);
    } else {
      displayValue = state.state;
      const unit = state.attributes.unit_of_measurement || "";
      if (unit) displayValue += " " + unit;
    }
    const rawUnit = state.attributes.unit_of_measurement || "";
    if (rawUnit === "Wh") {
      const wh = parseFloat(state.state);
      if (!isNaN(wh)) displayValue = (wh / 1000).toFixed(1) + " kWh";
    }
    entHTML += `
      <div class="sub-entity">
        <span class="sub-entity-name">${escapeHtml(name)}:</span>
        <span class="sub-entity-value" data-eid="${escapeHtml(entityId)}">${escapeHtml(displayValue)}</span>
      </div>
    `;
  }
  return entHTML;
}

/**
 * Build the chart container HTML for a sub-device.
 *
 * @param {string} devId - Sub-device key
 * @param {object} sub - Sub-device object from topology (unused, reserved for future use)
 * @param {boolean} isBess - Whether this sub-device is a battery
 * @param {string|null} powerEid - Power entity ID, if available
 * @param {string|null} battLevelEid - Battery level entity ID, if available
 * @param {string|null} battSoeEid - Battery SoE entity ID, if available
 * @returns {string} HTML string
 */
export function buildSubDeviceChartsHTML(devId, _sub, isBess, powerEid, battLevelEid, battSoeEid) {
  if (isBess) {
    const bessCharts = [
      { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_soc`, title: t("subdevice.soc"), available: !!battLevelEid },
      { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_soe`, title: t("subdevice.soe"), available: !!battSoeEid },
      { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_power`, title: t("subdevice.power"), available: !!powerEid },
    ].filter(c => c.available);

    return `
      <div class="bess-charts">
        ${bessCharts
          .map(
            c => `
          <div class="bess-chart-col">
            <div class="bess-chart-title">${escapeHtml(c.title)}</div>
            <div class="chart-container" data-chart-key="${escapeHtml(c.key)}"></div>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }
  if (powerEid) {
    return `<div class="chart-container" data-chart-key="${SUB_DEVICE_KEY_PREFIX}${escapeHtml(devId)}_power"></div>`;
  }
  return "";
}
