import { escapeHtml } from "../helpers/sanitize.js";
import { attrSelectorValue } from "../helpers/selector.js";
import { formatCircuitCurrentHTML, formatCircuitPowerHTML, formatEnergyReading } from "../helpers/format.js";
import { getChartMetric } from "../helpers/chart.js";
import { t } from "../i18n.js";
import { measuresOutsidePanel } from "../helpers/layout.js";
import { circuitCurrentA, circuitPowerW } from "./circuit-state.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../types.js";

/** The rows the strip takes in the card's size, one for its title and one for its tiles. */
const METERS_STRIP_CARD_SIZE = 2;

/** The topology's meters outside the panel, in topology order. */
function metersOf(topology: PanelTopology): [string, Circuit][] {
  return Object.entries(topology.circuits).filter(([, circuit]) => measuresOutsidePanel(circuit));
}

/** Whether the strip is drawn: there is a meter, and the panel is shown, as the grid is. */
function stripShown(topology: PanelTopology, config: CardConfig): boolean {
  return config.show_panel !== false && metersOf(topology).length > 0;
}

/** What the strip adds to the card's size: nothing when it is not drawn. */
export function metersStripCardSize(topology: PanelTopology, config: CardConfig): number {
  return stripShown(topology, config) ? METERS_STRIP_CARD_SIZE : 0;
}

function energyHTML(hass: HomeAssistant, entityId: string | undefined, label: string): string {
  const reading = formatEnergyReading(entityId ? hass.states[entityId] : undefined);
  return `${escapeHtml(reading)} ${escapeHtml(label)}`;
}

/**
 * A meter's readings: its power in the import-positive sign, or its current in
 * amps mode as the grid shows it, with the direction its power states; then
 * the energy it has imported and exported. An unknown power states no
 * direction, and neither does zero.
 */
function meterReadingsHTML(circuit: Circuit, hass: HomeAssistant, config: CardConfig): string {
  const powerW = circuitPowerW(circuit, hass);
  const direction = powerW === null || powerW === 0 ? "" : powerW > 0 ? t("meters.importing") : t("meters.exporting");
  const showCurrent = getChartMetric(config).entityRole === "current";
  const valueHTML = showCurrent ? formatCircuitCurrentHTML(circuitCurrentA(circuit, hass)) : formatCircuitPowerHTML(powerW);
  return `
    <span class="meter-value">${valueHTML}</span>
    <span class="meter-direction">${escapeHtml(direction)}</span>
    <span class="meter-imported">${energyHTML(hass, circuit.entities?.consumed_energy, t("meters.imported"))}</span>
    <span class="meter-exported">${energyHTML(hass, circuit.entities?.produced_energy, t("meters.exported"))}</span>
  `;
}

/**
 * The strip of meters outside the panel, drawn above the breaker grid; empty
 * when there are none or the panel is hidden. A meter has no breaker space,
 * relay or rating, so its tile carries no toggle, badge or gear.
 */
export function buildMetersStripHTML(topology: PanelTopology, hass: HomeAssistant, config: CardConfig): string {
  if (!stripShown(topology, config)) return "";
  const tiles = metersOf(topology)
    .map(
      ([uuid, circuit]) => `
    <div class="meter-tile" data-meter-uuid="${escapeHtml(uuid)}">
      <span class="meter-name">${escapeHtml(circuit.name || t("grid.unknown"))}</span>
      <span class="meter-readings">${meterReadingsHTML(circuit, hass, config)}</span>
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
export function updateMetersDOM(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology, config: CardConfig): void {
  for (const [uuid, circuit] of metersOf(topology)) {
    const readings = root.querySelector(`.meter-tile[data-meter-uuid="${attrSelectorValue(uuid)}"] .meter-readings`);
    if (readings) readings.innerHTML = meterReadingsHTML(circuit, hass, config);
  }
}
