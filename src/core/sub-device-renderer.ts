import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { t } from "../i18n.js";
import { findSubDevicePowerEntity, findBatteryLevelEntity, findBatterySoeEntity, findBatteryCapacityEntity } from "../helpers/entity-finder.js";
import { SUB_DEVICE_TYPE_BESS, SUB_DEVICE_TYPE_EVSE, SUB_DEVICE_KEY_PREFIX } from "../constants.js";
import type { PanelTopology, HomeAssistant, CardConfig, SubDevice } from "../types.js";

interface BessChartDef {
  key: string;
  title: string;
  available: boolean;
}

/**
 * Build the HTML for all sub-devices (BESS, EVSE, etc.) in the topology.
 */
export function buildSubDevicesHTML(topology: PanelTopology, hass: HomeAssistant, config: CardConfig): string {
  const showBattery: boolean = config.show_battery !== false;
  const showEvse: boolean = config.show_evse !== false;

  if (!topology.sub_devices) return "";

  const entries: [string, SubDevice][] = Object.entries(topology.sub_devices).filter(([, sub]) => {
    if (sub.type === SUB_DEVICE_TYPE_BESS && !showBattery) return false;
    if (sub.type === SUB_DEVICE_TYPE_EVSE && !showEvse) return false;
    return true;
  });

  if (entries.length === 0) return "";

  const evseCount: number = entries.filter(([, sub]) => sub.type === SUB_DEVICE_TYPE_EVSE).length;
  let evseIndex = 0;

  let subDevHTML = "";
  for (const [devId, sub] of entries) {
    const label: string =
      sub.type === SUB_DEVICE_TYPE_EVSE ? t("subdevice.ev_charger") : sub.type === SUB_DEVICE_TYPE_BESS ? t("subdevice.battery") : t("subdevice.fallback");
    const powerEid: string | null = findSubDevicePowerEntity(sub);
    const powerState = powerEid ? hass.states[powerEid] : undefined;
    const powerW: number = powerState ? parseFloat(powerState.state) || 0 : 0;

    const isBess: boolean = sub.type === SUB_DEVICE_TYPE_BESS;
    const isEvse: boolean = sub.type === SUB_DEVICE_TYPE_EVSE;
    const battLevelEid: string | null = isBess ? findBatteryLevelEntity(sub) : null;
    const battSoeEid: string | null = isBess ? findBatterySoeEntity(sub) : null;
    const battCapEid: string | null = isBess ? findBatteryCapacityEntity(sub) : null;

    const hideEids: Set<string> = new Set([powerEid, battLevelEid, battSoeEid, battCapEid].filter((eid): eid is string => eid !== null));
    const entHTML: string = buildSubEntityHTML(sub, hass, config, hideEids);
    const chartsHTML: string = buildSubDeviceChartsHTML(devId, sub, isBess, powerEid, battLevelEid, battSoeEid);

    // EVSE: span full row if it's the odd one out (last on its row alone)
    let spanClass = "";
    if (isBess) {
      spanClass = "sub-device-bess";
    } else if (isEvse) {
      evseIndex++;
      if (evseIndex === evseCount && evseCount % 2 === 1) {
        spanClass = "sub-device-full";
      }
    }

    subDevHTML += `
      <div class="sub-device ${spanClass}" data-subdev="${escapeHtml(devId)}">
        <div class="sub-device-header">
          <span class="sub-device-type">${escapeHtml(label)}</span>
          <span class="sub-device-name">${escapeHtml(sub.name || "")}</span>
          ${powerEid ? `<span class="sub-power-value"><strong>${formatPowerSigned(powerW)}</strong> <span class="power-unit">${formatPowerUnit(powerW)}</span></span>` : ""}
          <button class="gear-icon subdevice-gear" data-subdev-id="${escapeHtml(devId)}" style="color:#555;" title="${escapeHtml(t("grid.configure_subdevice"))}">
            <span-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></span-icon>
          </button>
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
 */
export function buildSubEntityHTML(sub: SubDevice, hass: HomeAssistant, config: CardConfig, hideEids: Set<string>): string {
  const visibleEnts: Record<string, boolean> = config.visible_sub_entities || {};
  let entHTML = "";
  if (!sub.entities) return entHTML;

  for (const [entityId, info] of Object.entries(sub.entities)) {
    if (hideEids.has(entityId)) continue;
    if (visibleEnts[entityId] !== true) continue;
    const state = hass.states[entityId];
    if (!state) continue;
    let name: string = info.original_name || (state.attributes.friendly_name as string) || entityId;
    const devName: string = sub.name || "";
    if (name.startsWith(devName + " ")) name = name.slice(devName.length + 1);
    let displayValue: string;
    if (hass.formatEntityState) {
      displayValue = hass.formatEntityState(state);
    } else {
      displayValue = state.state;
      const unit = (state.attributes.unit_of_measurement as string) || "";
      if (unit) displayValue += " " + unit;
    }
    const rawUnit = (state.attributes.unit_of_measurement as string) || "";
    if (rawUnit === "Wh") {
      const wh: number = parseFloat(state.state);
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
 */
export function buildSubDeviceChartsHTML(
  devId: string,
  _sub: SubDevice,
  isBess: boolean,
  powerEid: string | null,
  battLevelEid: string | null,
  battSoeEid: string | null
): string {
  if (isBess) {
    const bessCharts: BessChartDef[] = [
      { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_soc`, title: t("subdevice.soc"), available: !!battLevelEid },
      { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_soe`, title: t("subdevice.soe"), available: !!battSoeEid },
      { key: `${SUB_DEVICE_KEY_PREFIX}${devId}_power`, title: t("subdevice.power"), available: !!powerEid },
    ].filter((c): c is BessChartDef => c.available);

    return `
      <div class="bess-charts">
        ${bessCharts
          .map(
            (c: BessChartDef) => `
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
