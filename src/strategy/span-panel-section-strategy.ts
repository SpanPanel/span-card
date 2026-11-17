import { CARD_CONFIG_TYPE, SECTION_STRATEGY_TYPE } from "../constants.js";
import { discoverPanelDevices } from "../core/panel-devices.js";
import { deviceName } from "../core/registry-types.js";
import { setLanguage, t } from "../i18n.js";
import type { DashboardCardConfig, HomeAssistant } from "../types.js";

/** The section strategy's options, as a section's `strategy` key holds them: the panel the section shows. */
export interface SpanPanelSectionStrategyConfig {
  type: typeof SECTION_STRATEGY_TYPE;
  device_id?: string;
}

/** Home Assistant's heading card, which titles the section with the panel's name. */
export interface HeadingCardConfig {
  type: "heading";
  heading: string;
}

/** The section the strategy generates: a grid section of the panel's heading and its card. */
export interface SpanPanelSectionConfig {
  type: "grid";
  cards: [HeadingCardConfig, DashboardCardConfig];
}

/**
 * A dashboard section of one SPAN panel: a heading with the panel's name above
 * the panel's card, which takes the section's full width. Home Assistant
 * 2026.11 offers it among the Community sections when a section is added.
 *
 * Home Assistant only calls the static members; the element is never created.
 */
export class SpanPanelSectionStrategy extends HTMLElement {
  /**
   * The section is generated again when the device registry changes, so its
   * heading follows a rename of the panel. Nothing it generates is read from
   * another registry.
   */
  static readonly registryDependencies = ["devices"] as const;

  /** The section a new one starts as, which the editor also previews: the first SPAN panel's, or none where there is no panel. */
  static async getStubConfig(hass: HomeAssistant): Promise<SpanPanelSectionStrategyConfig> {
    const [panel] = await discoverPanelDevices(hass);
    return panel ? { type: SECTION_STRATEGY_TYPE, device_id: panel.id } : { type: SECTION_STRATEGY_TYPE };
  }

  /**
   * The section for the panel the config names. The heading is the panel's
   * name, the user's rename first, or the default panel name where the device
   * is not found; the card itself reports a panel it cannot find, and shows its
   * preview where the config names none.
   */
  static async generate(config: SpanPanelSectionStrategyConfig, hass: HomeAssistant): Promise<SpanPanelSectionConfig> {
    setLanguage(hass.language);
    const device = config.device_id ? hass.devices?.[config.device_id] : undefined;
    const card: DashboardCardConfig = { type: CARD_CONFIG_TYPE, grid_options: { columns: "full" } };
    if (config.device_id) card.device_id = config.device_id;
    return {
      type: "grid",
      cards: [{ type: "heading", heading: (device && deviceName(device)) || t("header.default_name") }, card],
    };
  }
}
