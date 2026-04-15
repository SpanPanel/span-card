import { DEFAULT_GRAPH_HORIZON, GRAPH_HORIZONS, INTEGRATION_DOMAIN, LIVE_SAMPLE_INTERVAL_MS } from "../constants.js";
import { getCircuitChartEntity } from "../helpers/chart.js";
import { getHorizonDurationMs, getMaxHistoryPoints, getMinGapMs, recordSample } from "../helpers/history.js";
import { loadHistory, collectSubDeviceEntityIds } from "./history-loader.js";
import { updateCircuitDOM, updateSubDeviceDOM } from "./dom-updater.js";
import { getEffectiveHorizon, getEffectiveSubDeviceHorizon } from "./graph-settings.js";
import { MonitoringStatusCache } from "./monitoring-status.js";
import { GraphSettingsCache } from "./graph-settings.js";
import type { CardConfig, FavoriteRef, GraphSettings, HistoryMap, HomeAssistant, MonitoringStatus, MonitoringStatusResponse, PanelTopology } from "../types.js";

const RECORDER_REFRESH_MS = 30_000;
const RESIZE_THRESHOLD_PX = 5;
const RESIZE_DEBOUNCE_MS = 150;
const SLIDE_THRESHOLD = 0.9;

type DOMRoot = Element | ShadowRoot;

interface SpanSidePanelElement extends HTMLElement {
  hass: HomeAssistant;
  open(config: Record<string, unknown>): void;
}

/**
 * Shared controller encapsulating dashboard behavior used by both
 * the Lovelace card (SpanPanelCard) and the integration panel (DashboardTab).
 */
export class DashboardController {
  readonly powerHistory: HistoryMap = new Map();
  readonly horizonMap: Map<string, string> = new Map();
  readonly subDeviceHorizonMap: Map<string, string> = new Map();
  readonly monitoringCache = new MonitoringStatusCache();
  readonly graphSettingsCache = new GraphSettingsCache();

  private _hass: HomeAssistant | null = null;
  private _topology: PanelTopology | null = null;
  private _config: CardConfig | null = null;
  private _configEntryId: string | null = null;

  /**
   * Set when rendering the Favorites pseudo-panel. Composite circuit
   * ids (``"{panelDeviceId}|{circuitUuid}"``) resolve through this map
   * to the originating panel so side-panel edits target the correct
   * config entry. ``null`` means normal single-panel mode.
   */
  private _favRefs: Record<string, FavoriteRef> | null = null;

  /**
   * Context used when opening the panel-mode side panel (Graph Settings)
   * on a single real panel: the panel's HA device id plus the subsets
   * of circuit uuids and sub-device HA device ids the user has favorited.
   * Populated by the dashboard wrapper before tab renders.
   */
  private _panelFavorites: {
    panelDeviceId: string;
    circuitUuids: Set<string>;
    subDeviceIds: Set<string>;
  } | null = null;

  private _showMonitoring = false;
  private _updateInterval: ReturnType<typeof setInterval> | null = null;
  private _recorderRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _lastWidth = 0;
  private _resizeDebounce: ReturnType<typeof setTimeout> | null = null;

  get hass(): HomeAssistant | null {
    return this._hass;
  }

  set hass(val: HomeAssistant | null) {
    this._hass = val;
  }

  get topology(): PanelTopology | null {
    return this._topology;
  }

  get config(): CardConfig | null {
    return this._config;
  }

  set showMonitoring(val: boolean) {
    this._showMonitoring = val;
  }

  init(topology: PanelTopology | null, config: CardConfig, hass: HomeAssistant | null, configEntryId: string | null): void {
    this._topology = topology;
    this._config = config;
    this._hass = hass;
    this._configEntryId = configEntryId;
  }

  /**
   * Enter Favorites-view mode. ``refs`` maps the composite circuit ids
   * present in the merged topology to their originating panel + circuit
   * uuid + config entry. ``favoriteIds`` is the subset currently marked
   * (effectively the keys of ``refs`` for this view, kept as a Set for
   * fast heart-state lookups in panel-mode).
   */
  setFavoriteRefs(refs: Record<string, FavoriteRef>): void {
    this._favRefs = refs;
  }

