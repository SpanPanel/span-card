import { INTEGRATION_DOMAIN } from "../constants.js";
import { isUnauthorized, serviceErrorMessage } from "../helpers/error-text.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import { isFavoritesTopology } from "../types.js";
import type { ErrorStore } from "./error-store.js";
import type { Circuit, ControlAccess, ControlBlock, FavoriteCircuitRef, FavoriteRef, FavoritesTopology, HomeAssistant, PanelTopology } from "../types.js";

/** Controls the user may operate: what the card takes where the integration says nothing of them. */
export const CONTROLS_OPERABLE: ControlAccess = Object.freeze({ mayOperate: true, reason: null });

/** Controls whose access the card cannot tell, as a circuit with no ref of its own, or none at all: taken as not operable. */
export const CONTROLS_NOT_KNOWN: ControlAccess = Object.freeze({ mayOperate: false, reason: null });

const BLOCKS: readonly ControlBlock[] = ["control_disabled", "admin_only", "read_only"];

function isBlock(value: unknown): value is ControlBlock {
  return BLOCKS.some(block => block === value);
}

/**
 * Whether the user may operate `topology`'s controls, its relays and shedding
 * priorities, as the integration said when it gave the topology
 * (`control_access`), for the user who asked, by the rule its control gate
 * enforces. `may_operate` decides; `reason` only says why not, and one the
 * card does not know, as a later integration may send, reads as null, which
 * the generic hint answers. Where the integration says nothing, as one that
 * predates it does, and a topology built from the registries, the controls
 * are taken as operable, as they always were; the gate still refuses what it
 * refuses, and the card says why (`reportControlFailure`). This reader alone
 * takes silence as operable: everything after it carries the access it gives.
 */
export function controlAccess(topology: PanelTopology | null | undefined): ControlAccess {
  const wire: unknown = topology?.control_access;
  if (typeof wire !== "object" || wire === null || !("may_operate" in wire) || typeof wire.may_operate !== "boolean") return CONTROLS_OPERABLE;
  if (wire.may_operate) return CONTROLS_OPERABLE;
  return { mayOperate: false, reason: "reason" in wire && isBlock(wire.reason) ? wire.reason : null };
}

function isCircuitRef(ref: FavoriteRef | undefined): ref is FavoriteCircuitRef {
  return ref?.kind === "circuit";
}

/**
 * Whether the user may operate circuit `circuitId`'s controls in `topology`:
 * its panel's access (`controlAccess`), and in the Favorites view that of the
 * panel the circuit came from, as its ref holds it. A circuit there with no
 * circuit ref has no panel to say, and is taken as not operable.
 */
export function circuitControlAccess(topology: PanelTopology | null | undefined, circuitId: string): ControlAccess {
  if (!topology || !isFavoritesTopology(topology)) return controlAccess(topology);
  const ref = topology._favoriteRefs[circuitId];
  return isCircuitRef(ref) ? ref.controlAccess : CONTROLS_NOT_KNOWN;
}

/**
 * The access a view's "Enable Switches" slider answers for, which arms every
 * switch the view draws: operable where the user may operate the controls of
 * any of its panels, else why not, as the first of them says. A Favorites view
 * of several panels counts those it draws a relay or priority control of
 * (`favoritesPanelAccess`), and is armed for those the user may operate; each
 * other circuit's switch refuses on its own (`circuitControlAccess`). A view
 * with no such control has no switch to arm, and nothing to forbid.
 */
export function viewControlAccess(topology: PanelTopology | null | undefined): ControlAccess {
  if (!topology || !isFavoritesTopology(topology)) return controlAccess(topology);
  const panels = [...favoritesPanelAccess(topology).values()];
  const [first] = panels;
  if (!first || panels.some(access => access.mayOperate)) return CONTROLS_OPERABLE;
  return first;
}

/**
 * Whether `circuit` has a control the card draws: a relay switch the user may
 * control (`is_user_controllable`), as `switchPresence` judges it before it
 * reads the switch's state, or a shedding priority select.
 */
function hasControls(circuit: Circuit | undefined): boolean {
  if (!circuit) return false;
  return (!!circuit.entities?.switch && circuit.is_user_controllable !== false) || !!circuit.entities?.select;
}

/**
 * Each panel the Favorites view draws a relay or priority control of, by its
 * device id, with the access the user has to that panel's controls, as its
 * circuits' refs hold it. A panel whose favorites have no such control, as
 * one that gives the view only sub-devices or metered circuits, has nothing
 * there to forbid, and is left out.
 */
export function favoritesPanelAccess(topology: FavoritesTopology): ReadonlyMap<string, ControlAccess> {
  const panels = new Map<string, ControlAccess>();
  for (const [id, ref] of Object.entries(topology._favoriteRefs)) {
    if (isCircuitRef(ref) && hasControls(topology.circuits[id])) panels.set(ref.panelDeviceId, ref.controlAccess);
  }
  return panels;
}

