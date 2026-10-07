import { describe, it, expect } from "vitest";
import { DashboardController } from "../src/core/dashboard-controller.js";
import "../src/core/side-panel.js";
import type { CardConfig, HomeAssistant, PanelTopology, SubDevice, SubDeviceSolar } from "../src/types.js";

/**
 * A graph horizon sets how much history a tile's chart shows, so a tile with
 * no chart has none to set. An inverter no circuit feeds is such a tile: it
 * shows its identity and that its output is in the site total, and nothing
 * else. Its gear and the graph-settings list must not offer it a horizon.
 */

const PANEL_DEVICE_ID = "panel-device-1";

function block(overrides: Partial<SubDeviceSolar>): SubDeviceSolar {
  return { role: "inverter", vendor: null, model: null, feed_circuit_id: null, power_entity_id: null, site_power_entity_id: null, ...overrides };
}

const TOPOLOGY = {
  circuits: {},
  sub_devices: {
    upstream: {
      name: "Span Panel Solar Inverter (1)",
      type: "pv",
      solar: block({ vendor: "SolarEdge" }),
      entities: { "sensor.inverter_1_pv_vendor": { domain: "sensor", original_name: "PV Vendor" } },
    } satisfies SubDevice,
    fed: {
      name: "Span Panel Solar Inverter (Garage)",
      type: "pv",
      solar: block({ vendor: "Second Vendor", feed_circuit_id: "c24", power_entity_id: "sensor.garage_solar_power" }),
      entities: { "sensor.garage_pv_vendor": { domain: "sensor", original_name: "PV Vendor" } },
    } satisfies SubDevice,
  },
} as unknown as PanelTopology;

function hass(): HomeAssistant {
  const callWS = async (msg: Record<string, unknown>): Promise<unknown> => {
    if (msg.type === "call_service" && msg.service === "get_graph_settings") {
      return { response: { global_horizon: "5m", circuits: {}, sub_devices: {} } };
    }
    throw new Error(`unexpected ${String(msg.type)}`);
  };
  return { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
}

/** A dashboard root holding a side panel and one gear button, and the controller that serves it. */
function dashboard(
  gearClass: string,
  subDevId?: string,
  topology: PanelTopology = TOPOLOGY
): { ctrl: DashboardController; root: HTMLElement; gear: HTMLElement; panel: HTMLElement } {
  const ctrl = new DashboardController();
  ctrl.init(topology, {} as CardConfig, hass(), "entry-1");
  const root = document.createElement("div");
  const panel = document.createElement("span-side-panel");
  root.appendChild(panel);
  const gear = document.createElement("button");
  gear.className = `gear-icon ${gearClass}`;
  if (subDevId) gear.dataset.subdevId = subDevId;
  root.appendChild(gear);
  document.body.appendChild(root);
  return { ctrl, root, gear, panel };
}

async function clickGear(gearClass: string, subDevId?: string, favorites = false, topology: PanelTopology = TOPOLOGY): Promise<ShadowRoot> {
  const { ctrl, root, gear, panel } = dashboard(gearClass, subDevId, topology);
  if (favorites) ctrl.setPanelFavorites({ panelDeviceId: PANEL_DEVICE_ID, circuitUuids: new Set(), subDeviceIds: new Set() });
  await ctrl.onGearClick({ target: gear } as unknown as Event, root);
  if (!panel.shadowRoot) throw new Error("side panel has no shadow root");
  return panel.shadowRoot;
}

describe("a tile's gear offers a graph horizon only where the tile has a chart", () => {
  it("offers none for an inverter no circuit feeds", async () => {
    const shadow = await clickGear("subdevice-gear", "upstream");

    expect(shadow.querySelector(".horizon-bar")).toBeNull();
  });

  it("offers one for an inverter a circuit feeds", async () => {
    const shadow = await clickGear("subdevice-gear", "fed");

    expect(shadow.querySelector(".horizon-bar")).not.toBeNull();
  });
});

describe("the graph-settings list offers a horizon only to a sub-device with a chart", () => {
  it("drops the chartless inverter's select, and keeps its row for the favorite heart", async () => {
    const shadow = await clickGear("panel-gear", undefined, true);

    expect(shadow.querySelector('select[data-subdev-id="upstream"]')).toBeNull();
    expect(shadow.querySelector('select[data-subdev-id="fed"]')).not.toBeNull();
    const names = Array.from(shadow.querySelectorAll(".field-row .field-label")).map(el => el.textContent);
    expect(names).toContain("Span Panel Solar Inverter (1)");
  });

  it("leaves out the chartless inverter's row when there is no heart to keep it for", async () => {
    const shadow = await clickGear("panel-gear");

    const names = Array.from(shadow.querySelectorAll(".field-row .field-label")).map(el => el.textContent);
    expect(names).not.toContain("Span Panel Solar Inverter (1)");
    expect(names).toContain("Span Panel Solar Inverter (Garage)");
  });

  it("leaves out the sub-device section when no sub-device has a row", async () => {
    const onlyUpstream = { circuits: {}, sub_devices: { upstream: TOPOLOGY.sub_devices!.upstream! } } as unknown as PanelTopology;
    const shadow = await clickGear("panel-gear", undefined, false, onlyUpstream);

    const labels = Array.from(shadow.querySelectorAll(".section-label")).map(el => el.textContent);
    expect(labels).not.toContain("Sub-Device Graph Scales");
  });
});
