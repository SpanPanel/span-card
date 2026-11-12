import { describe, it, expect } from "vitest";
import { buildGridHTML } from "../src/core/grid-renderer.js";
import { buildPanelStatsHTML } from "../src/core/header-renderer.js";
import { updateCircuitDOM } from "../src/core/dom-updater.js";
import { positionRange } from "../src/helpers/layout.js";
import { meterSlots } from "../src/helpers/shared-meters.js";
import { t } from "../src/i18n.js";
import type { CardConfig, Circuit, HomeAssistant, PanelTopology, SharedMeterGroup } from "../src/types.js";

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

/** What the integration rates a group against; the card adds nothing up where it has this. */
function group(members: string[], rating: number | null): SharedMeterGroup {
  return { members, breaker_rating_a: rating };
}

/** Each pair's capacity as the integration publishes it: both members on one space, so their ratings add. */
const GROUPS: Record<string, SharedMeterGroup> = {
  "c-44a": group(["c-44a", "c-44b"], 30),
  "c-46a": group(["c-46a", "c-46b"], 40),
  "c-48a": group(["c-48a", "c-48b"], 25),
};

function topology(): PanelTopology {
  return {
    circuits: CIRCUITS,
    shared_meter_groups: GROUPS,
    panel_size: 48,
    first_position: 1,
    last_position: 48,
    panel_entities: { site_power: SITE },
  } as PanelTopology;
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
    const slots = meterSlots(topology());
    expect(slots.map(s => s.uuid)).toEqual(["c-1", "c-44a", "c-46a", "c-48a"]);
    expect(slots[1]!.members.map(m => m.name)).toEqual(["Lights A", "Outlets A"]);
    expect(slots[0]!.circuit).toBe(CIRCUITS["c-1"]);
  });

  it("rates a group as the integration reports it", () => {
    const slots = meterSlots(topology());
    expect(slots.map(s => s.circuit.breaker_rating_a)).toEqual([20, 30, 40, 25]);
  });

  it("has no rating where the integration reports the group's capacity as unknown, and adds nothing up in its place", () => {
    const unknown = { ...topology(), shared_meter_groups: { ...GROUPS, "c-48a": group(["c-48a", "c-48b"], null) } };
    expect(meterSlots(unknown).find(s => s.uuid === "c-48a")!.circuit.breaker_rating_a).toBeNull();
  });

  it("falls back to the members' sum only for a group with no record, as from an older integration", () => {
    expect(meterSlots({ circuits: CIRCUITS }).map(s => s.circuit.breaker_rating_a)).toEqual([20, 30, 40, 25]);
    // c-48a has no record, so its members' 15 + 10 A stand; c-46a's record is read as published, not summed.
    const unlisted = { ...topology(), shared_meter_groups: { "c-44a": GROUPS["c-44a"]!, "c-46a": group(["c-46a", "c-46b"], 12) } };
    expect(meterSlots(unlisted).map(s => s.circuit.breaker_rating_a)).toEqual([20, 30, 12, 25]);
    const circuits = { ...CIRCUITS, "c-48b": { ...CIRCUITS["c-48b"]!, breaker_rating_a: null } };
    expect(meterSlots({ circuits }).find(s => s.uuid === "c-48a")!.circuit.breaker_rating_a).toBeNull();
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

  it("judge utilization against the group's rating", () => {
    // 5 A of a 15·10 A pair is 20% of the 25 A the integration reports, not 50% of the second member's 10 A.
    const root = grid();
    expect(slotAt(root, "c-48a").querySelector(".utilization")!.textContent).toBe("20%");
  });
});

/** A multi-load breaker across spaces 34 and 36: every member reads one meter, keyed by its first member. */
function spanning(members: Record<string, number[]>): Record<string, Circuit> {
  const key = Object.keys(members)[0]!;
  return Object.fromEntries(Object.entries(members).map(([uuid, tabs]) => [uuid, { ...circuit(uuid, uuid, tabs[0]!, 20, key), tabs }]));
}

function gridOf(circuits: Record<string, Circuit>): HTMLElement {
  const div = document.createElement("div");
  const topo = { circuits, panel_size: 48, first_position: 1, last_position: 48, panel_entities: { site_power: SITE } } as PanelTopology;
  div.innerHTML = buildGridHTML(topo, positionRange(topo, 48)!, hassWith(), CONFIG, null);
  return div;
}

describe("a group whose members occupy different spaces", () => {
  // A tandem-quad's single-pole circuits each list their own space and its two-pole circuit lists both;
  // a quad's two circuits are both two-pole and each lists both. Here the group is keyed by a single-pole member.
  const TANDEM_QUAD = spanning({ "q-34": [34], "q-36": [36], "q-2p": [34, 36] });
  const QUAD = spanning({ "q-a": [34, 36], "q-b": [34, 36] });

  it.each([
    ["a tandem-quad", TANDEM_QUAD],
    ["a quad", QUAD],
  ])("covers every member's spaces in %s's slot", (_, circuits) => {
    expect(meterSlots({ circuits })[0]!.circuit.tabs).toEqual([34, 36]);
  });

  it("rates a tandem-quad by the integration's capacity, its heavier leg, not by its members' sum", () => {
    // 20 + 15 + 35 A would be 70 A; the heavier leg carries the two-pole 35 A and the larger single pole's 20 A.
    const circuits = {
      ...TANDEM_QUAD,
      "q-36": { ...TANDEM_QUAD["q-36"]!, breaker_rating_a: 15 },
      "q-2p": { ...TANDEM_QUAD["q-2p"]!, breaker_rating_a: 35 },
    };
    const slots = meterSlots({ circuits, shared_meter_groups: { "q-34": group(["q-34", "q-36", "q-2p"], 55) } });
    expect(slots[0]!.circuit.breaker_rating_a).toBe(55);
    expect(slotAt(gridOf(circuits), "q-34").querySelector(".breaker-badge")!.textContent).toBe("20·15·35 A");
  });

  it.each([
    ["a tandem-quad", TANDEM_QUAD, "q-34"],
    ["a quad", QUAD, "q-a"],
  ])("draws %s as one slot spanning both spaces, leaving neither empty", (_, circuits, key) => {
    const root = gridOf(circuits);
    expect(root.querySelectorAll(".circuit-slot[data-uuid]")).toHaveLength(1);
    expect(slotAt(root, key).classList.contains("circuit-col-span")).toBe(true);
    expect(root.querySelectorAll(".circuit-empty")).toHaveLength(46);
  });
});

describe("the site sum", () => {
  it("counts each shared meter once", () => {
    const root = document.createElement("div");
    root.innerHTML = buildPanelStatsHTML(topology(), CONFIG) + grid().innerHTML;
    // With no site reading the header falls back to the circuits' sum: 1000 + 300 + 500 + 0 W, each pair once.
    updateCircuitDOM(root, hassWith(), topology(), CONFIG, new Map(), undefined, null);
    expect(root.querySelector(".stat-consumption .stat-value")!.textContent).toBe("1.8");
  });
});
