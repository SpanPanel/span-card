import { CIRCUIT_LIVE_FIELDS } from "../types.js";
import { deepEqual } from "../helpers/deep-equal.js";
import type { Circuit, PanelTopology } from "../types.js";

function withoutLiveFields(circuit: Circuit): Record<string, unknown> {
  const structure: Record<string, unknown> = { ...circuit };
  for (const field of CIRCUIT_LIVE_FIELDS) delete structure[field];
  return structure;
}

function structureOf(topology: PanelTopology): Record<string, unknown> {
  const circuits = Object.fromEntries(Object.entries(topology.circuits).map(([id, circuit]) => [id, withoutLiveFields(circuit)]));
  return { ...topology, circuits };
}

/**
 * Whether two topologies render the same view: equal once the circuits' live
 * fields (`CIRCUIT_LIVE_FIELDS`) are set aside. A breaker or priority change
 * alone is not a change of structure.
 */
export function sameTopologyStructure(next: PanelTopology, current: PanelTopology | null): boolean {
  return current !== null && deepEqual(structureOf(next), structureOf(current));
}
