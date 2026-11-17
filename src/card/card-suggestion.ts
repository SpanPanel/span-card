import { CARD_CONFIG_TYPE, INTEGRATION_DOMAIN } from "../constants.js";
import { owningPanelDevice } from "../core/registry-types.js";
import type { CardSuggestion } from "../core/lovelace-registration.js";
import type { DashboardCardConfig, HomeAssistant } from "../types.js";

/**
 * The card the card picker suggests for an entity of the integration's: the
 * card of the panel the entity's device belongs to, whether that device is the
 * panel's own, a circuit's or a battery's or charger's. Null for any other
 * integration's entity, and for one whose device leads to no panel.
 */
export function spanPanelCardSuggestion(hass: HomeAssistant, entityId: string): CardSuggestion<DashboardCardConfig> | null {
  const entry = hass.entities?.[entityId];
  if (entry?.platform !== INTEGRATION_DOMAIN || !entry.device_id || !hass.devices) return null;
  const device = hass.devices[entry.device_id];
  const panel = device ? owningPanelDevice(device, hass.devices) : null;
  return panel ? { config: { type: CARD_CONFIG_TYPE, device_id: panel.id } } : null;
}
