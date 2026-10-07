import { describe, it, expect, vi } from "vitest";
import type { CardConfig, HomeAssistant, PanelDevice, PanelTopology, SubDevice, SubDeviceSolar } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", () => ({
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import { FavoritesController, buildCompositeId } from "../src/core/favorites-controller.js";
import { buildSubDevicesHTML } from "../src/core/sub-device-renderer.js";

/**
 * The favorites view merges several panels' tiles into one topology, keyed by
 * composite ids, and renders it with the same renderer as a single panel. Each
 * panel's solar tiles must still go as one group -- its Solar tile, then its
 * inverters -- however the user happened to favorite them.
 */

const mockDiscover = vi.mocked(discoverTopology);

function block(role: SubDeviceSolar["role"], power: string): SubDeviceSolar {
  return {
    role,
    vendor: "Enphase",
    model: null,
    feed_circuit_id: null,
    power_entity_id: power,
    site_power_entity_id: role === "site" ? `${power}_site_total` : null,
  };
}

function panelTopology(prefix: string): PanelTopology {
  const sub_devices: Record<string, SubDevice> = {
    solar: { name: "Solar", type: "pv", entities: {}, solar: block("site", `sensor.${prefix}_c36_power`) },
    inverter: { name: "Solar Inverter (Garage)", type: "pv", entities: {}, solar: block("inverter", `sensor.${prefix}_c24_power`) },
  };
  return { circuits: {}, sub_devices, device_name: `Panel ${prefix}`, panel_entities: {} };
}

function panel(id: string, name: string): PanelDevice {
  return { id, name, config_entry_id: `entry-${id}` } as unknown as PanelDevice;
}

const hass = { states: {}, services: {}, language: "en" } as unknown as HomeAssistant;

describe("solar tiles in the favorites view", () => {
  it("keeps each panel's Solar tile and inverters together, Solar tile first", async () => {
    const topologies: Record<string, PanelTopology> = { "panel-a": panelTopology("a"), "panel-b": panelTopology("b") };
    mockDiscover.mockImplementation(async (_hass, panelDeviceId) => ({
      topology: topologies[panelDeviceId] ?? null,
      panelDevice: null,
      panelSize: 0,
    }));
    // Each panel's inverter was favorited before its Solar device.
    const favorites = {
      "panel-a": { circuits: [], sub_devices: ["inverter", "solar"] },
      "panel-b": { circuits: [], sub_devices: ["inverter", "solar"] },
    };

    const { topology } = await new FavoritesController().build(hass, favorites, [panel("panel-a", "Alpha"), panel("panel-b", "Bravo")]);
    const html = buildSubDevicesHTML(topology, hass, {} as CardConfig);

    const order = Array.from(html.matchAll(/data-subdev="([^"]+)"/g), match => match[1]);
    expect(order).toEqual([
      buildCompositeId("panel-a", "solar"),
      buildCompositeId("panel-a", "inverter"),
      buildCompositeId("panel-b", "solar"),
      buildCompositeId("panel-b", "inverter"),
    ]);
  });
});
