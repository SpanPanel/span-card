import { describe, it, expect } from "vitest";
import { buildExpandedChartHTML } from "../src/core/list-renderer.js";
import type { Circuit, HomeAssistant, CardConfig } from "../src/types.js";

const mockHass = {
  states: {
    "switch.circuit_a": { state: "on", attributes: {} },
    "sensor.circuit_a_power": { state: "150", attributes: {} },
  },
} as unknown as HomeAssistant;

const mockConfig = { chart_metric: "power" } as unknown as CardConfig;

const onCircuit = {
  name: "Kitchen",
  tabs: [1],
  relay_state: "CLOSED",
  entities: { switch: "switch.circuit_a", power: "sensor.circuit_a_power" },
} as unknown as Circuit;

describe("buildExpandedChartHTML", () => {
  it("produces a list-expanded-content wrapper with the circuit uuid", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).toContain('class="list-expanded-content"');
    expect(html).toContain('data-expanded-uuid="uuid-123"');
  });

  it("wraps a circuit-slot that carries the chart-only marker class and data-uuid", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).toContain("circuit-slot");
    expect(html).toContain("circuit-chart-only");
    expect(html).toContain('data-uuid="uuid-123"');
  });

  it("contains exactly one chart-container div", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    const matches = html.match(/class="chart-container"/g);
    expect(matches?.length).toBe(1);
  });

  it("does NOT contain circuit-header or circuit-status duplicated content", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).not.toContain("circuit-header");
    expect(html).not.toContain("circuit-status");
    expect(html).not.toContain("toggle-pill");
    expect(html).not.toContain("breaker-badge");
    expect(html).not.toContain("power-value");
  });

  it("applies circuit-off class when circuit is off", () => {
    const off = {
      name: "Kitchen",
      tabs: [1],
      relay_state: "OPEN",
      entities: { power: "sensor.circuit_a_power" },
    } as unknown as Circuit;
    const html = buildExpandedChartHTML("uuid-123", off, mockHass, mockConfig, null);
    expect(html).toContain("circuit-off");
  });

  it("omits circuit-off class when circuit is on", () => {
    const html = buildExpandedChartHTML("uuid-123", onCircuit, mockHass, mockConfig, null);
    expect(html).not.toContain("circuit-off");
  });

  it("escapes unsafe uuids", () => {
    const html = buildExpandedChartHTML('"><script>alert(1)</script>', onCircuit, mockHass, mockConfig, null);
    expect(html).not.toContain("<script>");
  });
});

import { buildListRowHTML } from "../src/core/list-renderer.js";

const controllableCircuit = {
  name: "Kitchen",
  tabs: [1],
  relay_state: "CLOSED",
  is_user_controllable: true,
  entities: { switch: "switch.circuit_a", power: "sensor.circuit_a_power" },
} as unknown as Circuit;

const nonControllableCircuit = {
  name: "Solar",
  tabs: [2],
  relay_state: "CLOSED",
  is_user_controllable: false,
  entities: { power: "sensor.circuit_b_power" },
} as unknown as Circuit;

describe("buildListRowHTML gear and status control", () => {
  it("adds a gear button with data-uuid", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    expect(html).toContain("gear-icon");
    expect(html).toContain("circuit-gear");
    expect(html).toContain('data-uuid="uuid-42"');
  });

  it("puts the gear after list-power-value and before list-expand-toggle", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    const valueIdx = html.indexOf("list-power-value");
    const gearIdx = html.indexOf("gear-icon");
    const toggleIdx = html.indexOf("list-expand-toggle");
    expect(valueIdx).toBeGreaterThan(-1);
    expect(gearIdx).toBeGreaterThan(valueIdx);
    expect(toggleIdx).toBeGreaterThan(gearIdx);
  });

  it("renders a real toggle-pill when circuit is user-controllable and has a switch entity", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    expect(html).toContain("toggle-pill");
    expect(html).toContain("toggle-knob");
    expect(html).toContain("toggle-label");
    expect(html).not.toContain("list-status-badge");
  });

  it("falls back to a static list-status-badge for non-controllable circuits", () => {
    const html = buildListRowHTML("uuid-42", nonControllableCircuit, mockHass, mockConfig, null, "unknown", false);
    expect(html).toContain("list-status-badge");
    expect(html).not.toContain("toggle-pill");
  });

  it("falls back to a static list-status-badge when circuit has no switch entity", () => {
    const noSwitch = {
      name: "Kitchen",
      tabs: [1],
      relay_state: "CLOSED",
      is_user_controllable: true,
      entities: { power: "sensor.circuit_a_power" },
    } as unknown as Circuit;
    const html = buildListRowHTML("uuid-42", noSwitch, mockHass, mockConfig, null, "unknown", false);
    expect(html).toContain("list-status-badge");
    expect(html).not.toContain("toggle-pill");
  });

  it("adds data-uuid on the list-row (needed by onToggleClick ancestor lookup)", () => {
    const html = buildListRowHTML("uuid-42", controllableCircuit, mockHass, mockConfig, null, "unknown", false);
    const rowMatch = html.match(/<div class="list-row[^"]*"([^>]*)>/);
    expect(rowMatch).not.toBeNull();
    const attrs = rowMatch?.[1] ?? "";
    expect(attrs).toContain('data-uuid="uuid-42"');
    expect(attrs).toContain('data-row-uuid="uuid-42"');
  });
});
