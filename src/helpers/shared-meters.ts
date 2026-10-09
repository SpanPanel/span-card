import type { Circuit } from "../types.js";

/**
 * What one breaker slot draws: a circuit of its own, or the circuits that share
 * one meter. Members of a group read identical meters, so the group is read,
 * switched and counted through one of them and drawn once.
 */
export interface MeterSlot {
  /** The circuit the slot reads and switches through: the group's key when that is a member, else its first. */
  readonly uuid: string;
  /** That circuit, carrying the group's combined rating, which is what the group is judged against. */
  readonly circuit: Circuit;
  /** Every circuit drawn in the slot, in topology order. */
  readonly members: readonly Circuit[];
}

/**
 * One slot per meter, in topology order: each group of circuits that share a
 * meter once, at its first member's place, and every other circuit by itself.
 * A circuit with no group is its own slot, unchanged.
 */
export function meterSlots(circuits: Record<string, Circuit>): MeterSlot[] {
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
      slots.push({ uuid: throughId, circuit: { ...through, breaker_rating_a: combinedRating(members) }, members });
    }
  }
  return slots;
}

/** The members' ratings summed, or null while any member's is unknown. */
function combinedRating(members: readonly Circuit[]): number | null {
  let total = 0;
  for (const member of members) {
    if (!member.breaker_rating_a) return null;
    total += member.breaker_rating_a;
  }
  return total;
}
