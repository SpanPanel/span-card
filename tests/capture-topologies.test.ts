/**
 * The card rendered over each reference capture as the integration reports it.
 *
 * `fixtures/topology/<stem>.json` is the integration's `panel_topology` answer for
 * the capture and `fixtures/expected_entities/<stem>.json` the entities it creates
 * with their states; both are copied unchanged from the integration's test
 * fixtures of the same name. A drawn grid and header must follow from them, and
 * the snapshots hold every capture's rendering still: a change to one is a
 * deliberate, visible edit.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import "../src/card/span-panel-card.js";
import { t } from "../src/i18n.js";
import type { CardConfig, HomeAssistant, HassEntity, PanelTopology } from "../src/types.js";
import { FakeConnection, flush, hassWith } from "./fake-connection.js";
import main32R202633Topology from "./fixtures/topology/main32_r202633.json";
import main32R202639Topology from "./fixtures/topology/main32_r202639.json";
import aTopology from "./fixtures/topology/r202639-a.json";
import bTopology from "./fixtures/topology/r202639-b.json";
import cTopology from "./fixtures/topology/r202639-c.json";
import dTopology from "./fixtures/topology/r202639-d.json";
import eTopology from "./fixtures/topology/r202639-e.json";
import main32R202633Entities from "./fixtures/expected_entities/main32_r202633.json";
import main32R202639Entities from "./fixtures/expected_entities/main32_r202639.json";
import aEntities from "./fixtures/expected_entities/r202639-a.json";
import bEntities from "./fixtures/expected_entities/r202639-b.json";
import cEntities from "./fixtures/expected_entities/r202639-c.json";
import dEntities from "./fixtures/expected_entities/r202639-d.json";
import eEntities from "./fixtures/expected_entities/r202639-e.json";

interface ExpectedEntities {
  entities: Record<string, { entity_id: string; state: string | null }>;
}

interface Capture {
  stem: string;
  topology: PanelTopology;
  entities: ExpectedEntities;
}

const CAPTURES: Capture[] = [
  { stem: "main32_r202633", topology: main32R202633Topology as PanelTopology, entities: main32R202633Entities },
  { stem: "main32_r202639", topology: main32R202639Topology as PanelTopology, entities: main32R202639Entities },
  { stem: "r202639-a", topology: aTopology as PanelTopology, entities: aEntities },
  { stem: "r202639-b", topology: bTopology as PanelTopology, entities: bEntities },
  { stem: "r202639-c", topology: cTopology as PanelTopology, entities: cEntities },
  { stem: "r202639-d", topology: dTopology as PanelTopology, entities: dEntities },
  { stem: "r202639-e", topology: eTopology as PanelTopology, entities: eEntities },
];

/** The states Home Assistant holds for the capture: every entity that is not disabled. */
function statesOf(entities: ExpectedEntities): Record<string, HassEntity> {
  const states: Record<string, HassEntity> = {};
  for (const { entity_id, state } of Object.values(entities.entities)) {
    if (state === null) continue;
    states[entity_id] = { entity_id, state, attributes: {}, last_changed: "", last_updated: "" };
  }
  return states;
}

/** Monitoring as the integration answers it before anyone turns it on. */
const MONITORING_OFF = { enabled: false };

type MountedCard = HTMLElement & { setConfig(c: CardConfig): void; hass: HomeAssistant };

const mounted: HTMLElement[] = [];
let monitoringAnswers = 0;
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
  monitoringAnswers = 0;
});

async function render(capture: Capture): Promise<ShadowRoot> {
  const callWS = (async (msg: Record<string, unknown>) => {
    if (msg.type === "span_panel/panel_topology") return structuredClone(capture.topology);
    if (msg.type === "call_service" && msg.service === "get_monitoring_status") {
      monitoringAnswers += 1;
      return { response: MONITORING_OFF };
    }
    return [];
  }) as HomeAssistant["callWS"];
  const hass = hassWith(new FakeConnection(), { callWS, states: statesOf(capture.entities) });
  const card = document.createElement("span-panel-card") as MountedCard;
  card.setConfig({ device_id: capture.topology.device_id ?? "panel" });
  document.body.appendChild(card);
  mounted.push(card);
  card.hass = hass;
  await vi.waitFor(() => expect(card.shadowRoot!.querySelector(".panel-grid")).not.toBeNull());
  return card.shadowRoot!;
}

function labels(root: ParentNode): number[] {
  return [...root.querySelectorAll(".panel-grid .tab-label")].map(label => Number(label.textContent)).sort((a, b) => a - b);
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function statText(root: ParentNode, name: string): string | null {
  return root.querySelector(`.panel-stats .${name} .stat-value`)?.textContent ?? null;
}

describe.each(CAPTURES)("the card over capture $stem", capture => {
  const { topology } = capture;
  const states = statesOf(capture.entities);

  it("loads, with no topology error", async () => {
    const root = await render(capture);
    expect(root.textContent).not.toContain(t("card.topology_error"));
  });

  it("draws exactly the breaker positions the panel reports", async () => {
    const root = await render(capture);
    expect(labels(root)).toEqual(range(topology.first_position!, topology.last_position!));
  });

  it("draws every breaker in the grid and every meter outside it", async () => {
    const root = await render(capture);
    const slots = new Set([...root.querySelectorAll<HTMLElement>(".panel-grid .circuit-slot[data-uuid]")].map(el => el.dataset.uuid));
    for (const [id, circuit] of Object.entries(topology.circuits)) {
      // Circuits that share a meter are drawn in the slot of the group's key.
      const drawnAs = circuit.shared_meter_group ?? id;
      expect(slots.has(drawnAs), id).toBe(circuit.outside_panel !== true);
    }
  });

  it("names every member of a shared space in its one slot", async () => {
    const root = await render(capture);
    for (const circuit of Object.values(topology.circuits)) {
      if (!circuit.shared_meter_group) continue;
      const slot = root.querySelector(`.panel-grid .circuit-slot[data-uuid="${circuit.shared_meter_group}"] .circuit-name`);
      expect(slot?.textContent).toContain(circuit.name);
    }
  });

  it("shows the battery charge only as published", async () => {
    const root = await render(capture);
    const entityId = topology.panel_entities?.battery_level;
    if (!entityId) {
      expect(root.querySelector(".panel-stats .stat-battery")).toBeNull();
      return;
    }
    const charge = Number.parseFloat(states[entityId]?.state ?? "");
    expect(statText(root, "stat-battery")).toBe(Number.isFinite(charge) ? `${Math.round(charge)}` : "--");
  });

  it("shows the grid state the integration reports", async () => {
    const root = await render(capture);
    const entityId = topology.panel_entities?.dsm_state;
    expect(statText(root, "stat-grid-state")).toBe(entityId ? (states[entityId]?.state ?? "--") : null);
  });

  it("shows no monitoring summary while monitoring is off", async () => {
    const root = await render(capture);
    await vi.waitFor(() => expect(monitoringAnswers).toBeGreaterThan(0));
    await flush();
    // Drawn again, as any tab change or setting change does, now with the answer in hand.
    root.querySelector<HTMLElement>('#card-tabs [data-tab="panel"]')!.click();
    expect(root.querySelector(".monitoring-summary")).toBeNull();
  });

  it("renders as before", async () => {
    const root = await render(capture);
    expect(root.querySelector(".panel-stats")!.outerHTML).toMatchSnapshot("header");
    expect(root.querySelector(".panel-grid")!.outerHTML).toMatchSnapshot("grid");
    expect(root.querySelector(".sub-devices")?.outerHTML ?? null).toMatchSnapshot("sub-devices");
  });
});
