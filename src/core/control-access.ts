import { INTEGRATION_DOMAIN } from "../constants.js";
import { serviceErrorMessage } from "../helpers/error-text.js";
import { escapeHtml } from "../helpers/sanitize.js";
import { t } from "../i18n.js";
import type { ErrorStore } from "./error-store.js";
import type { ControlAccess, ControlBlock, FavoritesTopology, HomeAssistant, PanelTopology } from "../types.js";

/** Controls the user may operate: what the card takes where the integration says nothing of them. */
export const CONTROLS_OPERABLE: ControlAccess = Object.freeze({ mayOperate: true, reason: null });

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
 * refuses, and the card says why (`reportControlFailure`).
 */
export function controlAccess(topology: PanelTopology | null | undefined): ControlAccess {
  const wire: unknown = topology?.control_access;
  if (typeof wire !== "object" || wire === null || !("may_operate" in wire) || typeof wire.may_operate !== "boolean") return CONTROLS_OPERABLE;
  if (wire.may_operate) return CONTROLS_OPERABLE;
  return { mayOperate: false, reason: "reason" in wire && isBlock(wire.reason) ? wire.reason : null };
}

/** Whether `topology` is the Favorites view's, whose circuits come from several panels (`FavoritesTopology`). */
function isFavoritesTopology(topology: PanelTopology): topology is FavoritesTopology {
  return "_favoriteRefs" in topology;
}

/**
 * Whether the user may operate circuit `circuitId`'s controls in `topology`:
 * its panel's access (`controlAccess`), and in the Favorites view that of the
 * panel the circuit came from, as each panel says its own.
 */
export function circuitControlAccess(topology: PanelTopology | null | undefined, circuitId: string): ControlAccess {
  if (topology && isFavoritesTopology(topology)) return topology._favoriteRefs[circuitId]?.controlAccess ?? CONTROLS_OPERABLE;
  return controlAccess(topology);
}

/**
 * The access a view's "Enable Switches" slider answers for, which arms every
 * switch the view draws: operable where the user may operate the controls of
 * any of its circuits, else why not, as the first of its panels says. A
 * Favorites view of several panels is armed for those the user may operate;
 * each other circuit's switch refuses on its own (`circuitControlAccess`).
 */
export function viewControlAccess(topology: PanelTopology | null | undefined): ControlAccess {
  if (!topology || !isFavoritesTopology(topology)) return controlAccess(topology);
  const circuits = Object.values(topology._favoriteRefs)
    .filter(ref => ref.kind === "circuit")
    .map(ref => ref.controlAccess ?? CONTROLS_OPERABLE);
  if (circuits.length === 0 || circuits.some(access => access.mayOperate)) return CONTROLS_OPERABLE;
  return circuits[0] ?? CONTROLS_OPERABLE;
}

/** The hint for each reason the integration gives. */
const HINT_KEYS: Readonly<Record<ControlBlock, string>> = {
  control_disabled: "controls.disabled",
  admin_only: "controls.admin_only",
  read_only: "controls.read_only",
};

/** Why controls with `access` cannot be operated, in the user's language: its reason's hint, or the generic one; "" where they can. */
export function controlAccessHint(access: ControlAccess): string {
  if (access.mayOperate) return "";
  return t(access.reason ? HINT_KEYS[access.reason] : "controls.not_operable");
}

/**
 * A change of a relay or a shedding priority the card sends nothing for: the
 * user may not operate the panel's controls (`ControlAccess`), or the card has
 * no Home Assistant yet to send it to. Its message says why, as each view's
 * report of a failed change shows it (`reportControlFailure`).
 */
export class ControlChangeRefused extends Error {
  constructor(access: ControlAccess) {
    super(controlAccessHint(access) || t("controls.not_operable"));
    this.name = "ControlChangeRefused";
  }
}

/**
 * The changes of a panel's controls the card makes, one method each. Every one
 * is sent through these (`controlWrites`), so none is sent for a user who may
 * not operate the panel's controls. Each resolves once Home Assistant has taken
 * it, and rejects with its refusal: the integration's control gate says why,
 * whether only an administrator may operate the panel, its control lock is
 * armed, or the relay was operated a moment ago.
 */
export interface ControlWrites {
  /** Close (`on`) or open the relay that switch `entityId` operates. */
  setRelay(entityId: string, on: boolean): Promise<void>;
  /** Set the shedding priority that select `entityId` holds to `option`. */
  setPriority(entityId: string, option: string): Promise<void>;
}

/**
 * The changes `hass`'s user can send to controls with `access`. Each is
 * refused, with nothing sent, where the user may not operate them, as where
 * there is no Home Assistant yet; otherwise it is sent within the call.
 */
export function controlWrites(hass: HomeAssistant | null, access: ControlAccess): ControlWrites {
  return {
    setRelay: (entityId, on) => sendControl(hass, access, "switch", on ? "turn_on" : "turn_off", entityId, {}),
    setPriority: (entityId, option) => sendControl(hass, access, "select", "select_option", entityId, { option }),
  };
}

async function sendControl(
  hass: HomeAssistant | null,
  access: ControlAccess,
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!hass || !access.mayOperate) throw new ControlChangeRefused(access);
  await hass.callWS({ type: "call_service", domain, service, service_data: data, target: { entity_id: entityId } });
}

/** The controls a failure is reported for: the error store's key for each, and what it says where nothing says why. */
const FAILURES = {
  relay: { key: "service:relay", fallback: (): string => t("error.relay_failed") },
  priority: { key: "service:shedding", fallback: (): string => t("error.shedding_failed") },
} as const;

/**
 * Show in `errors` that a change of a `control` failed, saying why: the
 * integration's refusal in the user's language, as its control gate gives it
 * (`serviceErrorMessage`), the card's own where it sent nothing
 * (`ControlChangeRefused`), else that the change could not be made.
 */
export function reportControlFailure(hass: HomeAssistant | null, errors: ErrorStore | null, err: unknown, control: keyof typeof FAILURES): void {
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
 * it (`.controls-note`): the card's under the panel's name or beside the
 * Favorites slider, the side panel's under the section's control.
 */
export function controlNoteHTML(access: ControlAccess): string {
  const hint = controlAccessHint(access);
  if (!hint) return "";
  return `<p class="controls-note" data-role="controls-note" role="note">${escapeHtml(hint)}</p>`;
}