  clearFavoriteRefs(): void {
    this._favRefs = null;
  }

  /**
   * Provide the current panel's favorited circuit uuids and sub-device
   * ids. Used only when opening the panel-mode (Graph Settings) side
   * panel so its per-target list can render filled/outlined heart
   * toggles. Pass ``null`` to disable hearts (e.g. standalone card).
   */
  setPanelFavorites(
    info: {
      panelDeviceId: string;
      circuitUuids: Set<string>;
      subDeviceIds: Set<string>;
    } | null
  ): void {
    this._panelFavorites = info;
  }

  private get _inFavoritesView(): boolean {
    return this._favRefs !== null;
  }

  setConfig(config: CardConfig): void {
    this._config = config;
  }

  buildHorizonMaps(settings: GraphSettings | null): void {
    this.horizonMap.clear();
    this.subDeviceHorizonMap.clear();
    if (settings && this._topology?.circuits) {
      for (const uuid of Object.keys(this._topology.circuits)) {
        this.horizonMap.set(uuid, getEffectiveHorizon(settings, uuid));
      }
    }
    if (settings && this._topology?.sub_devices) {
      for (const devId of Object.keys(this._topology.sub_devices)) {
        this.subDeviceHorizonMap.set(devId, getEffectiveSubDeviceHorizon(settings, devId));
      }
    }
  }

  async fetchAndBuildHorizonMaps(): Promise<void> {
    try {
      if (this._favRefs) {
        await this._buildFavoritesHorizonMaps();
      } else {
        await this.graphSettingsCache.fetch(this._hass!, this._configEntryId);
        this.buildHorizonMaps(this.graphSettingsCache.settings);
      }
    } catch {
      // Graph settings unavailable -- use defaults
    }
  }

  /**
   * Build horizon maps for the Favorites pseudo-panel by fetching graph
   * settings per contributing config entry in parallel, then routing
   * each composite circuit/sub-device id through its ``FavoriteRef`` to
   * the originating entry's settings. Without this, every favorited
   * target would incorrectly resolve against the primary entry's
   * settings, masking per-target overrides on non-primary panels.
   */
  private async _buildFavoritesHorizonMaps(): Promise<void> {
    if (!this._hass || !this._favRefs || !this._topology) return;
    const entryIds = new Set<string>();
    for (const ref of Object.values(this._favRefs)) {
      if (ref.configEntryId) entryIds.add(ref.configEntryId);
    }
    const settingsByEntry = new Map<string, GraphSettings | null>();
    await Promise.all(
      Array.from(entryIds).map(async eid => {
        settingsByEntry.set(eid, await this._fetchGraphSettingsFresh(eid));
      })
    );
    this.horizonMap.clear();
    this.subDeviceHorizonMap.clear();
    for (const compositeId of Object.keys(this._topology.circuits)) {
      const ref = this._favRefs[compositeId];
      const settings = ref?.configEntryId ? (settingsByEntry.get(ref.configEntryId) ?? null) : null;
      const realId = ref?.targetId ?? compositeId;
      this.horizonMap.set(compositeId, getEffectiveHorizon(settings, realId));
    }
    if (this._topology.sub_devices) {
      for (const compositeId of Object.keys(this._topology.sub_devices)) {
        const ref = this._favRefs[compositeId];
        const settings = ref?.configEntryId ? (settingsByEntry.get(ref.configEntryId) ?? null) : null;
        const realId = ref?.targetId ?? compositeId;
        this.subDeviceHorizonMap.set(compositeId, getEffectiveSubDeviceHorizon(settings, realId));
      }
    }
  }

  async loadHistory(): Promise<void> {
    await loadHistory(this._hass!, this._topology!, this._config!, this.powerHistory, this.horizonMap, this.subDeviceHorizonMap);
  }

