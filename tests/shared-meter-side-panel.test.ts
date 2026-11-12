import { describe, it, expect, vi, afterEach } from "vitest";
import { DashboardController } from "../src/core/dashboard-controller.js";
import "../src/core/side-panel.js";
import type { SlotMember } from "../src/helpers/shared-meters.js";
import type { Circuit, CardConfig, HomeAssistant, PanelTopology } from "../src/types.js";

/** A tandem-quad across spaces 34 and 36, keyed by a single-pole circuit: its heavier leg carries 35 + 20 A. */
function circuit(name: string, tabs: number[], rating: number, voltage: number): Circuit {
  return { name, tabs, breaker_rating_a: rating, voltage, relay_state: "CLOSED", shared_meter_group: "q-34", entities: { power: `sensor.${name}_power` } };
}

const QUAD: Record<string, Circuit> = {
  "q-34": circuit("washer", [34], 20, 120),
  "q-36": circuit("dryer_light", [36], 15, 120),
  "q-2p": circuit("dryer", [34, 36], 35, 240),
};
const RECORD = { members: ["q-34", "q-36", "q-2p"], breaker_rating_a: 55 };
const PANEL = { circuits: QUAD, shared_meter_groups: { "q-34": RECORD } } as PanelTopology;

const hass = { states: {}, services: {}, language: "en", callService: async () => undefined, callWS: async () => ({}) } as unknown as HomeAssistant;

type SidePanel = HTMLElement & { hass: HomeAssistant; open(config: unknown): void };

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function subtitleFor(members: SlotMember[], capacityA: number | null): string | null | undefined {
  const panel = document.createElement("span-side-panel") as SidePanel;
  document.body.appendChild(panel);
  mounted.push(panel);
  panel.hass = hass;
  const { uuid, circuit: first } = members[0]!;
  panel.open({
    uuid,
    name: first.name,
    entities: first.entities,
    members,
    capacityA,
    monitoringInfo: null,
    graphHorizonInfo: { horizon: "5m", has_override: false, globalHorizon: "5m" },
  });
  return panel.shadowRoot!.querySelector(".subtitle")?.textContent;
}

describe("the side panel's subtitle", () => {
  it("names a shared meter's every rating, its capacity, its voltages and every space it occupies", () => {
    const members = Object.entries(QUAD).map(([uuid, c]) => ({ uuid, circuit: c }));
    expect(subtitleFor(members, 55)).toBe("20·15·35 A · 55 A capacity · 120/240V · Tabs [34,36]");
  });

  it("reads a circuit alone as before", () => {
    const alone = { name: "Kitchen", tabs: [2], breaker_rating_a: 20, voltage: 120, entities: {} } as Circuit;
    expect(subtitleFor([{ uuid: "kitchen", circuit: alone }], null)).toBe("20A · 120V · Tabs [2]");
  });
});

/** The side panel `open` call the gear of `uuid` makes, with `root` holding its gear and a side panel. */
async function gearConfig(ctrl: DashboardController, uuid: string): Promise<Record<string, unknown>> {
  const root = document.createElement("div");
  root.innerHTML = `<button class="gear-icon circuit-gear" data-uuid="${uuid}"></button><span-side-panel></span-side-panel>`;
  document.body.appendChild(root);
  mounted.push(root);
  const panel = root.querySelector("span-side-panel") as unknown as { open: (config: unknown) => void };
  const open = vi.spyOn(panel, "open").mockImplementation(() => {});
  await ctrl.onGearClick({ target: root.querySelector(".gear-icon") } as unknown as Event, root);
  return open.mock.calls[0]![0] as Record<string, unknown>;
}

function memberIds(config: Record<string, unknown>): string[] {
  return (config.members as SlotMember[]).map(member => member.uuid);
}

describe("a shared meter's gear", () => {
  it("hands the side panel the whole slot and its capacity, whichever member it is opened from", async () => {
    const ctrl = new DashboardController();
    ctrl.init(PANEL, {} as CardConfig, hass, "entry-1");
    for (const uuid of ["q-34", "q-36"]) {
      const config = await gearConfig(ctrl, uuid);
      expect(memberIds(config)).toEqual(["q-34", "q-36", "q-2p"]);
      expect(config.capacityA).toBe(55);
    }
  });

  it("describes a member favorited alone by its own panel's slot", async () => {
    const ctrl = new DashboardController();
    const merged = { circuits: { "panel-1|q-36": QUAD["q-36"]! }, shared_meter_groups: { "panel-1|q-34": { ...RECORD } } } as PanelTopology;
    ctrl.init(merged, {} as CardConfig, hass, "entry-1");
    ctrl.setFavoriteRefs({ "panel-1|q-36": { panelDeviceId: "panel-1", kind: "circuit", targetId: "q-36", configEntryId: "entry-1" } });
    ctrl.setFavoritesPerPanelInfo(new Map([["panel-1", { panelName: "Garage", topology: PANEL, configEntryId: "entry-1" }]]));

    const config = await gearConfig(ctrl, "panel-1|q-36");

    expect(memberIds(config)).toEqual(["q-34", "q-36", "q-2p"]);
    expect(config.capacityA).toBe(55);
  });
});
