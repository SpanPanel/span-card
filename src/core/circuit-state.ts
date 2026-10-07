import { RELAY_STATE_CLOSED, SELECTABLE_PRIORITY_KEYS } from "../constants.js";
import { isAlertActive } from "./monitoring-status.js";
import type { Circuit, HomeAssistant, MonitoringPointInfo } from "../types.js";

/**
 * Build the set of state-visualization classes that apply to a circuit's
 * rendered slot. Shared by the breaker grid and the list view's
 * chart-only expanded slot so both render the same border/background
 * signaling.
 */
export function getCircuitStateClasses(_circuit: Circuit, monitoringInfo: MonitoringPointInfo | null, isOn: boolean, isProducer: boolean): string {
  const classes: string[] = [];
  if (!isOn) classes.push("circuit-off");
  if (isProducer) classes.push("circuit-producer");
  if (isAlertActive(monitoringInfo)) classes.push("circuit-alert");
  return classes.join(" ");
}

/**
 * The fields every answer below reads. Structural, so both `Circuit` and the
 * side panel's circuit config satisfy it.
 */
export type CircuitControlFields = Pick<Circuit, "entities" | "is_user_controllable" | "always_on" | "relay_state" | "priority" | "device_type">;

/** Whether a breaker's switch is drawn, and whether it can be operated. */
export type SwitchPresence = "none" | "operable" | "inert";

const SELECTABLE = new Set<string>(SELECTABLE_PRIORITY_KEYS);

const PRIORITY_KEY_BY_WIRE: Readonly<Record<string, string>> = {
  NEVER: "never",
  SOC_THRESHOLD: "soc_threshold",
  OFF_GRID: "off_grid",
};

function switchState(c: CircuitControlFields, hass: HomeAssistant): string | undefined {
  const entityId = c.entities?.switch;
  return entityId ? hass.states[entityId]?.state : undefined;
}

function powerAttribute(c: CircuitControlFields, hass: HomeAssistant, name: string): string | undefined {
  const entityId = c.entities?.power;
  const value = entityId ? hass.states[entityId]?.attributes?.[name] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Whether the breaker's relay is closed: the switch when it reads on or off,
 * else the power sensor's live `relay_state`, else the topology's. An
 * unavailable switch says nothing about the relay, so it is never read as off.
 */
export function relayClosed(c: CircuitControlFields, hass: HomeAssistant): boolean {
  const state = switchState(c, hass);
  if (state === "on" || state === "off") return state === "on";
  return (powerAttribute(c, hass, "relay_state") ?? c.relay_state) === RELAY_STATE_CLOSED;
}

/**
 * `none` unless the circuit has a `switch` role, is user-controllable and the
 * switch has a state object; then `operable` while it reads on or off, and
 * `inert` otherwise. A non-admin's fallback topology guesses a switch for every
 * circuit, and a guess with no state object draws nothing.
 */
export function switchPresence(c: CircuitControlFields, hass: HomeAssistant): SwitchPresence {
  if (!c.entities?.switch || c.is_user_controllable === false) return "none";
  const state = switchState(c, hass);
  if (state === undefined) return "none";
  return state === "on" || state === "off" ? "operable" : "inert";
}

/** Map the panel's wire priority (`NEVER`, `SOC_THRESHOLD`, `OFF_GRID`) to its select option. */
export function priorityKeyFromWire(wire: string | undefined): string | undefined {
  return wire === undefined ? undefined : PRIORITY_KEY_BY_WIRE[wire];
}

function selectState(c: CircuitControlFields, hass: HomeAssistant): string | undefined {
  const entityId = c.entities?.select;
  return entityId ? hass.states[entityId]?.state : undefined;
}

/**
 * The circuit's shed-priority key: `always_on` for an always-on circuit; with a
 * `select` role, the select's state when it is a known option, else the power
 * sensor's live `shed_priority`, else the topology's `priority`; otherwise
 * `unknown`. Without a select the integration offers no priority, so nothing
 * else is consulted.
 */
export function shedPriorityKey(c: CircuitControlFields, hass: HomeAssistant): string {
  if (c.always_on) return "always_on";
  if (!c.entities?.select) return "unknown";
  const state = selectState(c, hass);
  if (state !== undefined && SELECTABLE.has(state)) return state;
  return priorityKeyFromWire(powerAttribute(c, hass, "shed_priority")) ?? priorityKeyFromWire(c.priority) ?? "unknown";
}

/** Whether the circuit's priority select can be operated: it exists and reads a known option. */
export function selectOperable(c: CircuitControlFields, hass: HomeAssistant): boolean {
  const state = selectState(c, hass);
  return state !== undefined && SELECTABLE.has(state);
}
