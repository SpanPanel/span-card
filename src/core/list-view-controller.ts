import { RELAY_STATE_CLOSED } from "../constants.js";
import { formatPowerSigned, formatPowerUnit } from "../helpers/format.js";
import { getChartMetric } from "../helpers/chart.js";
import { t } from "../i18n.js";
import { getCircuitMonitoringInfo } from "./monitoring-status.js";
import { buildSearchBarHTML, buildListRowHTML, buildExpandedCircuitHTML, buildAreaHeaderHTML } from "./list-renderer.js";
import type { DashboardController } from "./dashboard-controller.js";
import type { HomeAssistant, PanelTopology, CardConfig, Circuit, MonitoringStatus } from "../types.js";

interface SpanSidePanelElement extends HTMLElement {
  hass: HomeAssistant;
}

interface CircuitSortInfo {
  isOn: boolean;
  value: number;
}

function getCircuitSortInfo(circuit: Circuit, hass: HomeAssistant, config: CardConfig): CircuitSortInfo {
  const switchEntityId = circuit.entities?.switch;
  const switchState = switchEntityId ? hass.states[switchEntityId] : null;
  const powerEid = circuit.entities?.power;
  const powerState = powerEid ? hass.states[powerEid] : null;
  const isOn = switchState
    ? switchState.state === "on"
    : ((powerState?.attributes?.relay_state as string | undefined) || circuit.relay_state) === RELAY_STATE_CLOSED;

  const isCurrentMode = (config.chart_metric || "power") === "current";
  let value: number;
  if (isCurrentMode) {
    const currentEid = circuit.entities?.current;
    const currentState = currentEid ? hass.states[currentEid] : null;
    value = currentState ? Math.abs(parseFloat(currentState.state) || 0) : 0;
  } else {
    value = powerState ? Math.abs(parseFloat(powerState.state) || 0) : 0;
  }
  return { isOn, value };
}

function getSheddingPriority(circuit: Circuit, hass: HomeAssistant): string {
  if (circuit.always_on) return "always_on";
  const selectEid = circuit.entities?.select;
  const selectState = selectEid ? hass.states[selectEid] : null;
  return selectState ? selectState.state : "unknown";
}

function compareCircuits(a: Circuit, b: Circuit, hass: HomeAssistant, config: CardConfig): number {
  const infoA = getCircuitSortInfo(a, hass, config);
  const infoB = getCircuitSortInfo(b, hass, config);
  if (infoA.isOn && !infoB.isOn) return -1;
  if (!infoA.isOn && infoB.isOn) return 1;
  return infoB.value - infoA.value;
}

function sortCircuitEntries(entries: [string, Circuit][], hass: HomeAssistant, config: CardConfig): [string, Circuit][] {
  return entries.sort((a, b) => compareCircuits(a[1], b[1], hass, config));
}

interface RowUnit {
  row: HTMLElement;
  expanded: HTMLElement | null;
  uuid: string;
  circuit: Circuit;
}

interface RowGroup {
  anchor: HTMLElement | null;
  units: RowUnit[];
}

// Partition .list-view's direct children into groups. Activity view produces a
// single anchor-less group; area view produces one group per .area-header.
function partitionRowGroups(listView: HTMLElement, topology: PanelTopology): RowGroup[] {
  let current: RowGroup = { anchor: null, units: [] };
  const groups: RowGroup[] = [current];
  const children = [...listView.children] as HTMLElement[];

  for (let i = 0; i < children.length; ) {
    const el = children[i]!;
    if (el.classList.contains("area-header")) {
      current = { anchor: el, units: [] };
      groups.push(current);
      i++;
      continue;
    }
    if (el.classList.contains("list-row")) {
      const uuid = el.dataset.rowUuid;
      const circuit = uuid ? topology.circuits[uuid] : undefined;
      if (uuid && circuit) {
        const next = children[i + 1];
        const expanded = next && next.classList.contains("list-expanded-content") && next.dataset.expandedUuid === uuid ? next : null;
        current.units.push({ row: el, expanded, uuid, circuit });
        i += expanded ? 2 : 1;
        continue;
      }
    }
    i++;
  }

  return groups;
}

function reorderListRows(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology, config: CardConfig): void {
  const listView = root.querySelector<HTMLElement>(".list-view");
  if (!listView) return;

  for (const group of partitionRowGroups(listView, topology)) {
    if (group.units.length < 2) continue;

    const sorted = [...group.units].sort((a, b) => compareCircuits(a.circuit, b.circuit, hass, config));

    const changed = sorted.some((unit, j) => unit.uuid !== group.units[j]!.uuid);
    if (!changed) continue;

    let after: Element | null = group.anchor;
    for (const unit of sorted) {
      if (after) {
        after.after(unit.row);
      } else {
        listView.prepend(unit.row);
      }
      after = unit.row;
      if (unit.expanded) {
        after.after(unit.expanded);
        after = unit.expanded;
      }
    }
  }
}

