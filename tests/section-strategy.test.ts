import { describe, it, expect } from "vitest";
import { SpanPanelSectionStrategy } from "../src/strategy/span-panel-section-strategy.js";
import { BATTERY_DEVICE, CIRCUIT_DEVICE, OTHER_DEVICE, PANEL, PANEL_TWIN, SECOND_PANEL, hassWithRegistries } from "./hass-registries.js";

/**
 * Home Assistant 2026.11 offers the section among the Community sections: it
 * previews and starts a new section from `getStubConfig`, builds the section
 * from `generate`, and generates it again when a registry the strategy names
 * in `registryDependencies` changes.
 */

describe("SpanPanelSectionStrategy.getStubConfig", () => {
  it("starts from the first SPAN panel, passing over the integration's other devices and other integrations'", async () => {
    const hass = hassWithRegistries([OTHER_DEVICE, CIRCUIT_DEVICE, BATTERY_DEVICE, SECOND_PANEL, PANEL]);
    await expect(SpanPanelSectionStrategy.getStubConfig(hass)).resolves.toEqual({ type: "custom:span-panel", device_id: SECOND_PANEL.id });
  });

  it("passes over the copy of a panel's device a helper owns, listed before the panel", async () => {
    const hass = hassWithRegistries([PANEL_TWIN, PANEL, SECOND_PANEL]);
    await expect(SpanPanelSectionStrategy.getStubConfig(hass)).resolves.toEqual({ type: "custom:span-panel", device_id: PANEL.id });
  });

  it("names no panel where there is none", async () => {
    await expect(SpanPanelSectionStrategy.getStubConfig(hassWithRegistries([OTHER_DEVICE, CIRCUIT_DEVICE, PANEL_TWIN]))).resolves.toEqual({
      type: "custom:span-panel",
    });
  });

  it("names no panel where the integration has no config entry", async () => {
    await expect(SpanPanelSectionStrategy.getStubConfig(hassWithRegistries([PANEL, SECOND_PANEL], [], []))).resolves.toEqual({ type: "custom:span-panel" });
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
    const stub = await SpanPanelSectionStrategy.getStubConfig(hass);
    const section = await SpanPanelSectionStrategy.generate(stub, hass);
    expect(section.cards[1]).toEqual({ type: "custom:span-panel-card", device_id: PANEL.id, grid_options: { columns: "full" } });
  });
});

describe("SpanPanelSectionStrategy.registryDependencies", () => {
  it("regenerates on device registry changes only, which is all the section reads", () => {
    expect(SpanPanelSectionStrategy.registryDependencies).toEqual(["devices"]);
  });
});
