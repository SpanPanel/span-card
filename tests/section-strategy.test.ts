import { describe, it, expect } from "vitest";
import { SpanPanelSectionStrategy } from "../src/strategy/span-panel-section-strategy.js";
import { BATTERY_DEVICE, CIRCUIT_DEVICE, OTHER_DEVICE, PANEL, PANEL_TWIN, SECOND_PANEL, hassWithRegistries } from "./hass-registries.js";

/**
 * Home Assistant 2026.11 offers the section among the Community sections: it
 * previews and starts a new section from `getStubConfig`, builds the section
 * from `generate`, and generates it again when a registry the strategy names
 * in `registryDependencies` changes.
 */

/** A circuit's device and a battery beside the panels, which the stub passes over. */
const NOT_PANELS = [OTHER_DEVICE, CIRCUIT_DEVICE, BATTERY_DEVICE];

describe("SpanPanelSectionStrategy.getStubConfig", () => {
  it("starts from the first SPAN panel, passing over the integration's other devices and other integrations'", async () => {
    const hass = hassWithRegistries([...NOT_PANELS, SECOND_PANEL, PANEL]);
    await expect(SpanPanelSectionStrategy.getStubConfig(hass)).resolves.toEqual({ type: "custom:span-panel", device_id: SECOND_PANEL.id });
  });

  it("passes over the copy of a panel's device a helper owns, listed before the panel", async () => {
    const hass = hassWithRegistries([PANEL_TWIN, PANEL, SECOND_PANEL]);
    await expect(SpanPanelSectionStrategy.getStubConfig(hass)).resolves.toEqual({ type: "custom:span-panel", device_id: PANEL.id });
  });

  it("names no panel where there is none", async () => {
    await expect(SpanPanelSectionStrategy.getStubConfig(hassWithRegistries([...NOT_PANELS, PANEL_TWIN]))).resolves.toEqual({
      type: "custom:span-panel",
    });
  });

  it("names no panel where the integration has no config entry", async () => {
    await expect(SpanPanelSectionStrategy.getStubConfig(hassWithRegistries([PANEL, SECOND_PANEL], [], []))).resolves.toEqual({ type: "custom:span-panel" });
  });
});

describe("SpanPanelSectionStrategy.generate", () => {
  it("is a grid section holding the panel's card alone, at the section's full width", async () => {
    await expect(SpanPanelSectionStrategy.generate({ type: "custom:span-panel", device_id: PANEL.id })).resolves.toEqual({
      type: "grid",
      cards: [{ type: "custom:span-panel-card", device_id: PANEL.id, grid_options: { columns: "full" } }],
    });
  });

  it("hands the card every one of its options the section's config holds", async () => {
    const options = {
      device_id: SECOND_PANEL.id,
      history_days: 1,
      history_hours: 2,
      history_minutes: 30,
      chart_metric: "current",
      show_panel: false,
      show_battery: false,
      show_evse: true,
      show_solar: false,
      visible_sub_entities: { "sensor.span_panel_battery_level": true },
      tab_style: "icon" as const,
    };
    const section = await SpanPanelSectionStrategy.generate({ type: "custom:span-panel", ...options });
    expect(section.cards).toEqual([{ ...options, type: "custom:span-panel-card", grid_options: { columns: "full" } }]);
  });

  it("hands the card nothing of the section's config that is not one of the card's options", async () => {
    const config = { type: "custom:span-panel" as const, device_id: PANEL.id, column_span: 4, heading: "Panel", grid_options: { columns: 6 } };
    const section = await SpanPanelSectionStrategy.generate(config);
    expect(section.cards).toEqual([{ type: "custom:span-panel-card", device_id: PANEL.id, grid_options: { columns: "full" } }]);
  });

  it("hands on a device the registry does not hold as it is, for the card to report", async () => {
    const section = await SpanPanelSectionStrategy.generate({ type: "custom:span-panel", device_id: "removed-device" });
    expect(section.cards).toEqual([{ type: "custom:span-panel-card", device_id: "removed-device", grid_options: { columns: "full" } }]);
  });

  it("gives the card no device where the config names none, so the card shows its preview", async () => {
    const section = await SpanPanelSectionStrategy.generate({ type: "custom:span-panel" });
    expect(section.cards).toEqual([{ type: "custom:span-panel-card", grid_options: { columns: "full" } }]);
  });

  it("previews the section it starts from", async () => {
    const stub = await SpanPanelSectionStrategy.getStubConfig(hassWithRegistries([PANEL_TWIN, PANEL, SECOND_PANEL]));
    const section = await SpanPanelSectionStrategy.generate(stub);
    expect(section.cards).toEqual([{ type: "custom:span-panel-card", device_id: PANEL.id, grid_options: { columns: "full" } }]);
  });
});

describe("SpanPanelSectionStrategy.registryDependencies", () => {
  /**
   * The frontend's rule, `checkStrategyShouldRegenerate` at frontend 20261028:
   * a strategy that declares no dependencies is regenerated on entities,
   * devices, areas and floors; one that declares them, on any of those.
   */
  const DEFAULT_DEPENDENCIES = ["entities", "devices", "areas", "floors"] as const;
  type Registries = Record<"entities" | "devices" | "areas" | "floors" | "labels" | "panels", object>;
  function shouldRegenerate(dependencies: readonly (keyof Registries)[] | undefined, oldHass: Registries, newHass: Registries): boolean {
    return (dependencies ?? DEFAULT_DEPENDENCIES).some(key => oldHass[key] !== newHass[key]);
  }
  const registries = (): Registries => ({ entities: {}, devices: {}, areas: {}, floors: {}, labels: {}, panels: {} });

  it("is never regenerated when a registry changes, since it reads none", () => {
    const before = registries();
    const after = registries();

    expect(shouldRegenerate(SpanPanelSectionStrategy.registryDependencies, before, after)).toBe(false);
    // The same change regenerates a strategy that declares no dependencies.
    expect(shouldRegenerate(undefined, before, after)).toBe(true);
  });
});