function getCircuitEntityId(circuit: Circuit): string {
  return circuit.entities?.current ?? circuit.entities?.power ?? "";
}

export const FAVORITES_VIEW_STATE_CHANGED_EVENT = "favorites-view-state-changed";

export interface FavoritesViewStateDetail {
  view: "activity" | "area";
  expanded: string[];
  searchQuery: string;
}

export class ListViewController {
  private _ctrl: DashboardController;
  private _expandedUuids = new Set<string>();
  private _searchQuery = "";
  private _container: HTMLElement | null = null;
  private _clickHandler: ((ev: Event) => void) | null = null;
  private _inputHandler: ((ev: Event) => void) | null = null;
  private _graphSettingsHandler: ((ev: Event) => void) | null = null;

  // Store these for expand/collapse toggling
  private _hass: HomeAssistant | null = null;
  private _topology: PanelTopology | null = null;
  private _config: CardConfig | null = null;
  private _monitoringStatus: MonitoringStatus | null = null;

  /**
   * When set to ``"activity"`` or ``"area"``, expansion and search-box
   * mutations dispatch ``favorites-view-state-changed`` so span-panel.ts
   * can persist the Favorites pseudo-panel's view state to localStorage.
   * ``null`` (the default) disables persistence for real-panel renders.
   */
  private _viewName: "activity" | "area" | null = null;

  constructor(ctrl: DashboardController) {
    this._ctrl = ctrl;
  }

  /**
   * Seed the expansion set before the next render. Called by
   * ``span-panel.ts`` when re-entering the Favorites view so the user's
   * previously expanded rows come back.
   */
  setInitialExpansion(ids: Iterable<string>): void {
    this._expandedUuids = new Set(ids);
  }

  /** Seed the search query before the next render. */
  setInitialSearchQuery(query: string): void {
    this._searchQuery = query;
  }

  /**
   * Mark the upcoming render as belonging to a Favorites-view tab so
   * that expansion/search state persists across dropdown switches.
   */
  setViewName(viewName: "activity" | "area" | null): void {
    this._viewName = viewName;
  }

  renderActivityView(
    container: HTMLElement,
    hass: HomeAssistant,
    topology: PanelTopology,
    config: CardConfig,
    monitoringStatus: MonitoringStatus | null,
    headerHTML: string
  ): void {
    this._unbindEvents();
    this._hass = hass;
    this._topology = topology;
    this._config = config;
    this._monitoringStatus = monitoringStatus;

    const entries: [string, Circuit][] = Object.entries(topology.circuits);
    const sorted = sortCircuitEntries(entries, hass, config);

    let html = headerHTML + buildSearchBarHTML(this._searchQuery);
    html += '<div class="list-view">';

    for (const [uuid, circuit] of sorted) {
      const monitoringInfo = getCircuitMonitoringInfo(monitoringStatus, getCircuitEntityId(circuit));
      const sheddingPriority = getSheddingPriority(circuit, hass);
      const isExpanded = this._expandedUuids.has(uuid);
      html += buildListRowHTML(uuid, circuit, hass, config, monitoringInfo, sheddingPriority, isExpanded);
      if (isExpanded) {
        html += buildExpandedCircuitHTML(uuid, circuit, hass, config, monitoringInfo, sheddingPriority);
      }
    }

    html += "</div>";
    html += "<span-side-panel></span-side-panel>";
    container.innerHTML = html;
    const sidePanel = container.querySelector("span-side-panel") as SpanSidePanelElement | null;
    if (sidePanel) sidePanel.hass = hass;
    this._bindEvents(container);
    if (this._searchQuery) this._applyFilter(container);
    this._ctrl.updateDOM(container);
  }

