import { describe, it, expect, vi } from "vitest";
import { SpanPanelCardEditor } from "../src/editor/span-panel-card-editor.js";
import type { CardConfig, HomeAssistant, PanelTopology, SubDevice } from "../src/types.js";

/**
 * The editor's entity checkboxes, as the editor itself builds them in the DOM.
 *
 * Each section's container used to be cleared once per sub-device, so where
 * two devices shared a type -- two chargers, or the Solar device and an
 * inverter -- only the last device's checkboxes survived. These tests build
 * the real editor over a topology with two of each and read its containers.
 */

const TAG = "span-panel-card-editor";
if (!customElements.get(TAG)) customElements.define(TAG, SpanPanelCardEditor);

const PANEL_DEVICE_ID = "panel-device-1";

const SUB_DEVICES: Record<string, SubDevice> = {
  drive_a: {
    name: "Drive A",
    type: "evse",
    entities: {
      "sensor.drive_a_power": { domain: "sensor", original_name: "Power", unique_id: "drive_a_power" },
      "sensor.drive_a_status": { domain: "sensor", original_name: "Drive A Status", unique_id: "drive_a_status" },
    },
  },
  drive_b: {
    name: "Drive B",
    type: "evse",
    entities: {
      "sensor.drive_b_power": { domain: "sensor", original_name: "Power", unique_id: "drive_b_power" },
      "sensor.drive_b_status": { domain: "sensor", original_name: "Drive B Status", unique_id: "drive_b_status" },
      "sensor.drive_b_lock": { domain: "sensor", original_name: "Drive B Lock State", unique_id: "drive_b_lock" },
    },
  },
  inverter: {
    name: "Span Panel Solar Inverter (Garage)",
    type: "pv",
    solar: {
      role: "inverter",
      vendor: "Second Vendor",
      model: null,
      feed_circuit_id: "c24",
      power_entity_id: "sensor.garage_solar_power",
      site_power_entity_id: null,
    },
    entities: {
      "sensor.inverter_pv_vendor": { domain: "sensor", original_name: "PV Vendor", unique_id: "span_x_pv_c24_pv_vendor" },
    },
  },
  solar: {
    name: "Span Panel Solar",
    type: "pv",
    solar: {
      role: "site",
      vendor: "Enphase",
      model: null,
      feed_circuit_id: "c36",
      power_entity_id: "sensor.solar_circuit_power",
      site_power_entity_id: "sensor.span_panel_pv_power",
    },
    entities: {
      "sensor.span_panel_pv_power": { domain: "sensor", original_name: "PV Power", unique_id: "span_x_pv_power" },
      "sensor.span_panel_pv_vendor": { domain: "sensor", original_name: "PV Vendor", unique_id: "span_x_pv_vendor" },
      "sensor.span_panel_pv_product": { domain: "sensor", original_name: "PV Product", unique_id: "span_x_pv_product" },
    },
  },
};

const PANEL_DEVICE = { id: PANEL_DEVICE_ID, name: "Span Panel", identifiers: [["span_panel", "sp3-test-001"]], via_device_id: null };

function hassWith(topology: PanelTopology, devices: object[] = [PANEL_DEVICE]): HomeAssistant {
  const callWS = async (msg: Record<string, unknown>): Promise<unknown> => {
    if (msg.type === "config/device_registry/list") return devices;
    if (msg.type === "span_panel/panel_topology") return topology;
    throw new Error(`unexpected ${String(msg.type)}`);
  };
  return { states: {}, services: {}, language: "en", callWS } as unknown as HomeAssistant;
}

/** The entity container that follows a section's checkbox row, found by the row's label. */
function sectionContainer(editor: HTMLElement, label: string): HTMLElement {
  const span = Array.from(editor.querySelectorAll("span")).find(el => el.textContent === label);
  const container = span?.parentElement?.nextElementSibling;
  if (!(container instanceof HTMLElement)) throw new Error(`no container for ${label}`);
  return container;
}

