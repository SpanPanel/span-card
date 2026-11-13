import { describe, it, expect, afterEach } from "vitest";
import "../src/core/side-panel.js";
import type { Circuit, HomeAssistant } from "../src/types.js";

type SidePanel = HTMLElement & { hass: HomeAssistant; open(config: unknown): void };

function hass(): HomeAssistant {
  return { states: {}, services: {}, language: "en", callService: async () => undefined, callWS: async () => ({}) } as unknown as HomeAssistant;
}

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function mount(): SidePanel {
  const panel = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(panel);
  mounted.push(panel);
  panel.hass = hass();
  return panel;
}

/** Opens the side panel on a lone circuit the user named `name`. */
function openCircuit(name: string): SidePanel {
  const circuit: Circuit = { name, tabs: [3], voltage: 240, breaker_rating_a: 20, entities: {} };
  const panel = mount();
  panel.open({
    uuid: "c-1",
    name,
    members: [{ uuid: "c-1", circuit }],
    capacityA: null,
    entities: {},
    monitoringInfo: null,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
  });
  return panel;
}

/** Opens the side panel on a sub-device named `name`, of type `deviceType`. */
function openSubDevice(name: string, deviceType: string): SidePanel {
  const panel = mount();
  panel.open({
    subDeviceMode: true,
    subDeviceId: "sub-1",
    name,
    deviceType,
    hasChart: false,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
  });
  return panel;
}

const header = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>(".panel-header")!;
const title = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>(".title")!;
const subtitle = (p: SidePanel): HTMLElement => p.shadowRoot!.querySelector<HTMLElement>(".subtitle")!;

describe("a circuit's side panel title", () => {
  it("shows the circuit's name as written", () => {
    const panel = openCircuit("Washer & Dryer 20-30");

    expect(title(panel).textContent).toBe("Washer & Dryer 20-30");
  });

  it("shows markup in the name as literal text, and draws no element from it", () => {
    const panel = openCircuit("<b>x</b>");

    expect(title(panel).textContent).toBe("<b>x</b>");
    expect(title(panel).children).toHaveLength(0);
    expect(header(panel).querySelector("b")).toBeNull();
  });
});

describe("a sub-device's side panel title and subtitle", () => {
  it("show the sub-device's name and type as written", () => {
    const panel = openSubDevice("Washer & Dryer 20-30", "Battery & Storage");

    expect(title(panel).textContent).toBe("Washer & Dryer 20-30");
    expect(subtitle(panel).textContent).toBe("Battery & Storage");
  });

  it("show markup in the name and type as literal text, and draw no element from it", () => {
    const panel = openSubDevice("<b>x</b>", "<b>y</b>");

    expect(title(panel).textContent).toBe("<b>x</b>");
    expect(subtitle(panel).textContent).toBe("<b>y</b>");
    expect(title(panel).children).toHaveLength(0);
    expect(subtitle(panel).children).toHaveLength(0);
    expect(header(panel).querySelector("b")).toBeNull();
  });
});