  renderAreaView(
    container: HTMLElement,
    hass: HomeAssistant,
    topology: PanelTopology,
    config: CardConfig,
    monitoringStatus: MonitoringStatus | null,
    headerHTML: string
  ): void {
    this._unbindEvents();
    this._hass = hass;
    this._topology = topology;
    this._config = config;
    this._monitoringStatus = monitoringStatus;

    const unassignedLabel = t("list.unassigned_area");

    // Group circuits by area
    const areaGroups = new Map<string, [string, Circuit][]>();
    for (const [uuid, circuit] of Object.entries(topology.circuits)) {
      const area = circuit.area ?? unassignedLabel;
      const group = areaGroups.get(area);
      if (group) {
        group.push([uuid, circuit]);
      } else {
        areaGroups.set(area, [[uuid, circuit]]);
      }
    }

    // Sort area names alphabetically, with unassigned last
    const areaNames = [...areaGroups.keys()].sort((a, b) => {
      if (a === unassignedLabel) return 1;
      if (b === unassignedLabel) return -1;
      return a.localeCompare(b);
    });

    let html = headerHTML + buildSearchBarHTML(this._searchQuery);
    html += '<div class="list-view">';

    for (const areaName of areaNames) {
      const group = areaGroups.get(areaName);
      if (!group) continue;

      const sorted = sortCircuitEntries(group, hass, config);
      html += buildAreaHeaderHTML(areaName);

      for (const [uuid, circuit] of sorted) {
        const monitoringInfo = getCircuitMonitoringInfo(monitoringStatus, getCircuitEntityId(circuit));
        const sheddingPriority = getSheddingPriority(circuit, hass);
        const isExpanded = this._expandedUuids.has(uuid);
        html += buildListRowHTML(uuid, circuit, hass, config, monitoringInfo, sheddingPriority, isExpanded);
        if (isExpanded) {
          html += buildExpandedCircuitHTML(uuid, circuit, hass, config, monitoringInfo, sheddingPriority);
        }
      }
    }

    html += "</div>";
    html += "<span-side-panel></span-side-panel>";
    container.innerHTML = html;
    const areaSidePanel = container.querySelector("span-side-panel") as SpanSidePanelElement | null;
    if (areaSidePanel) areaSidePanel.hass = hass;
    this._bindEvents(container);
    if (this._searchQuery) this._applyFilter(container);
    this._ctrl.updateDOM(container);
  }

  updateCollapsedRows(root: Element | ShadowRoot, hass: HomeAssistant, topology: PanelTopology, config: CardConfig): void {
    const chartMetric = getChartMetric(config);
    const isCurrentMode = chartMetric.entityRole === "current";

    const rows = root.querySelectorAll<HTMLElement>(".list-row[data-row-uuid]");
    for (const row of rows) {
      const uuid = row.dataset.rowUuid;
      if (!uuid) continue;

      const circuit = topology.circuits[uuid];
      if (!circuit) continue;

      const { isOn, value } = getCircuitSortInfo(circuit, hass, config);

      // Update power/current value
      const powerValueEl = row.querySelector(".list-power-value");
      if (powerValueEl) {
        if (!isOn) {
          powerValueEl.innerHTML = "";
        } else if (isCurrentMode) {
          powerValueEl.innerHTML = `<strong>${chartMetric.format(value)}</strong><span class="power-unit">A</span>`;
        } else {
          const powerEid = circuit.entities?.power;
          const powerState = powerEid ? hass.states[powerEid] : null;
          const powerW = powerState ? parseFloat(powerState.state) || 0 : 0;
          powerValueEl.innerHTML = `<strong>${formatPowerSigned(powerW)}</strong><span class="power-unit">${formatPowerUnit(powerW)}</span>`;
        }
      }

      // Update status badge
      const statusBadge = row.querySelector(".list-status-badge") as HTMLElement | null;
      if (statusBadge) {
        statusBadge.textContent = isOn ? "ON" : "OFF";
        statusBadge.classList.toggle("list-status-on", isOn);
        statusBadge.classList.toggle("list-status-off", !isOn);
      }

      // Toggle circuit-off class
      row.classList.toggle("circuit-off", !isOn);
    }

    reorderListRows(root, hass, topology, config);
  }

  stop(): void {
    this._unbindEvents();
    // Only reset user-visible view state for real-panel renders. In the
    // Favorites view we preserve expansion/search across re-renders so
    // switching tabs or reloading the page restores the user's layout.
    if (this._viewName === null) {
      this._expandedUuids.clear();
      this._searchQuery = "";
    }
    this._hass = null;
    this._topology = null;
    this._config = null;
    this._monitoringStatus = null;
  }

