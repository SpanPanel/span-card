import { SHEDDING_PRIORITIES } from "../constants.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../helpers/sanitize.js";
import type { SwitchPresence } from "./circuit-state.js";
import type { SheddingPriorityDef } from "../types.js";

/**
 * A breaker's two control markers, built and updated in one place so the grid,
 * the list and the live updater cannot drift.
 */

/** The pill for a breaker's switch: none without one, dimmed and inert while it is unavailable. */
export function buildTogglePillHTML(isOn: boolean, presence: SwitchPresence): string {
  if (presence === "none") return "";
  const classes = ["toggle-pill", isOn ? "toggle-on" : "toggle-off"];
  if (presence === "inert") classes.push("toggle-unavailable");
  return `<div class="${classes.join(" ")}">
    <span class="toggle-label">${isOn ? t("grid.on") : t("grid.off")}</span>
    <span class="toggle-knob"></span>
  </div>`;
}

/** Bring a rendered pill up to date; a scope without one is left alone. */
export function applyTogglePill(scope: ParentNode, isOn: boolean, presence: SwitchPresence): void {
  const pill = scope.querySelector<HTMLElement>(".toggle-pill");
  if (!pill) return;
  pill.classList.toggle("toggle-on", isOn);
  pill.classList.toggle("toggle-off", !isOn);
  pill.classList.toggle("toggle-unavailable", presence !== "operable");
  const label = pill.querySelector(".toggle-label");
  if (label) label.textContent = isOn ? t("grid.on") : t("grid.off");
}

/** The defined priority for a key, or undefined for `unknown` and anything unlisted. */
function sheddingDef(key: string): SheddingPriorityDef | undefined {
  return key === "unknown" ? undefined : SHEDDING_PRIORITIES[key];
}

const HIDDEN = "display:none;";

/**
 * The shedding marker, always emitted so a live update can show it once the
 * priority is known. Hidden, with no icon, while it is unknown -- an unavailable
 * select is not a question mark.
 */
export function buildSheddingIconHTML(key: string): string {
  const def = sheddingDef(key);
  const color = def ? escapeHtml(def.color) : "";
  const title = def ? ` title="${escapeHtml(def.label())}"` : "";
  const icon = def ? escapeHtml(def.icon) : "";
  const icon2 = def?.icon2 ? escapeHtml(def.icon2) : "";
  const text = def?.textLabel ? escapeHtml(def.textLabel) : "";
  return `<span class="shedding-composite"${title} style="${def ? "" : HIDDEN}">
    <span-icon class="shedding-icon" icon="${icon}" style="color:${color};--mdc-icon-size:16px;"></span-icon>
    <span-icon class="shedding-icon-secondary" icon="${icon2}" style="color:${color};--mdc-icon-size:14px;${icon2 ? "" : HIDDEN}"></span-icon>
    <span class="shedding-label" style="color:${color};${text ? "" : HIDDEN}">${text}</span>
  </span>`;
}

/** Bring a rendered shedding marker up to date: shown for a known priority, hidden for unknown. */
export function applySheddingIcon(scope: ParentNode, key: string): void {
  const marker = scope.querySelector<HTMLElement>(".shedding-composite");
  if (!marker) return;
  const def = sheddingDef(key);
  marker.style.display = def ? "" : "none";
  marker.title = def ? def.label() : "";
  const color = def?.color ?? "";
  const icon = marker.querySelector<HTMLElement>(".shedding-icon");
  if (icon) {
    icon.setAttribute("icon", def?.icon ?? "");
    icon.style.color = color;
  }
  const secondary = marker.querySelector<HTMLElement>(".shedding-icon-secondary");
  if (secondary) {
    secondary.setAttribute("icon", def?.icon2 ?? "");
    secondary.style.color = color;
    secondary.style.display = def?.icon2 ? "" : "none";
  }
  const label = marker.querySelector<HTMLElement>(".shedding-label");
  if (label) {
    label.textContent = def?.textLabel ?? "";
    label.style.color = color;
    label.style.display = def?.textLabel ? "" : "none";
  }
}
