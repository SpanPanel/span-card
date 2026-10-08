import { escapeHtml } from "../helpers/sanitize.js";
import { formatPowerHTML } from "../helpers/format.js";
import { readNumber } from "../helpers/read-number.js";
import { t } from "../i18n.js";
import { findBatteryLevelEntity, findBatterySoeEntity } from "../helpers/entity-finder.js";
import { resolveSubDevicePower, tileRenderedEntityIds, stateWatts, type SubDevicePower } from "../helpers/sub-device-power.js";
import { subDeviceHasSettings } from "../helpers/sub-device-settings.js";
import { orderSubDevices, panelOfSubDevice } from "./sub-device-order.js";
import { SUB_DEVICE_TYPE_BESS, SUB_DEVICE_TYPE_EVSE, SUB_DEVICE_TYPE_PV, SUB_DEVICE_KEY_PREFIX } from "../constants.js";
import type { PanelTopology, HomeAssistant, CardConfig, SubDevice, SubDeviceSolar } from "../types.js";

interface BessChartDef {
  key: string;
  title: string;
  available: boolean;
}

/** A sub-device that has something to show, with the pieces already built. */
interface RenderableSubDevice {
  devId: string;
  sub: SubDevice;
  power: SubDevicePower;
  chartsHTML: string;
  entHTML: string;
  solarHTML: string;
}

/** What the view drawing the tiles knows that the topology does not. */
export interface SubDeviceView {
  /** Whether the view's side panels offer favorite hearts: `DashboardController.showFavorites`. */
  showFavorites: boolean;
}

/**
 * Build the HTML for all sub-devices (BESS, EVSE, etc.) in the topology.
 */
