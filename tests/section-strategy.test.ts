import { describe, it, expect } from "vitest";
import { SpanPanelSectionStrategy } from "../src/strategy/span-panel-section-strategy.js";
import { BATTERY_DEVICE, CIRCUIT_DEVICE, OTHER_DEVICE, PANEL, SECOND_PANEL, hassWithRegistries } from "./hass-registries.js";

/**
 * Home Assistant 2026.11 offers the section among the Community sections: it
 * previews and starts a new section from `getStubConfig`, builds the section
 * from `generate`, and generates it again when a registry the strategy names
 * in `registryDependencies` changes.
 */

describe("SpanPanelSectionStrategy.getStubConfig", () => {
  it("starts from the first SPAN panel, passing over the integration's other devices and other integrations'", () => {
    const hass = hassWithRegistries([OTHER_DEVICE, CIRCUIT_DEVICE, BATTERY_DEVICE, SECOND_PANEL, PANEL]);
    expect(SpanPanelSectionStrategy.getStubConfig(hass)).toEqual({ type: "custom:span-panel", device_id: SECOND_PANEL.id });
  });

  it("names no panel where there is none", () => {
    expect(SpanPanelSectionStrategy.getStubConfig(hassWithRegistries([OTHER_DEVICE, CIRCUIT_DEVICE]))).toEqual({ type: "custom:span-panel" });
  });

  it("names no panel before the frontend has loaded the device registry", () => {
    const hass = hassWithRegistries([]);
    delete hass.devices;
    expect(SpanPanelSectionStrategy.getStubConfig(hass)).toEqual({ type: "custom:span-panel" });
  });
});

describe("SpanPanelSectionStrategy.generate", () => {
  const hass = hassWithRegistries([PANEL, SECOND_PANEL, CIRCUIT_DEVICE, BATTERY_DEVICE]);

  it("is a grid section of a heading with the panel's name above the panel's card at the section's full width", async () => {
    await expect(SpanPanelSectionStrategy.generate({ type: "custom:span-panel", device_id: PANEL.id }, hass)).resolves.toEqual({
      type: "grid",
      cards: [
        { type: "heading", heading: "SPAN Panel" },
        { type: "custom:span-panel-card", device_id: PANEL.id, grid_options: { columns: "full" } },
      ],
    });
  });

  it("heads the section with the user's name for the panel before the integration's", async () => {
    const section = await SpanPanelSectionStrategy.generate({ type: "custom:span-panel", device_id: SECOND_PANEL.id }, hass);
    expect(section.cards[0]).toEqual({ type: "heading", heading: "Garage Panel" });
    expect(section.cards[1].device_id).toBe(SECOND_PANEL.id);
  });

  it("heads the section with the default panel name where the device is not found, and leaves the card to report it", async () => {
    const section = await SpanPanelSectionStrategy.generate({ type: "custom:span-panel", device_id: "removed-device" }, hass);
    expect(section.cards).toEqual([
      { type: "heading", heading: "SPAN Panel" },
      { type: "custom:span-panel-card", device_id: "removed-device", grid_options: { columns: "full" } },
    ]);
  });

  it("gives the card no device where the config names none, so the card shows its preview", async () => {
    const section = await SpanPanelSectionStrategy.generate({ type: "custom:span-panel" }, hass);
    expect(section.cards).toEqual([
      { type: "heading", heading: "SPAN Panel" },
      { type: "custom:span-panel-card", grid_options: { columns: "full" } },
    ]);
  });

  it("previews the section it starts from", async () => {
    const stub = SpanPanelSectionStrategy.getStubConfig(hass);
    const section = await SpanPanelSectionStrategy.generate(stub, hass);
    expect(section.cards[1]).toEqual({ type: "custom:span-panel-card", device_id: PANEL.id, grid_options: { columns: "full" } });
  });
});

describe("SpanPanelSectionStrategy.registryDependencies", () => {
  it("regenerates on device registry changes only, which is all the section reads", () => {
    expect(SpanPanelSectionStrategy.registryDependencies).toEqual(["devices"]);
  });
});
