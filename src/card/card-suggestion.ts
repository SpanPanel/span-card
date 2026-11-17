import { CARD_CONFIG_TYPE, INTEGRATION_DOMAIN } from "../constants.js";
import { owningPanelDevice } from "../core/registry-types.js";
import type { CardSuggestion } from "../core/lovelace-registration.js";
import type { DashboardCardConfig, HomeAssistant } from "../types.js";

/**
 * The card the card picker suggests for an entity of the integration's: the
 * card of the panel the entity's device belongs to, whether that device is the
 * panel's own, a circuit's or a battery's or charger's. Null for any other
 * integration's entity, and for one whose device leads to no panel.
 *
 * The picker asks without waiting, so the integration's config entries cannot be
 * listed here. The entity tells which entry to judge by instead: the
 * integration's entities sit on devices its config entry registered, so the
 * entry that owns the entity's device is the integration's, and the panel has to
 * be that entry's.
 */
export function spanPanelCardSuggestion(hass: HomeAssistant, entityId: string): CardSuggestion<DashboardCardConfig> | null {
  const entry = hass.entities?.[entityId];
  if (entry?.platform !== INTEGRATION_DOMAIN || !entry.device_id || !hass.devices) return null;
  const device = hass.devices[entry.device_id];
  if (!device?.config_entry_id) return null;
  const panel = owningPanelDevice(device, hass.devices, new Set([device.config_entry_id]));
  return panel ? { config: { type: CARD_CONFIG_TYPE, device_id: panel.id } } : null;
}
