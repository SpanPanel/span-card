import type { Circuit, PanelTopology } from "../types.js";
import { ratingLabelHTML, ratingMarkHTML, userSetSentence, type RatingView } from "./breaker-rating.js";

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
  /** The topology ids of `members`, in the same order. */
  readonly memberIds: readonly string[];
}

/** A circuit drawn in a slot, with the id the integration's services know it by. */
export interface SlotMember {
  readonly uuid: string;
  readonly circuit: Circuit;
}

/** A slot's circuits, each with its id. */
export function slotMembers(slot: MeterSlot): SlotMember[] {
  return slot.members.map((circuit, i) => ({ uuid: slot.memberIds[i]!, circuit }));
}

/** Each circuit's slot, by the circuit's own id: every member of a shared meter maps to the one slot they share. */
export function slotsByMember(slots: readonly MeterSlot[]): Map<string, MeterSlot> {
  return new Map(slots.flatMap(slot => slot.memberIds.map((id): [string, MeterSlot] => [id, slot])));
}

/**
 * A circuit as current monitoring judges it: itself, carrying the rating of the slot it is drawn in, which for a
 * member of a shared meter is the group's capacity, since every member reads the one meter. Its name, spaces and
 * entities stay its own. A circuit with no slot is judged as it is.
 */
export function judgedAs(circuit: Circuit, slot: MeterSlot | undefined): Circuit {
  return slot ? { ...circuit, breaker_rating_a: slot.circuit.breaker_rating_a } : circuit;
}

/**
 * One slot per meter, in topology order: each group of circuits that share a
 * meter once, at its first member's place, and every other circuit by itself.
 * A circuit with no group is its own slot, unchanged. A group's rating is the
 * integration's, from `shared_meter_groups`; only a group with no record there,
 * as from an integration that predates it, falls back to the members' sum. A
 * member drawn without the others, as one favorited alone is, is still rated by
 * its group's record, since it still reads the one meter.
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
    if (!key || !group) {
      slots.push({ uuid, circuit, members: [circuit], memberIds: [uuid] });
    } else if (group[0]![0] === uuid) {
      const [throughId, through] = group.find(([id]) => id === key) ?? group[0]!;
      const members = group.map(([, member]) => member);
      const rated = topology.shared_meter_groups?.[key];
      slots.push({
        uuid: throughId,
        circuit: { ...through, tabs: occupiedSpaces(members), breaker_rating_a: rated ? rated.breaker_rating_a : combinedRating(members) },
        members,
        memberIds: group.map(([id]) => id),
      });
    }
  }
  return slots;
}

/**
 * Every space the members occupy, ascending. A member need not list them all: on a tandem-quad each single-pole
 * circuit lists only its own space and the two-pole circuit lists both, so the group's own key can be one space short.
 */
export function occupiedSpaces(members: readonly Circuit[]): number[] {
  return [...new Set(members.flatMap(member => member.tabs))].sort((a, b) => a - b);
}

/** What a slot's panel rating reads as: one circuit's "20", or each member's "15·10"; empty while any is unknown. */
function slotAmpsText(members: readonly Circuit[]): string {
  if (members.some(member => !member.breaker_rating_a)) return "";
  return members.map(member => Math.round(member.breaker_rating_a!)).join("·");
}

/**
 * A slot's breaker label as the grid and list draw it: "20A" for a circuit alone, "15·10 A" for circuits that
 * share a meter. It is each breaker's own rating, never the group's capacity; empty while any rating is unknown.
 */
export function slotRatingLabel(members: readonly Circuit[]): string {
  const text = slotAmpsText(members);
  if (!text) return "";
  return members.length === 1 ? `${text}A` : `${text} A`;
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

/** The panel's own ratings summed, or null while any member's is unpublished. */
function combinedPanelRating(members: readonly Circuit[]): number | null {
  let total = 0;
  for (const member of members) {
    if (!member.panel_breaker_rating_a) return null;
    total += member.panel_breaker_rating_a;
  }
  return total;
}

/** A slot's rating as one view: the combined rating, marked when any member's is the user's. */
export function slotRatingView(members: readonly Circuit[]): RatingView {
  return {
    amps: combinedRating(members),
    panelAmps: combinedPanelRating(members),
    userSet: members.some(member => member.breaker_rating_user_set === true),
  };
}

/**
 * A slot's rating as the grid and list draw it: "20A" for a circuit alone, "15·10 A" for circuits that share a meter,
 * with the user-set pencil after it when any member's rating is the user's. Empty while any rating is unknown.
 */
export function slotRatingLabelHTML(members: readonly Circuit[]): string {
  const view = slotRatingView(members);
  if (members.length === 1) return ratingLabelHTML({ ...view, amps: view.amps ? Math.round(view.amps) : view.amps });
  const text = slotAmpsText(members);
  return text ? `${text} A${view.userSet ? ratingMarkHTML(view.panelAmps) : ""}` : "";
}

/** The same label as plain text, for the side panel's subtitle: the user-set form names the panel's rating. */
export function slotRatingText(members: readonly Circuit[]): string {
  const view = slotRatingView(members);
  const text = slotAmpsText(members);
  if (!text) return "";
  if (view.userSet) return userSetSentence(text, view.panelAmps);
  return members.length === 1 ? `${text}A` : `${text} A`;
}
