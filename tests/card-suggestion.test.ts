import { describe, it, expect } from "vitest";
import { spanPanelCardSuggestion } from "../src/card/card-suggestion.js";
import {
  BATTERY_DEVICE,
  BATTERY_LEVEL,
  CIRCUIT_DEVICE,
  CIRCUIT_POWER,
  HELPER_SENSOR,
  OTHER_DEVICE,
  PANEL,
  PANEL_STATUS,
  PANEL_TWIN,
  SECOND_PANEL,
  SECOND_PANEL_POWER,
  THERMOSTAT,
  hassWithRegistries,
} from "./hass-registries.js";

/**
 * The card picker asks every custom card for suggestions when an entity is
 * picked. The card answers for the integration's entities only, with the card
 * of the panel the entity's device belongs to.
 */

const DEVICES = [PANEL, SECOND_PANEL, CIRCUIT_DEVICE, BATTERY_DEVICE, OTHER_DEVICE];

function suggestionFor(entityId: string, entities = [PANEL_STATUS, SECOND_PANEL_POWER, CIRCUIT_POWER, BATTERY_LEVEL, THERMOSTAT], devices = DEVICES) {
  return spanPanelCardSuggestion(hassWithRegistries(devices, entities), entityId);
}

describe("spanPanelCardSuggestion", () => {
  it("suggests a panel entity's own panel", () => {
    expect(suggestionFor(PANEL_STATUS.entity_id)).toEqual({ config: { type: "custom:span-panel-card", device_id: PANEL.id } });
    expect(suggestionFor(SECOND_PANEL_POWER.entity_id)).toEqual({ config: { type: "custom:span-panel-card", device_id: SECOND_PANEL.id } });
  });

  it("suggests the panel a circuit's child device belongs to", () => {
    expect(suggestionFor(CIRCUIT_POWER.entity_id)).toEqual({ config: { type: "custom:span-panel-card", device_id: PANEL.id } });
  });

  it("suggests the panel a battery's device is reached through", () => {
    expect(suggestionFor(BATTERY_LEVEL.entity_id)).toEqual({ config: { type: "custom:span-panel-card", device_id: PANEL.id } });
  });

  it("suggests nothing for another integration's entity", () => {
    expect(suggestionFor(THERMOSTAT.entity_id)).toBeNull();
  });

  it("suggests nothing for an entity of another integration on a panel's device", () => {
    const template = { entity_id: "sensor.panel_template", device_id: PANEL.id, platform: "template" };
    expect(suggestionFor(template.entity_id, [template])).toBeNull();
  });

  it("suggests nothing for an entity the registry does not hold", () => {
    expect(suggestionFor("sensor.not_registered")).toBeNull();
  });

  it("suggests nothing for an entity of the integration's on no device", () => {
    const deviceless = { entity_id: "sensor.span_deviceless", platform: "span_panel" };
    expect(suggestionFor(deviceless.entity_id, [deviceless])).toBeNull();
  });

  it("suggests nothing where the entity's device is missing from the device registry", () => {
    expect(suggestionFor(CIRCUIT_POWER.entity_id, [CIRCUIT_POWER], [PANEL])).toBeNull();
  });

  it("suggests nothing where the panel a device belongs to is missing from the device registry", () => {
    expect(suggestionFor(CIRCUIT_POWER.entity_id, [CIRCUIT_POWER], [CIRCUIT_DEVICE])).toBeNull();
  });

  it("suggests nothing where the device an entity of the integration's is on is reached through another integration's device", () => {
    const viaThermostat = { ...BATTERY_DEVICE, via_device_id: OTHER_DEVICE.id };
    expect(suggestionFor(BATTERY_LEVEL.entity_id, [BATTERY_LEVEL], [OTHER_DEVICE, viaThermostat])).toBeNull();
  });

  // Home Assistant 2026.8 gave a helper linked to the panel a copy of the
  // panel's device, SPAN identifier included, and moved the helper's entities
  // onto it.
  it("suggests nothing for a helper's entity on the copy of the panel's device the helper owns", () => {
    expect(suggestionFor(HELPER_SENSOR.entity_id, [HELPER_SENSOR, PANEL_STATUS], [PANEL_TWIN, PANEL])).toBeNull();
  });

  it("suggests the panel's own device where a helper's copy of it is listed first", () => {
    expect(suggestionFor(PANEL_STATUS.entity_id, [PANEL_STATUS, CIRCUIT_POWER], [PANEL_TWIN, PANEL, CIRCUIT_DEVICE])).toEqual({
      config: { type: "custom:span-panel-card", device_id: PANEL.id },
    });
    expect(suggestionFor(CIRCUIT_POWER.entity_id, [PANEL_STATUS, CIRCUIT_POWER], [PANEL_TWIN, PANEL, CIRCUIT_DEVICE])).toEqual({
      config: { type: "custom:span-panel-card", device_id: PANEL.id },
    });
  });

  it("suggests nothing where a device the integration's entity is on is reached through a panel another entry owns", () => {
    const onTwin = { ...BATTERY_DEVICE, via_device_id: PANEL_TWIN.id };
    expect(suggestionFor(BATTERY_LEVEL.entity_id, [BATTERY_LEVEL], [PANEL_TWIN, onTwin])).toBeNull();
  });

  it("suggests nothing before the frontend has loaded the registries", () => {
    const hass = hassWithRegistries([]);
    delete hass.devices;
    delete hass.entities;
    expect(spanPanelCardSuggestion(hass, PANEL_STATUS.entity_id)).toBeNull();
  });
});