/** A container read top to bottom: "# name" for a heading, the label for a checkbox row. */
function outline(container: HTMLElement): string[] {
  return Array.from(container.children).map(child => {
    const label = child.querySelector("span");
    return child.querySelector("input") && label ? (label.textContent ?? "") : `# ${child.textContent ?? ""}`;
  });
}

async function openEditor(devices?: object[]): Promise<SpanPanelCardEditor> {
  const editor = document.createElement(TAG) as SpanPanelCardEditor;
  editor.setConfig({ device_id: PANEL_DEVICE_ID } as CardConfig);
  editor.hass = hassWith({ circuits: {}, sub_devices: SUB_DEVICES } as unknown as PanelTopology, devices);
  await vi.waitFor(() => expect(outline(sectionContainer(editor, "Solar (PV)")).length).toBeGreaterThan(0));
  return editor;
}

/** The panel picker's choices, as [device id, label], without its empty first option. */
function panelChoices(editor: HTMLElement): [string, string | null][] {
  const select = editor.querySelector("select");
  if (!select) throw new Error("no panel picker");
  return Array.from(select.options)
    .filter(option => option.value !== "")
    .map(option => [option.value, option.textContent]);
}

describe("the card editor's panel picker", () => {
  it("the editor lists only panels", async () => {
    // The raw device list: a circuit's device is a child of the panel, with a
    // `parent_device_id` and no `via_device_id` key, and it is listed first.
    const circuitDevice = {
      id: "circuit-device-1",
      name: "Kitchen Outlets",
      name_by_user: null,
      area_id: "kitchen",
      identifiers: [["span_panel", "sp3-test-001_circuit_0123456789abcdef"]],
      parent_device_id: PANEL_DEVICE_ID,
    };
    const battery = {
      id: "bess-1",
      name: "Battery",
      identifiers: [["span_panel", "sp3-test-001_bess"]],
      via_device_id: PANEL_DEVICE_ID,
      parent_device_id: null,
    };
    const secondPanel = {
      id: "panel-device-2",
      name: "Garage Panel",
      identifiers: [["span_panel", "sp3-test-002"]],
      via_device_id: null,
      parent_device_id: null,
    };
    const stranger = { id: "other-1", name: "Thermostat", identifiers: [["other_domain", "abc"]], via_device_id: null, parent_device_id: null };

    const editor = await openEditor([circuitDevice, battery, PANEL_DEVICE, stranger, secondPanel]);

    expect(panelChoices(editor)).toEqual([
      [PANEL_DEVICE_ID, "Span Panel (sp3-test-001)"],
      ["panel-device-2", "Garage Panel (sp3-test-002)"],
    ]);
  });
});

describe("the card editor's entity checkboxes", () => {
  it("lists both chargers, each under its own heading with its own checkboxes", async () => {
    const editor = await openEditor();

    expect(outline(sectionContainer(editor, "EV Charger (EVSE)"))).toEqual(["# Drive A", "Status", "# Drive B", "Status", "Lock State"]);
  });

  it("lists the Solar device and its inverter, each under its own heading, without what their tiles draw", async () => {
    const editor = await openEditor();

    expect(outline(sectionContainer(editor, "Solar (PV)"))).toEqual([
      "# Span Panel Solar",
      "PV Vendor",
      "PV Product",
      "# Span Panel Solar Inverter (Garage)",
      "PV Vendor",
    ]);
  });

  it("writes a ticked entity to visible_sub_entities", async () => {
    const editor = await openEditor();
    const changes: CardConfig[] = [];
    editor.addEventListener("config-changed", event => changes.push((event as CustomEvent<{ config: CardConfig }>).detail.config));

    const rows = Array.from(sectionContainer(editor, "EV Charger (EVSE)").children);
    const lockRow = rows.find(row => row.querySelector("span")?.textContent === "Lock State");
    const checkbox = lockRow?.querySelector("input");
    if (!checkbox) throw new Error("no Lock State checkbox");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));

    // The one tick fires one config-changed, carrying the ticked entity.
    expect(changes.map(config => config.visible_sub_entities)).toEqual([{ "sensor.drive_b_lock": true }]);
  });
});
