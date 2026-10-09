import { escapeHtml } from "../helpers/sanitize.js";
import { attrSelectorValue } from "../helpers/selector.js";
import { formatCircuitPowerHTML, formatEnergyReading } from "../helpers/format.js";
import { t } from "../i18n.js";
import { measuresOutsidePanel } from "../helpers/layout.js";
import { circuitPowerW } from "./circuit-state.js";
import type { Circuit, HomeAssistant, PanelTopology } from "../types.js";

/** The topology's meters outside the panel, in topology order. */
function metersOf(topology: PanelTopology): [string, Circuit][] {
  return Object.entries(topology.circuits).filter(([, circuit]) => measuresOutsidePanel(circuit));
}

function energyHTML(hass: HomeAssistant, entityId: string | undefined, label: string): string {
  const reading = formatEnergyReading(entityId ? hass.states[entityId] : undefined);
  return `${escapeHtml(reading)} ${escapeHtml(label)}`;
}

/**
 * A meter's readings: its power in the import-positive sign with the direction
 * it states, then the energy it has imported and exported. An unknown power
 * states no direction, and neither does zero.
 */
function meterReadingsHTML(circuit: Circuit, hass: HomeAssistant): string {
  const powerW = circuitPowerW(circuit, hass);
  const direction = powerW === null || powerW === 0 ? "" : powerW > 0 ? t("meters.importing") : t("meters.exporting");
  return `
    <span class="meter-power">${formatCircuitPowerHTML(powerW)}</span>
    <span class="meter-direction">${escapeHtml(direction)}</span>
    <span class="meter-imported">${energyHTML(hass, circuit.entities?.consumed_energy, t("meters.imported"))}</span>
    <span class="meter-exported">${energyHTML(hass, circuit.entities?.produced_energy, t("meters.exported"))}</span>
  `;
}

/**
 * The strip of meters outside the panel, drawn above the breaker grid; empty
 * when there are none. A meter has no breaker space, relay or rating, so its
 * tile carries no toggle, badge or gear.
 */
export function buildMetersStripHTML(topology: PanelTopology, hass: HomeAssistant): string {
  const meters = metersOf(topology);
  if (meters.length === 0) return "";
  const tiles = meters
    .map(
      ([uuid, circuit]) => `
    <div class="meter-tile" data-meter-uuid="${escapeHtml(uuid)}">
      <span class="meter-name">${escapeHtml(circuit.name || t("grid.unknown"))}</span>
      <span class="meter-readings">${meterReadingsHTML(circuit, hass)}</span>
    </div>`
    )
    .join("");
  return `
    <div class="meters-strip">
      <div class="meters-title">${escapeHtml(t("meters.title"))}</div>
      ${tiles}
    </div>
  `;
}

/** Refresh each drawn meter tile's readings in place. */
export function updateMetersDOM(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology): void {
  for (const [uuid, circuit] of metersOf(topology)) {
    const readings = root.querySelector(`.meter-tile[data-meter-uuid="${attrSelectorValue(uuid)}"] .meter-readings`);
    if (readings) readings.innerHTML = meterReadingsHTML(circuit, hass);
  }
}
