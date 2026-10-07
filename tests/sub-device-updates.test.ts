import { describe, it, expect } from "vitest";
import { updateSubDeviceDOM } from "../src/core/dom-updater.js";
import { collectSubDeviceEntityIds } from "../src/core/history-loader.js";
import { formatPowerHTML } from "../src/helpers/format.js";
import type { CardConfig, HomeAssistant, PanelTopology, SubDevice } from "../src/types.js";

const SITE_TOTAL = "sensor.span_panel_pv_power";
const CIRCUIT = "sensor.span_panel_commissioned_pv_system_power";

const SITE: SubDevice = {
  name: "Span Panel Solar",
  type: "pv",
  entities: {},
  solar: { role: "site", vendor: null, model: null, feed_circuit_id: "c36", power_entity_id: CIRCUIT, site_power_entity_id: SITE_TOTAL },
};
const topology = { sub_devices: { site: SITE } } as unknown as PanelTopology;

describe("solar tiles update and chart from the resolved readings", () => {
  it("updates the headline from the circuit and the row from the site total", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-subdev="site"><span class="sub-power-value"></span><span class="sub-site-total-value"></span></div>`;
    const hass = {
      states: { [CIRCUIT]: { state: "3100", attributes: {} }, [SITE_TOTAL]: { state: "5200", attributes: {} } },
    } as unknown as HomeAssistant;

    updateSubDeviceDOM(root, hass, topology, {} as CardConfig, new Map(), undefined);

    expect(root.querySelector(".sub-power-value")?.innerHTML).toBe(formatPowerHTML(3100));
    expect(root.querySelector(".sub-site-total-value")?.innerHTML).toBe(formatPowerHTML(5200));
  });

  it("loads the site tile's chart history from the circuit, under the key it always had", () => {
    expect(collectSubDeviceEntityIds(topology)).toEqual([{ entityId: CIRCUIT, key: "sub_site_power", devId: "site" }]);
  });
});
