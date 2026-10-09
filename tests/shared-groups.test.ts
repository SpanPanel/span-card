import { describe, it, expect } from "vitest";
import { buildGridHTML } from "../src/core/grid-renderer.js";
import { buildPanelStatsHTML } from "../src/core/header-renderer.js";
import { updateCircuitDOM } from "../src/core/dom-updater.js";
import { positionRange } from "../src/helpers/layout.js";
import { meterSlots } from "../src/helpers/shared-meters.js";
import { t } from "../src/i18n.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology } from "../src/types.js";

const CONFIG = { chart_metric: "power" } as CardConfig;
const SITE = "sensor.site_power";

/** A circuit on `tab`; with `group`, one of the circuits that share that space's meter and relay. */
function circuit(slug: string, name: string, tab: number, rating: number, group: string | null = null): Circuit {
  return {
    name,
    tabs: [tab],
    breaker_rating_a: rating,
    relay_state: "CLOSED",
    is_user_controllable: true,
    shared_meter_group: group,
    shared_relay_group: group,
    entities: { power: `sensor.${slug}_power`, current: `sensor.${slug}_current`, switch: `switch.${slug}_breaker` },
  };
}

/** Three pairs that each share one space, beside a circuit of its own. */
const CIRCUITS: Record<string, Circuit> = {
  "c-1": circuit("hall", "Hall", 1, 20),
  "c-44a": circuit("lights_a", "Lights A", 44, 15, "c-44a"),
  "c-44b": circuit("outlets_a", "Outlets A", 44, 15, "c-44a"),
  "c-46a": circuit("outlets_b", "Outlets B", 46, 20, "c-46a"),
  "c-46b": circuit("lights_b", "Lights B", 46, 20, "c-46a"),
  "c-48a": circuit("outlets_c", "Outlets C", 48, 15, "c-48a"),
  "c-48b": circuit("lights_c", "Lights C", 48, 10, "c-48a"),
};

function topology(): PanelTopology {
  return { circuits: CIRCUITS, panel_size: 48, first_position: 1, last_position: 48, panel_entities: { site_power: SITE } } as PanelTopology;
}

/** Both members of a pair read the one meter they share. */
function hassWith(extra: Record<string, string> = {}): HomeAssistant {
  const states: Record<string, string> = {
    "sensor.hall_power": "1000",
    "sensor.lights_a_power": "300",
    "sensor.outlets_a_power": "300",
    "sensor.outlets_b_power": "500",
    "sensor.lights_b_power": "500",
    "sensor.outlets_c_power": "0",
    "sensor.lights_c_power": "0",
    "sensor.lights_c_current": "5",
    "sensor.outlets_c_current": "5",
    ...extra,
  };
  for (const slug of ["hall", "lights_a", "outlets_a", "outlets_b", "lights_b", "outlets_c", "lights_c"]) states[`switch.${slug}_breaker`] ??= "on";
  const full = Object.fromEntries(
    Object.entries(states).map(([entity_id, state]) => [entity_id, { entity_id, state, attributes: {}, last_changed: "", last_updated: "" }])
  );
  return { states: full, services: {}, language: "en" } as unknown as HomeAssistant;
}

function grid(hass: HomeAssistant = hassWith()): HTMLElement {
  const div = document.createElement("div");
  const topo = topology();
  div.innerHTML = buildGridHTML(topo, positionRange(topo, 48)!, hass, CONFIG, null);
  return div;
}

function slotAt(root: ParentNode, uuid: string): HTMLElement {
  return root.querySelector<HTMLElement>(`.circuit-slot[data-uuid="${uuid}"]`)!;
}

describe("meterSlots", () => {
  it("gives each group one slot, read through its first member, and every other circuit its own", () => {
    const slots = meterSlots(CIRCUITS);
    expect(slots.map(s => s.uuid)).toEqual(["c-1", "c-44a", "c-46a", "c-48a"]);
    expect(slots[1]!.members.map(m => m.name)).toEqual(["Lights A", "Outlets A"]);
    expect(slots[0]!.circuit).toBe(CIRCUITS["c-1"]);
  });

  it("judges a group against its members' combined rating", () => {
    const slots = meterSlots(CIRCUITS);
    expect(slots.map(s => s.circuit.breaker_rating_a)).toEqual([20, 30, 40, 25]);
  });

  it("has no combined rating while a member's rating is unknown", () => {
    const circuits = { ...CIRCUITS, "c-48b": { ...CIRCUITS["c-48b"]!, breaker_rating_a: null } };
    expect(meterSlots(circuits).find(s => s.uuid === "c-48a")!.circuit.breaker_rating_a).toBeNull();
  });
});

describe("circuits that share a space on the grid", () => {
  it("draw one slot per group at the shared space, losing no circuit", () => {
    const root = grid();
    expect(root.querySelectorAll(".circuit-slot[data-uuid]")).toHaveLength(4);
    for (const member of ["c-44b", "c-46b", "c-48b"]) expect(slotAt(root, member)).toBeNull();
    expect(slotAt(root, "c-44a").getAttribute("style")).toContain("grid-row: 22;");
  });

  it("name both members and give both ratings", () => {
    const root = grid();
    expect(slotAt(root, "c-44a").querySelector(".circuit-name")!.textContent).toBe("Lights A · Outlets A");
    expect(slotAt(root, "c-44a").querySelector(".breaker-badge")!.textContent).toBe("15·15 A");
    expect(slotAt(root, "c-46a").querySelector(".breaker-badge")!.textContent).toBe("20·20 A");
    expect(slotAt(root, "c-48a").querySelector(".breaker-badge")!.textContent).toBe("15·10 A");
  });

  it("show one power value, the shared meter's", () => {
    const root = grid();
    const values = slotAt(root, "c-44a").querySelectorAll(".power-value");
    expect(values).toHaveLength(1);
    expect(values[0]!.textContent!.replace(/\s+/g, "")).toBe("300W");
  });

  it("show one toggle, labelled as switching the group", () => {
    const root = grid();
    const pills = slotAt(root, "c-44a").querySelectorAll(".toggle-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.classList.contains("toggle-shared")).toBe(true);
    expect(pills[0]!.getAttribute("title")).toBe(t("grid.shared_switch"));
    expect(slotAt(root, "c-1").querySelector(".toggle-pill")!.classList.contains("toggle-shared")).toBe(false);
  });

  it("judge utilization against the combined rating", () => {
    // 5 A of a 15·10 A pair is 20%, not 50% of the second member's 10 A.
    const root = grid();
    expect(slotAt(root, "c-48a").querySelector(".utilization")!.textContent).toBe("20%");
  });
});

describe("the site sum", () => {
  it("counts each shared meter once", () => {
    const root = document.createElement("div");
    root.innerHTML = buildPanelStatsHTML(topology(), CONFIG) + grid().innerHTML;
    // With no site reading the header falls back to the circuits' sum: 1000 + 300 + 500 + 0 W, each pair once.
    updateCircuitDOM(root, hassWith(), topology(), CONFIG, new Map(), undefined);
    expect(root.querySelector(".stat-consumption .stat-value")!.textContent).toBe("1.8");
  });
});
