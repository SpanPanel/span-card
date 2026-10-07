import { describe, it, expect, vi, afterEach } from "vitest";
import type { CardConfig, HomeAssistant, PanelTopology, SubDevice, SubDeviceSolar } from "../src/types.js";

vi.mock("../src/card/card-discovery.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/card/card-discovery.js")>()),
  discoverTopology: vi.fn(),
}));

import { discoverTopology } from "../src/card/card-discovery.js";
import { DashboardController } from "../src/core/dashboard-controller.js";
import { buildSubDevicesHTML } from "../src/core/sub-device-renderer.js";
import { DashboardTab } from "../src/panel/tab-dashboard.js";
import "../src/card/span-panel-card.js";
import "../src/core/side-panel.js";

/**
 * A tile's gear opens its side panel, which offers a graph horizon where the
 * tile draws a chart and a favorite heart where the view shows favorites. A
 * gear with neither would open an empty panel, so it is not drawn.
 *
 * An inverter no circuit feeds draws no chart. On the standalone card, which
 * shows no favorites, its gear would offer nothing; in the favorites view it
 * offers the heart. A circuit-fed inverter's gear always offers the horizon.
 */

const mockDiscover = vi.mocked(discoverTopology);

function block(overrides: Partial<SubDeviceSolar>): SubDeviceSolar {
  return { role: "inverter", vendor: null, model: null, feed_circuit_id: null, power_entity_id: null, site_power_entity_id: null, ...overrides };
}

const UPSTREAM: SubDevice = {
  name: "Span Panel Solar Inverter (1)",
  type: "pv",
  solar: block({ vendor: "SolarEdge", model: "SE7600H-US" }),
  entities: { "sensor.span_panel_solar_inverter_1_pv_vendor": { domain: "sensor", original_name: "PV Vendor" } },
};
const FED: SubDevice = {
  name: "Span Panel Solar Inverter (Garage)",
  type: "pv",
  solar: block({ vendor: "Second Vendor", feed_circuit_id: "c24", power_entity_id: "sensor.garage_solar_power" }),
  entities: { "sensor.span_panel_solar_inverter_garage_pv_vendor": { domain: "sensor", original_name: "PV Vendor" } },
};

const TOPOLOGY = {
  circuits: { c24: { name: "Garage Solar", tabs: [24, 26], entities: { power: "sensor.garage_solar_power" }, device_type: "pv" } },
  sub_devices: { upstream: UPSTREAM, fed: FED },
  panel_size: 32,
} as unknown as PanelTopology;

function hass(): HomeAssistant {
  const callWS = async (msg: Record<string, unknown>): Promise<unknown> => {
    if (msg.type === "call_service" && msg.service === "get_graph_settings") {
      return { response: { global_horizon: "5m", circuits: {}, sub_devices: {} } };
    }
    return {};
  };
  return {
    states: { "sensor.garage_solar_power": { entity_id: "sensor.garage_solar_power", state: "2100", attributes: {}, last_changed: "", last_updated: "" } },
    services: {},
    language: "en",
    callWS,
    callService: async () => undefined,
  } as unknown as HomeAssistant;
}

function gearOf(root: ParentNode, devId: string): Element | null {
  return root.querySelector(`[data-subdev="${devId}"] .subdevice-gear`);
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  mockDiscover.mockReset();
});

describe("a sub-device tile's gear on the standalone card, which shows no favorites", () => {
  async function renderCard(): Promise<ShadowRoot> {
    mockDiscover.mockResolvedValue({ topology: TOPOLOGY, panelDevice: null, panelSize: 32 });
    const card = document.createElement("span-panel-card") as HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };
    card.setConfig({ device_id: "panel-device-1" } as CardConfig);
    document.body.appendChild(card);
    mounted.push(card);
    card.hass = hass();
    await vi.waitFor(() => expect(card.shadowRoot?.querySelector('[data-subdev="upstream"]')).not.toBeNull());
    return card.shadowRoot!;
  }

  it("is not drawn for an inverter no circuit feeds", async () => {
    const root = await renderCard();
    expect(gearOf(root, "upstream")).toBeNull();
  });

  it("is drawn for an inverter a circuit feeds", async () => {
    const root = await renderCard();
    expect(gearOf(root, "fed")).not.toBeNull();
  });
});

describe("a sub-device tile's gear on the dashboard, which shows the panel's favorites", () => {
  it("is drawn for an inverter no circuit feeds, and opens a panel with its heart and no horizon", async () => {
    mockDiscover.mockResolvedValue({ topology: TOPOLOGY, panelDevice: null, panelSize: 32 });
    const tab = new DashboardTab();
    tab.setPanelFavorites({ panelDeviceId: "panel-device-1", circuitUuids: new Set(), subDeviceIds: new Set() });
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted.push(container);

    await tab.render(container, hass(), "panel-device-1", {} as CardConfig, "entry-1");

    const gear = gearOf(container, "upstream");
    expect(gear).not.toBeNull();
    gear!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const panel = container.querySelector("span-side-panel");
    await vi.waitFor(() => expect(panel?.shadowRoot?.querySelector(".panel-body")).toBeTruthy());
    expect(panel!.shadowRoot!.querySelector(".horizon-bar")).toBeNull();
    expect(panel!.shadowRoot!.querySelector('[data-role="fav-heart"]')).not.toBeNull();
  });
});

describe("a sub-device tile's gear in the favorites view", () => {
  it("is drawn for an inverter no circuit feeds, and opens a panel with its heart and no horizon", async () => {
    const ctrl = new DashboardController();
    const topology = {
      circuits: {},
      sub_devices: { "panel-device-1|upstream": UPSTREAM },
      _favoriteRefs: { "panel-device-1|upstream": { panelDeviceId: "panel-device-1", kind: "sub_device", targetId: "upstream", configEntryId: "entry-1" } },
    } as unknown as PanelTopology;
    ctrl.init(topology, {} as CardConfig, hass(), "entry-1");
    ctrl.setFavoriteRefs((topology as unknown as { _favoriteRefs: Parameters<DashboardController["setFavoriteRefs"]>[0] })._favoriteRefs);

    const root = document.createElement("div");
    root.innerHTML = `${buildSubDevicesHTML(topology, hass(), {} as CardConfig, { showFavorites: ctrl.showFavorites })}<span-side-panel></span-side-panel>`;
    document.body.appendChild(root);
    mounted.push(root);

    const gear = gearOf(root, "panel-device-1|upstream");
    expect(gear).not.toBeNull();
    await ctrl.onGearClick({ target: gear } as unknown as Event, root);
    const shadow = root.querySelector("span-side-panel")!.shadowRoot!;
    expect(shadow.querySelector(".horizon-bar")).toBeNull();
    expect(shadow.querySelector('[data-role="fav-heart"]')).not.toBeNull();
  });

  it("is not drawn on a tile with neither a chart nor an entity to favorite through", () => {
    const bare: SubDevice = { ...UPSTREAM, entities: {} };
    const html = buildSubDevicesHTML({ circuits: {}, sub_devices: { bare } } as unknown as PanelTopology, hass(), {} as CardConfig, { showFavorites: true });
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector('[data-subdev="bare"]')).not.toBeNull();
    expect(gearOf(root, "bare")).toBeNull();
  });
});
