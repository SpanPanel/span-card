import { CARD_CONFIG_TYPE, SECTION_STRATEGY_TYPE } from "../constants.js";
import { discoverPanelDevices } from "../core/panel-devices.js";
import type { CardConfig, DashboardCardConfig, HomeAssistant } from "../types.js";

/** The section strategy's options, as a section's `strategy` key holds them: the card's own options, the panel among them. */
export interface SpanPanelSectionStrategyConfig extends CardConfig {
  type: typeof SECTION_STRATEGY_TYPE;
}

/** The section the strategy generates: a grid section holding the panel's card. */
export interface SpanPanelSectionConfig {
  type: "grid";
  cards: [DashboardCardConfig];
}

/** A registry Home Assistant can regenerate a strategy on, when it changes. */
type LovelaceStrategyDependency = "entities" | "devices" | "areas" | "floors" | "labels" | "panels";

/** An object without the keys whose value is undefined. */
function definedOnly<T extends object>(source: T): Partial<T> {
  const defined: Partial<T> = {};
  for (const key in source) {
    if (source[key] !== undefined) defined[key] = source[key];
  }
  return defined;
}

/**
 * The card's own options, of all the section's config holds, and nothing else
 * of it. Each option is named, so one the card gains and this leaves out fails
 * to compile.
 */
function cardOptions(config: SpanPanelSectionStrategyConfig): CardConfig {
  const options: { [K in keyof Required<CardConfig>]: CardConfig[K] } = {
    device_id: config.device_id,
    history_days: config.history_days,
    history_hours: config.history_hours,
    history_minutes: config.history_minutes,
    chart_metric: config.chart_metric,
    show_panel: config.show_panel,
    show_battery: config.show_battery,
    show_evse: config.show_evse,
    show_solar: config.show_solar,
    visible_sub_entities: config.visible_sub_entities,
    tab_style: config.tab_style,
  };
  return definedOnly(options);
}

/**
 * A dashboard section of one SPAN panel: the panel's card, taking the section's
 * full width. Home Assistant 2026.11 offers it among the Community sections
 * when a section is added.
 *
 * Home Assistant only calls the static members; the element is never created.
 */
export class SpanPanelSectionStrategy extends HTMLElement {
  /**
   * None: the section is generated from its config alone, so no registry change
   * alters it, and the card follows the registries itself.
   */
  static readonly registryDependencies: readonly LovelaceStrategyDependency[] = [];

  /** The section a new one starts as, which the editor also previews: the first SPAN panel's, or none where there is no panel. */
  static async getStubConfig(hass: HomeAssistant): Promise<SpanPanelSectionStrategyConfig> {
    const [panel] = await discoverPanelDevices(hass);
    return panel ? { type: SECTION_STRATEGY_TYPE, device_id: panel.id } : { type: SECTION_STRATEGY_TYPE };
  }

  /**
   * The section for the config: the card with the card's options the config
   * holds, at the section's full width. The card reports a panel it cannot
   * find, and shows its preview where the config names none.
   */
  static async generate(config: SpanPanelSectionStrategyConfig): Promise<SpanPanelSectionConfig> {
    return { type: "grid", cards: [{ ...cardOptions(config), type: CARD_CONFIG_TYPE, grid_options: { columns: "full" } }] };
  }
}
