import type { Circuit, PanelTopology } from "../types.js";

/**
 * What one breaker slot draws: a circuit of its own, or the circuits that share
 * one meter. Members of a group read identical meters, so the group is read,
 * switched and counted through one of them and drawn once.
 */
export interface MeterSlot {
  /** The circuit the slot reads and switches through: the group's key when that is a member, else its first. */
  readonly uuid: string;
  /**
   * That circuit, carrying the group's rating as the integration reports it in `shared_meter_groups`, which is what
   * the group is judged against, and every space its members occupy, which is where the group is drawn.
   */
  readonly circuit: Circuit;
  /** Every circuit drawn in the slot, in topology order. */
  readonly members: readonly Circuit[];
}

/**
 * One slot per meter, in topology order: each group of circuits that share a
 * meter once, at its first member's place, and every other circuit by itself.
 * A circuit with no group is its own slot, unchanged. A group's rating is the
 * integration's, from `shared_meter_groups`; only a group with no record there,
 * as from an integration that predates it, falls back to the members' sum.
 */
export function meterSlots(topology: Pick<PanelTopology, "circuits" | "shared_meter_groups">): MeterSlot[] {
  const circuits = topology.circuits;
  const groups = new Map<string, [string, Circuit][]>();
  for (const [uuid, circuit] of Object.entries(circuits)) {
    const key = circuit.shared_meter_group;
    if (key) groups.set(key, [...(groups.get(key) ?? []), [uuid, circuit]]);
  }

  const slots: MeterSlot[] = [];
  for (const [uuid, circuit] of Object.entries(circuits)) {
    const key = circuit.shared_meter_group;
    const group = key ? groups.get(key) : undefined;
    if (!key || !group || group.length === 1) {
      slots.push({ uuid, circuit, members: [circuit] });
    } else if (group[0]![0] === uuid) {
      const [throughId, through] = group.find(([id]) => id === key) ?? group[0]!;
      const members = group.map(([, member]) => member);
      const rated = topology.shared_meter_groups?.[key];
      slots.push({
        uuid: throughId,
        circuit: { ...through, tabs: occupiedSpaces(members), breaker_rating_a: rated ? rated.breaker_rating_a : combinedRating(members) },
        members,
      });
    }
  }
  return slots;
}

/**
 * Every space the members occupy, ascending. A member need not list them all: on a tandem-quad each single-pole
 * circuit lists only its own space and the two-pole circuit lists both, so the group's own key can be one space short.
 */
function occupiedSpaces(members: readonly Circuit[]): number[] {
  return [...new Set(members.flatMap(member => member.tabs))].sort((a, b) => a - b);
}

/**
 * The members' ratings summed, or null while any member's is unknown: only for a group the integration publishes no
 * capacity record for, since on a tandem-quad the sum overstates what its heavier leg can carry.
 */
function combinedRating(members: readonly Circuit[]): number | null {
  let total = 0;
  for (const member of members) {
    if (!member.breaker_rating_a) return null;
    total += member.breaker_rating_a;
  }
  return total;
}