  private _dispatchFavoritesViewState(): void {
    if (!this._viewName || !this._container) return;
    const detail: FavoritesViewStateDetail = {
      view: this._viewName,
      expanded: [...this._expandedUuids],
      searchQuery: this._searchQuery,
    };
    this._container.dispatchEvent(
      new CustomEvent<FavoritesViewStateDetail>(FAVORITES_VIEW_STATE_CHANGED_EVENT, {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  private _bindEvents(container: HTMLElement): void {
    this._container = container;

    this._clickHandler = (ev: Event): void => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;

      // Handle expand/collapse toggle
      const expandToggle = target.closest(".list-expand-toggle") as HTMLElement | null;
      if (expandToggle) {
        const uuid = expandToggle.dataset.expandUuid;
        if (uuid) {
          this._toggleExpand(uuid);
        }
        return;
      }

      // Handle gear icon clicks (delegate to DashboardController for side panel)
      const gearBtn = target.closest(".gear-icon") as HTMLElement | null;
      if (gearBtn) {
        this._ctrl.onGearClick(ev, container);
        return;
      }

      // Handle toggle pill clicks (delegate to DashboardController for switch control)
      const togglePill = target.closest(".toggle-pill");
      if (togglePill) {
        this._ctrl.onToggleClick(ev, container);
        return;
      }

      // Handle search clear button
      const clearBtn = target.closest(".list-search-clear") as HTMLElement | null;
      if (clearBtn) {
        const searchInput = container.querySelector<HTMLInputElement>(".list-search");
        if (searchInput) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }

      // Handle unit toggle button
      const unitBtn = target.closest(".unit-btn") as HTMLElement | null;
      if (unitBtn) {
        const unit = unitBtn.dataset.unit;
        if (unit) {
          container.dispatchEvent(
            new CustomEvent("unit-changed", {
              detail: unit,
              bubbles: true,
              composed: true,
            })
          );
        }
      }
    };

    this._inputHandler = (ev: Event): void => {
      const input = ev.target as HTMLInputElement | null;
      if (!input || !input.classList.contains("list-search")) return;

      this._searchQuery = input.value.toLowerCase();
      this._applyFilter(container);
      this._dispatchFavoritesViewState();
    };

    this._graphSettingsHandler = (): void => {
      this._ctrl
        .onGraphSettingsChanged(container)
        .then(() => {
          this._ctrl.updateDOM(container);
        })
        .catch(() => {});
    };

    container.addEventListener("click", this._clickHandler);
    container.addEventListener("input", this._inputHandler);
    container.addEventListener("graph-settings-changed", this._graphSettingsHandler);
  }

  private _unbindEvents(): void {
    if (this._container) {
      if (this._clickHandler) {
        this._container.removeEventListener("click", this._clickHandler);
      }
      if (this._inputHandler) {
        this._container.removeEventListener("input", this._inputHandler);
      }
      if (this._graphSettingsHandler) {
        this._container.removeEventListener("graph-settings-changed", this._graphSettingsHandler);
      }
    }
    this._container = null;
    this._clickHandler = null;
    this._inputHandler = null;
    this._graphSettingsHandler = null;
  }

  private _applyFilter(container: HTMLElement): void {
    const clearBtn = container.querySelector<HTMLElement>(".list-search-clear");
    if (clearBtn) clearBtn.style.display = this._searchQuery ? "" : "none";

    const rows = container.querySelectorAll<HTMLElement>(".list-row[data-row-uuid]");
    for (const row of rows) {
      const nameEl = row.querySelector(".list-circuit-name");
      const name = nameEl?.textContent?.toLowerCase() ?? "";
      const matches = name.includes(this._searchQuery);

      row.style.display = matches ? "" : "none";

      const uuid = row.dataset.rowUuid;
      if (uuid) {
        const expandedContent = container.querySelector<HTMLElement>(`.list-expanded-content[data-expanded-uuid="${uuid}"]`);
        if (expandedContent) {
          expandedContent.style.display = matches ? "" : "none";
        }
      }
    }

    const areaHeaders = container.querySelectorAll<HTMLElement>(".area-header");
    for (const header of areaHeaders) {
      let hasVisibleRow = false;
      let sibling = header.nextElementSibling;
      while (sibling && !sibling.classList.contains("area-header")) {
        if (sibling.classList.contains("list-row") && (sibling as HTMLElement).style.display !== "none") {
          hasVisibleRow = true;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      header.style.display = hasVisibleRow ? "" : "none";
    }
  }

  private _toggleExpand(uuid: string): void {
    if (!this._container || !this._hass || !this._topology || !this._config) return;

    const row = this._container.querySelector<HTMLElement>(`.list-row[data-row-uuid="${uuid}"]`);
    const chevron = this._container.querySelector<HTMLElement>(`.list-expand-toggle[data-expand-uuid="${uuid}"]`);
    if (!row) return;

    if (this._expandedUuids.has(uuid)) {
      // Collapse
      this._expandedUuids.delete(uuid);
      const expandedContent = this._container.querySelector(`.list-expanded-content[data-expanded-uuid="${uuid}"]`);
      if (expandedContent) {
        expandedContent.remove();
      }
      if (chevron) chevron.classList.remove("expanded");
      row.classList.remove("list-row-expanded");
    } else {
      // Expand
      this._expandedUuids.add(uuid);

      const circuit = this._topology.circuits[uuid];
      if (!circuit) return;

      const monitoringInfo = getCircuitMonitoringInfo(this._monitoringStatus, getCircuitEntityId(circuit));
      const sheddingPriority = getSheddingPriority(circuit, this._hass);
      const html = buildExpandedCircuitHTML(uuid, circuit, this._hass, this._config, monitoringInfo, sheddingPriority);

      row.insertAdjacentHTML("afterend", html);
      if (chevron) chevron.classList.add("expanded");
      row.classList.add("list-row-expanded");
      this._ctrl.updateDOM(this._container);
    }

    this._dispatchFavoritesViewState();
  }
}