  recordSamples(): void {
    if (!this._topology || !this._hass || !this._config) return;
    const now = Date.now();

    for (const [uuid, circuit] of Object.entries(this._topology.circuits)) {
      const horizon = this.horizonMap.get(uuid) ?? DEFAULT_GRAPH_HORIZON;
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) continue;

      const entityId = getCircuitChartEntity(circuit, this._config);
      if (!entityId) continue;
      const state = this._hass.states[entityId];
      if (!state) continue;
      const val = parseFloat(state.state);
      if (isNaN(val)) continue;

      const durationMs = getHorizonDurationMs(horizon);
      const maxPoints = getMaxHistoryPoints(durationMs);
      const minGap = getMinGapMs(durationMs);
      const cutoff = now - durationMs;

      const hist = this.powerHistory.get(uuid) ?? [];
      if (hist.length > 0 && now - hist[hist.length - 1]!.time < minGap) continue;

      recordSample(this.powerHistory, uuid, val, now, cutoff, maxPoints);
    }

    for (const { entityId, key, devId } of collectSubDeviceEntityIds(this._topology)) {
      const horizon = this.subDeviceHorizonMap.get(devId) ?? DEFAULT_GRAPH_HORIZON;
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) continue;

      const state = this._hass.states[entityId];
      if (!state) continue;
      const val = parseFloat(state.state);
      if (isNaN(val)) continue;

      const durationMs = getHorizonDurationMs(horizon);
      const maxPoints = getMaxHistoryPoints(durationMs);
      const minGap = getMinGapMs(durationMs);
      const cutoff = now - durationMs;

      const hist = this.powerHistory.get(key) ?? [];
      if (hist.length > 0 && now - hist[hist.length - 1]!.time < minGap) continue;