export function buildSubDevicesHTML(topology: PanelTopology, hass: HomeAssistant, config: CardConfig, view: SubDeviceView): string {
  const showBattery: boolean = config.show_battery !== false;
  const showEvse: boolean = config.show_evse !== false;
  const showSolar: boolean = config.show_solar !== false;

  if (!topology.sub_devices) return "";

  const entries: [string, SubDevice][] = orderSubDevices(
    Object.entries(topology.sub_devices).filter(([, sub]) => {
      if (sub.type === SUB_DEVICE_TYPE_BESS && !showBattery) return false;
      if (sub.type === SUB_DEVICE_TYPE_EVSE && !showEvse) return false;
      if (sub.type === SUB_DEVICE_TYPE_PV && !showSolar) return false;
      return true;
    }),
    panelOfSubDevice(topology)
  );

  if (entries.length === 0) return "";

  // Build each tile's contents before deciding whether it is a tile at all. A
  // sub-device with no power reading, no charts and no visible entities renders
  // as a header bar and a gear icon and nothing else -- which is what the
  // Microgrid Interconnect did the day it appeared: its one entity is a
  // diagnostic enum, so there was never anything to draw.
  //
  // Tested on emptiness rather than on type. Excluding the MID by name would fix
  // one device and leave the next one to rediscover this, and v1.0 has more of
  // them coming -- sub-enclosures, PV devices. It also self-corrects: give this
  // device something chartable and its tile comes back with no code change.
  const renderable: RenderableSubDevice[] = [];
  for (const [devId, sub] of entries) {
    const power: SubDevicePower = resolveSubDevicePower(sub);
    const isBess: boolean = sub.type === SUB_DEVICE_TYPE_BESS;
    const battLevelEid: string | null = isBess ? findBatteryLevelEntity(sub) : null;
    const battSoeEid: string | null = isBess ? findBatterySoeEntity(sub) : null;

    const entHTML: string = buildSubEntityHTML(sub, hass, config, tileRenderedEntityIds(sub));
    const chartsHTML: string = buildSubDeviceChartsHTML(devId, sub, isBess, power.headlineEid, battLevelEid, battSoeEid);
    // What a solar block adds -- its identity, its site-total row, or that an
    // inverter's output is in the site total -- counts as something to draw, so
    // an inverter with no reading or chart still gets its tile.
    const solarHTML: string = sub.solar ? buildSolarDetailHTML(sub.solar, power, hass) : "";

    if (!power.headlineEid && !chartsHTML && !entHTML && !solarHTML) continue;

    renderable.push({ devId, sub, power, chartsHTML, entHTML, solarHTML });
  }

  if (renderable.length === 0) return "";

  // Counted over what will actually be drawn, so a skipped sub-device cannot
  // throw off which EVSE is the odd one out on its row.
  const evseCount: number = renderable.filter((r: RenderableSubDevice) => r.sub.type === SUB_DEVICE_TYPE_EVSE).length;
  let evseIndex = 0;

  let subDevHTML = "";
  for (const { devId, sub, power, chartsHTML, entHTML, solarHTML } of renderable) {
    const label: string = tileLabel(sub);
    const caption = power.headlineIsSiteTotal ? `<span class="sub-power-caption">${escapeHtml(t("subdevice.site_total"))}</span>` : "";
    const headline = power.headlineEid ? `${caption}<span class="sub-power-value">${formatPowerHTML(stateWatts(hass, power.headlineEid))}</span>` : "";
    // The gear opens the tile's side panel; one with nothing to offer would open empty.
    const gear = subDeviceHasSettings(sub, view.showFavorites)
      ? `<button class="gear-icon subdevice-gear" data-subdev-id="${escapeHtml(devId)}" style="color:#555;" title="${escapeHtml(t("grid.configure_subdevice"))}">
            <span-icon icon="mdi:cog" style="--mdc-icon-size:16px;"></span-icon>
          </button>`
      : "";

    const isBess: boolean = sub.type === SUB_DEVICE_TYPE_BESS;
    const isEvse: boolean = sub.type === SUB_DEVICE_TYPE_EVSE;

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
          ${headline}
          ${gear}
        </div>
        ${chartsHTML}
        ${solarHTML}
        ${entHTML}
      </div>
    `;
  }
  return subDevHTML;
}

/** The tile's kind, by type: a solar device is Solar or a Solar inverter whether or not the integration sent a block. */
function tileLabel(sub: SubDevice): string {
  if (sub.type === SUB_DEVICE_TYPE_PV) return sub.solar?.role === "inverter" ? t("subdevice.solar_inverter") : t("subdevice.solar");
  if (sub.type === SUB_DEVICE_TYPE_EVSE) return t("subdevice.ev_charger");
  if (sub.type === SUB_DEVICE_TYPE_BESS) return t("subdevice.battery");
  return t("subdevice.fallback");
}

/**
 * A solar tile's identity line, its site-total row and, for an inverter with
 * no individual reading, where its output is counted. The site total is a row
 * whenever the header shows an inverter's circuit, single-inverter sites
 * included; when the header is the site total it is captioned there instead.
 * The note is an inverter's alone: the Solar tile is the site total's own tile.
 */
export function buildSolarDetailHTML(solar: SubDeviceSolar, power: SubDevicePower, hass: HomeAssistant): string {
  let html = "";
  const identity: string = [solar.vendor, solar.model].filter((part): part is string => !!part).join(" · ");
  if (identity) html += `<div class="sub-identity">${escapeHtml(identity)}</div>`;
  if (power.siteTotalEid) {
    html += `
      <div class="sub-entity">
        <span class="sub-entity-name">${escapeHtml(t("subdevice.site_total"))}:</span>
        <span class="sub-site-total-value" data-site-total-eid="${escapeHtml(power.siteTotalEid)}">${formatPowerHTML(stateWatts(hass, power.siteTotalEid))}</span>
      </div>`;
  }
  if (solar.role === "inverter" && !power.headlineEid) html += `<div class="sub-note">${escapeHtml(t("subdevice.in_site_total"))}</div>`;
  return html;
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
      const wh = readNumber(state);
      if (wh !== null) displayValue = (wh / 1000).toFixed(1) + " kWh";
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