/** The hint for each reason the integration gives, each said as it is asked for, in the user's language then. */
const HINTS: Readonly<Record<ControlBlock, () => string>> = {
  control_disabled: () => t("controls.disabled"),
  admin_only: () => t("controls.admin_only"),
  read_only: () => t("controls.read_only"),
};

/** Why controls with `access` cannot be operated, in the user's language: its reason's hint, or the generic one; "" where they can. */
export function controlAccessHint(access: ControlAccess): string {
  if (access.mayOperate) return "";
  return access.reason ? HINTS[access.reason]() : t("controls.not_operable");
}

/**
 * A change of a relay or a shedding priority refused, with its message saying
 * why, as each view's report of a failed change shows it
 * (`reportControlFailure`): by the card, which sends nothing where the user may
 * not operate the panel's controls, or by Home Assistant, whose Unauthorized,
 * for a user its permissions do not let control this one entity, says only
 * that in English.
 */
export class ControlChangeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlChangeRefused";
  }
}

/**
 * The changes of a panel's controls the card makes, one method each. Every one
 * is sent through these (`controlWrites`), so none is sent for a user who may
 * not operate the panel's controls. Each resolves once Home Assistant has taken
 * it, and rejects with its refusal: the integration's control gate says why,
 * whether its control lock is armed or the relay was operated a moment ago,
 * and Home Assistant's Unauthorized arrives as a `ControlChangeRefused`.
 */
export interface ControlWrites {
  /** Close (`on`) or open the relay that switch `entityId` operates. */
  setRelay(entityId: string, on: boolean): Promise<void>;
  /** Set the shedding priority that select `entityId` holds to `option`. */
  setPriority(entityId: string, option: string): Promise<void>;
}

/**
 * The changes `hass`'s user can send to controls with `access`. Each is
 * refused, with nothing sent, where the user may not operate them; otherwise
 * it is sent within the call.
 */
export function controlWrites(hass: HomeAssistant, access: ControlAccess): ControlWrites {
  return {
    setRelay: (entityId, on) => sendControl(hass, access, "switch", on ? "turn_on" : "turn_off", entityId, {}),
    setPriority: (entityId, option) => sendControl(hass, access, "select", "select_option", entityId, { option }),
  };
}

async function sendControl(
  hass: HomeAssistant,
  access: ControlAccess,
  domain: "switch" | "select",
  service: string,
  entityId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!access.mayOperate) throw new ControlChangeRefused(controlAccessHint(access));
  try {
    await hass.callWS({ type: "call_service", domain, service, service_data: data, target: { entity_id: entityId } });
  } catch (err: unknown) {
    // The integration lets a user operate the panel who may control some of its circuits' entities; Home Assistant refuses the others.
    throw isUnauthorized(err) ? new ControlChangeRefused(t("controls.entity_unauthorized")) : err;
  }
}

/** The controls a failure is reported for: the error store's key for each, and what it says where nothing says why. */
const FAILURES = {
  relay: { key: "service:relay", fallback: (): string => t("error.relay_failed") },
  priority: { key: "service:shedding", fallback: (): string => t("error.shedding_failed") },
} as const;

/**
 * Show in `errors` that a change of a `control` failed, saying why: the
 * integration's refusal in the user's language, as its control gate gives it
 * (`serviceErrorMessage`), the card's own (`ControlChangeRefused`), else that
 * the change could not be made.
 */
export function reportControlFailure(hass: HomeAssistant, errors: ErrorStore | null, err: unknown, control: keyof typeof FAILURES): void {
  console.warn(`SPAN Panel: ${control} change failed`, err);
  const { key, fallback } = FAILURES[control];
  void serviceErrorMessage(hass, err, INTEGRATION_DOMAIN, fallback()).then(message => {
    errors?.add({ key, level: "error", message, persistent: false });
  });
}

/** Title `control` with why it cannot be operated (`controlAccessHint`), or leave it untitled where it can. */
export function titleControl(control: HTMLElement, access: ControlAccess): void {
  const hint = controlAccessHint(access);
  if (hint) control.title = hint;
  else control.removeAttribute("title");
}

/**
 * The note a view of controls with `access` shows beside them, saying why they
 * cannot be operated; "" where they can. Each stylesheet that draws it places
 * it (`.controls-note`): the card's under the panel's name, or under each
 * panel's name in the Favorites view's stats grid, the side panel's under the
 * section's control.
 */
export function controlNoteHTML(access: ControlAccess): string {
  const hint = controlAccessHint(access);
  if (!hint) return "";
  return `<p class="controls-note" data-role="controls-note" role="note">${escapeHtml(hint)}</p>`;
}
