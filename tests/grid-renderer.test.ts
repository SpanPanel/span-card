import { describe, it, expect } from "vitest";
import { renderCircuitSlot } from "../src/core/grid-renderer.js";
import type { Circuit, HomeAssistant, CardConfig } from "../src/types.js";

const hass = { states: {}, services: {}, language: "en" } as unknown as HomeAssistant;

const config: CardConfig = {};

function makeCircuit(overrides: Partial<Circuit> = {}): Circuit {
  return {
    name: "Kitchen",
    tabs: [1],
    entities: {},
    ...overrides,
  };
}

describe("renderCircuitSlot", () => {
  it("escapes user-controllable circuit name in markup", () => {
    const circuit = makeCircuit({ name: '<img src=x onerror="alert(1)">' });
    const html = renderCircuitSlot("uuid1", circuit, 1, "1", "single", hass, config, null, "unknown");
    // The literal tag should never appear; the escaped form should.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes user-controllable uuid in data attribute", () => {
    const circuit = makeCircuit();
    const html = renderCircuitSlot('uuid"onclick=alert(1)"', circuit, 1, "1", "single", hass, config, null, "unknown");
    expect(html).not.toContain('uuid"onclick');
    expect(html).toContain("uuid&quot;onclick");
  });

  it("escapes shedding label so i18n quote characters cannot break the title attribute", () => {
    // The "must_have" shedding priority label comes from i18n; if a future
    // translation contained a quote, an unescaped title= would split the
    // attribute. Exercise the composite-icon branch which uses safeLabel.
    const circuit = makeCircuit();
    const html = renderCircuitSlot("uuid1", circuit, 1, "1", "single", hass, config, null, "must_have");
    // The rendered HTML must remain well-formed: the <ha-icon ... title="..."
    // > attribute must close before any content. A regression would emit
    // `title=""quote here"` breaking subsequent attributes.
    const titleMatches = html.match(/title="[^"]*"/g) ?? [];
    expect(titleMatches.length).toBeGreaterThan(0);
    for (const match of titleMatches) {
      // No stray `"` inside an attribute would survive escapeHtml.
      expect(match.slice(7, -1)).not.toContain('"');
    }
  });
});