      recordSample(this.powerHistory, key, val, now, cutoff, maxPoints);
    }
  }

  async refreshRecorderData(root: DOMRoot): Promise<void> {
    if (!this._topology || !this._hass || !this._config) return;

    const nonRealtimeMap = new Map<string, string>();
    for (const [uuid, horizon] of this.horizonMap) {
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) {
        nonRealtimeMap.set(uuid, horizon);
      }
    }

    const nonRealtimeSubDeviceMap = new Map<string, string>();
    for (const [devId, horizon] of this.subDeviceHorizonMap) {
      if (!GRAPH_HORIZONS[horizon]?.useRealtime) {
        nonRealtimeSubDeviceMap.set(devId, horizon);
      }
    }

    if (nonRealtimeMap.size === 0 && nonRealtimeSubDeviceMap.size === 0) return;

    const nonRealtimeSubDeviceKeys = new Set<string>();
    if (nonRealtimeSubDeviceMap.size > 0 && this._topology) {
      for (const { key, devId } of collectSubDeviceEntityIds(this._topology)) {
        if (nonRealtimeSubDeviceMap.has(devId)) {
          nonRealtimeSubDeviceKeys.add(key);
        }
      }
    }

    const freshHistory: HistoryMap = new Map();
    try {
      await loadHistory(this._hass, this._topology, this._config, freshHistory, nonRealtimeMap, nonRealtimeSubDeviceMap);
      for (const uuid of nonRealtimeMap.keys()) {
        const data = freshHistory.get(uuid);
        if (data) {
          this.powerHistory.set(uuid, data);
        } else {
          this.powerHistory.delete(uuid);
        }
      }
      for (const key of nonRealtimeSubDeviceKeys) {
        const data = freshHistory.get(key);
        if (data) {
          this.powerHistory.set(key, data);
        } else {
          this.powerHistory.delete(key);
        }
      }
      this.updateDOM(root);
    } catch {
      // Will refresh on next interval
    }
  }

  updateDOM(root: DOMRoot): void {
    if (!this._hass || !this._topology || !this._config) return;
    updateCircuitDOM(root, this._hass, this._topology, this._config, this.powerHistory, this.horizonMap);
    updateSubDeviceDOM(root, this._hass, this._topology, this._config, this.powerHistory, this.subDeviceHorizonMap);
  }

  async onGraphSettingsChanged(root: DOMRoot): Promise<void> {
    if (!this._hass) return;
    if (this._favRefs) {
      // Favorites view: per-entry fresh fetches, routed through refs.
      await this._buildFavoritesHorizonMaps();
    } else {
      this.graphSettingsCache.invalidate();
      await this.graphSettingsCache.fetch(this._hass, this._configEntryId);
      this.buildHorizonMaps(this.graphSettingsCache.settings);
    }

    this.powerHistory.clear();
    try {
      await this.loadHistory();
    } catch {
      // Will populate on next refresh
    }
    this.updateDOM(root);
  }

  onToggleClick(ev: Event, root: DOMRoot): void {
    const target = ev.target as HTMLElement | null;
    const pill = target?.closest(".toggle-pill");
    if (!pill) return;
    const cb = root.querySelector(".slide-confirm");
    if (!cb || !cb.classList.contains("confirmed")) return;
    ev.stopPropagation();
    ev.preventDefault();
    const slot = pill.closest("[data-uuid]") as HTMLElement | null;
    if (!slot || !this._topology || !this._hass) return;
    const uuid = slot.dataset.uuid;
    if (!uuid) return;
    const circuit = this._topology.circuits[uuid];
    if (!circuit) return;
    const switchEntity = circuit.entities?.switch;
    if (!switchEntity) return;
    const switchState = this._hass.states[switchEntity];
    if (!switchState) {
      console.warn("SPAN Panel: switch entity not found:", switchEntity);
      return;
    }
    const service = switchState.state === "on" ? "turn_off" : "turn_on";
    this._hass.callService("switch", service, {}, { entity_id: switchEntity }).catch(err => {
      console.error("SPAN Panel: switch service call failed:", err);
    });
  }

  async onGearClick(event: Event, root: DOMRoot): Promise<void> {
    const target = event.target as HTMLElement | null;
    const gearBtn = target?.closest(".gear-icon") as HTMLElement | null;
    if (!gearBtn) return;

    const sidePanel = root.querySelector("span-side-panel") as SpanSidePanelElement | null;
    if (!sidePanel || !this._hass) return;
    sidePanel.hass = this._hass;

    if (gearBtn.classList.contains("panel-gear")) {
      // Favorites view has no single panel to configure — the aggregate
      // doesn't own global horizon or other panel-level settings.
      if (this._inFavoritesView) return;
      await this.graphSettingsCache.fetch(this._hass, this._configEntryId);
      sidePanel.open({
        panelMode: true,
        topology: this._topology,
        graphSettings: this.graphSettingsCache.settings,
        showFavorites: this._panelFavorites !== null,
        favoritePanelDeviceId: this._panelFavorites?.panelDeviceId,
        favoriteCircuitUuids: this._panelFavorites?.circuitUuids,
        favoriteSubDeviceIds: this._panelFavorites?.subDeviceIds,
        configEntryId: this._configEntryId,
      });
      return;
    }

    const uuid = gearBtn.dataset.uuid;
    if (uuid && this._topology) {
      const circuit = this._topology.circuits[uuid];
      if (circuit) {
        const ref = this._favRefs?.[uuid] ?? null;
        const realUuid = ref && ref.kind === "circuit" ? ref.targetId : uuid;
        const entryId = ref?.configEntryId ?? this._configEntryId;

        // In favorites view, bypass the single-entry caches so we pick
        // up the right panel's current graph/monitoring state.
        let graphSettings: GraphSettings | null;
        let monitoringStatus: MonitoringStatus | null;
        if (ref) {
          [graphSettings, monitoringStatus] = await Promise.all([this._fetchGraphSettingsFresh(entryId), this._fetchMonitoringStatusFresh(entryId)]);
        } else {
          await Promise.all([this.graphSettingsCache.fetch(this._hass, entryId), this.monitoringCache.fetch(this._hass, entryId)]);
          graphSettings = this.graphSettingsCache.settings;
          monitoringStatus = this.monitoringCache.status;
        }

        const monitoringEntity = circuit.entities?.current ?? circuit.entities?.power;
        const monitoringInfo = monitoringEntity ? (monitoringStatus?.circuits?.[monitoringEntity] ?? null) : null;

        const globalHorizon = graphSettings?.global_horizon ?? DEFAULT_GRAPH_HORIZON;
        const circuitOverride = graphSettings?.circuits?.[realUuid];
        const graphHorizonInfo = circuitOverride ? { ...circuitOverride, globalHorizon } : { horizon: globalHorizon, has_override: false, globalHorizon };

        // Heart section shows whenever we're in a dashboard context — either
        // the Favorites pseudo-panel (always favorited) or a real panel with
        // the per-panel favorites set supplied by span-panel.ts. Standalone
        // <span-panel-card> omits both and hearts don't render.
        const favoritePanelDeviceId = ref?.panelDeviceId ?? this._panelFavorites?.panelDeviceId;
        const isFavorite = ref !== null || (this._panelFavorites?.circuitUuids.has(realUuid) ?? false);
        const showFavorites = this._inFavoritesView || this._panelFavorites !== null;

        sidePanel.open({
          ...circuit,
          uuid: realUuid,
          monitoringInfo,
          showMonitoring: this._showMonitoring,
          graphHorizonInfo,
          showFavorites,
          favoritePanelDeviceId,
          isFavorite,
          configEntryId: entryId,
        } as Record<string, unknown>);
        return;
      }
    }

    const subDevId = gearBtn.dataset.subdevId;
    if (subDevId && this._topology?.sub_devices?.[subDevId]) {
      const sub = this._topology.sub_devices[subDevId]!;
      const ref = this._favRefs?.[subDevId] ?? null;
      const realSubDevId = ref && ref.kind === "sub_device" ? ref.targetId : subDevId;
      const entryId = ref?.configEntryId ?? this._configEntryId;

      let graphSettings: GraphSettings | null;
      if (ref) {
        graphSettings = await this._fetchGraphSettingsFresh(entryId);
      } else {
        await this.graphSettingsCache.fetch(this._hass, entryId);
        graphSettings = this.graphSettingsCache.settings;
      }

      const globalHorizon = graphSettings?.global_horizon ?? DEFAULT_GRAPH_HORIZON;
      const subOverride = graphSettings?.sub_devices?.[realSubDevId];
      const graphHorizonInfo = subOverride ? { ...subOverride, globalHorizon } : { horizon: globalHorizon, has_override: false, globalHorizon };

      const favoritePanelDeviceId = ref?.panelDeviceId ?? this._panelFavorites?.panelDeviceId;
      const isFavorite = ref !== null || (this._panelFavorites?.subDeviceIds.has(realSubDevId) ?? false);
      const showFavorites = this._inFavoritesView || this._panelFavorites !== null;

      sidePanel.open({
        subDeviceMode: true,
        subDeviceId: realSubDevId,
        name: sub.name ?? realSubDevId,
        deviceType: sub.type ?? "",
        entities: sub.entities,
        graphHorizonInfo,
        showFavorites,
        favoritePanelDeviceId,
        isFavorite,
        configEntryId: entryId,
      });
    }
  }

  /**
   * Uncached fetch of graph settings for a specific config entry.
   * Used in Favorites view where the shared ``graphSettingsCache`` is
   * keyed to a different (primary) entry.
   */
  private async _fetchGraphSettingsFresh(entryId: string | null): Promise<GraphSettings | null> {
    if (!this._hass) return null;
    try {
      const serviceData: Record<string, string> = {};
      if (entryId) serviceData.config_entry_id = entryId;
      const resp = await this._hass.callWS<{ response?: GraphSettings }>({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_graph_settings",
        service_data: serviceData,
        return_response: true,
      });
      return resp?.response ?? null;
    } catch {
      return null;
    }
  }

  private async _fetchMonitoringStatusFresh(entryId: string | null): Promise<MonitoringStatus | null> {
    if (!this._hass) return null;
    try {
      const serviceData: Record<string, string> = {};
      if (entryId) serviceData.config_entry_id = entryId;
      const resp = await this._hass.callWS<{ response?: MonitoringStatusResponse }>({
        type: "call_service",
        domain: INTEGRATION_DOMAIN,
        service: "get_monitoring_status",
        service_data: serviceData,
        return_response: true,
      });
      const response = resp?.response;
      if (!response) return null;
      return { circuits: response.circuits, mains: response.mains };
    } catch {
      return null;
    }
  }

  bindSlideConfirm(slideEl: Element, parent: Element | null): void {
    const knob = slideEl.querySelector(".slide-confirm-knob") as HTMLElement | null;
    const textEl = slideEl.querySelector(".slide-confirm-text");
    if (!knob || !textEl) return;
    let dragging = false;
    let startX = 0;
    let maxX = 0;

    const begin = (clientX: number): void => {
      if (slideEl.classList.contains("confirmed")) return;
      dragging = true;
      startX = clientX - knob.offsetLeft;
      maxX = (slideEl as HTMLElement).offsetWidth - knob.offsetWidth - 4;
      knob.classList.remove("snapping");
    };
    const move = (clientX: number): void => {
      if (!dragging) return;
      const x = Math.max(2, Math.min(clientX - startX, maxX));
      knob.style.left = x + "px";
    };
    const end = (): void => {
      if (!dragging) return;
      dragging = false;
      const pos = (knob.offsetLeft - 2) / maxX;
      if (pos >= SLIDE_THRESHOLD) {
        knob.style.left = maxX + "px";
        slideEl.classList.add("confirmed");
        knob.querySelector("ha-icon")?.setAttribute("icon", "mdi:lock-open");
        textEl.textContent = (slideEl as HTMLElement).dataset.textOn ?? "";
        if (parent) parent.classList.remove("switches-disabled");
      } else {
        knob.classList.add("snapping");
        knob.style.left = "2px";
      }
    };

    knob.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
      begin(e.clientX);
    });
    slideEl.addEventListener("mousemove", (e: Event) => move((e as MouseEvent).clientX));
    slideEl.addEventListener("mouseup", end);
    slideEl.addEventListener("mouseleave", end);
    knob.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        e.preventDefault();
        begin(e.touches[0]!.clientX);
      },
      { passive: false }
    );
    slideEl.addEventListener("touchmove", (e: Event) => move((e as TouchEvent).touches[0]!.clientX), { passive: true });
    slideEl.addEventListener("touchend", end);
    slideEl.addEventListener("touchcancel", end);

    slideEl.addEventListener("click", () => {
      if (!slideEl.classList.contains("confirmed")) return;
      slideEl.classList.remove("confirmed");
      knob.classList.add("snapping");
      knob.style.left = "2px";
      knob.querySelector("ha-icon")?.setAttribute("icon", "mdi:lock");
      textEl.textContent = (slideEl as HTMLElement).dataset.textOff ?? "";
      if (parent) parent.classList.add("switches-disabled");
    });
  }

  startIntervals(root: DOMRoot, onUpdate?: () => void): void {
    this._updateInterval = setInterval(() => {
      this.recordSamples();
      this.updateDOM(root);
      if (onUpdate) onUpdate();
    }, LIVE_SAMPLE_INTERVAL_MS);

    this._recorderRefreshInterval = setInterval(() => {
      this.refreshRecorderData(root);
    }, RECORDER_REFRESH_MS);
  }

  stopIntervals(): void {
    if (this._updateInterval) {
      clearInterval(this._updateInterval);
      this._updateInterval = null;
    }
    if (this._recorderRefreshInterval) {
      clearInterval(this._recorderRefreshInterval);
      this._recorderRefreshInterval = null;
    }
    this.cleanupResizeObserver();
  }

  setupResizeObserver(root: DOMRoot, element: Element | null): void {
    this.cleanupResizeObserver();
    if (!element) return;
    this._lastWidth = (element as HTMLElement).clientWidth;
    this._resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const newWidth = entry.contentRect.width;
      if (Math.abs(newWidth - this._lastWidth) < RESIZE_THRESHOLD_PX) return;
      this._lastWidth = newWidth;
      if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
      this._resizeDebounce = setTimeout(() => {
        for (const container of root.querySelectorAll(".chart-container")) {
          const chart = container.querySelector("ha-chart-base");
          if (chart) chart.remove();
        }
        this.updateDOM(root);
      }, RESIZE_DEBOUNCE_MS);
    });
    this._resizeObserver.observe(element);
  }

  cleanupResizeObserver(): void {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._resizeDebounce) {
      clearTimeout(this._resizeDebounce);
      this._resizeDebounce = null;
    }
  }

  reset(): void {
    this.powerHistory.clear();
    this.horizonMap.clear();
    this.subDeviceHorizonMap.clear();
    this.monitoringCache.clear();
    this.graphSettingsCache.clear();
  }
}
