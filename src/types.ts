// -- Home Assistant types (subset used by this project) --

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  services: Record<string, Record<string, unknown>>;
  language: string;
  user?: { is_admin: boolean };
  callService: (domain: string, service: string, data?: Record<string, unknown>, target?: Record<string, unknown>) => Promise<void>;
  callWS: <T = unknown>(msg: Record<string, unknown>) => Promise<T>;
  formatEntityState?: (entity: HassEntity) => string;
  connection?: {
    subscribeEvents: (callback: () => void, event: string) => Promise<() => void>;
  };
}

// -- SPAN topology types --

export interface CircuitEntities {
  power?: string;
  current?: string;
  switch?: string;
  select?: string;
  [key: string]: string | undefined;
}

export interface Circuit {
  name: string;
  tabs: number[];
  entities: CircuitEntities;
  breaker_rating_a?: number | null;
  device_type?: string;
  relay_state?: string;
  is_user_controllable?: boolean;
  always_on?: boolean;
  voltage?: number;
  area?: string;
}

export interface SubDeviceEntityInfo {
  domain: string;
  original_name?: string;
  unique_id?: string;
}

export interface SubDevice {
  name?: string;
  type?: string;
  entities?: Record<string, SubDeviceEntityInfo>;
}

export interface PanelEntities {
  site_power?: string;
  current_power?: string;
  feedthrough_power?: string;
  pv_power?: string;
  battery_level?: string;
  dsm_state?: string;
  panel_status?: string; // binary_sensor entity for online/offline state
}

export interface PanelTopology {
  circuits: Record<string, Circuit>;
  sub_devices?: Record<string, SubDevice>;
  panel_entities?: PanelEntities;
  device_name?: string;
  serial?: string;
  firmware?: string;
  panel_size?: number;
  device_id?: string;
}

export interface PanelDevice {
  id: string;
  name?: string;
  name_by_user?: string;
  config_entries?: string[];
  identifiers?: [string, string][];
  via_device_id?: string | null;
  sw_version?: string;
  model?: string;
}

export interface DiscoveryResult {
  topology: PanelTopology | null;
  panelDevice: PanelDevice | null;
  panelSize: number;
}

// -- Adopted entity curation --

/**
 * One curatable property the panel publishes, as reported by
 * ``span_panel/adopted/list``. Listed whether or not its entity exists yet:
 * adopted entities are created disabled, and curation is keyed on the wire
 * address rather than on a registry id.
 */
export interface AdoptedRow {
  /** The curation key a save is keyed on. */
  key: string;
  /** The ``{node}/{property}`` wire address. */
  path: string;
  /** ``sensor``, ``binary_sensor``, ``switch``, ``select``, or ``number``. */
  platform: string;
  /** Null when the entity is not in the registry yet. */
  entity_id: string | null;
  /** The declared Homie datatype. */
  datatype: string;
  /** The declared unit, verbatim. */
  unit: string | null;
  /** Whether the panel accepts a write to this property. */
  settable: boolean;
  /** The entity's name in wire vocabulary. */
  name: string;
  /** The stored record, as stored; ``{}`` when the row has never been curated. */
  curation: Record<string, string>;
  /** Device classes this platform and unit admit; empty for a control row. */
  allowed_device_classes: string[];
  /** State classes this row admits; empty off a numeric sensor. */
  allowed_state_classes: string[];
  /** Stored fields the current declaration no longer supports. */
  stale_fields: string[];
}

/** The adopted rows that render on one device card. */
export interface AdoptedDeviceGroup {
  /** Null for an adopted device whose card is not created yet. */
  device_id: string | null;
  /** The card's display name, or the wire label when there is no card yet. */
  name: string | null;
  /** Whether the card is one adoption minted, rather than a curated SPAN device. */
  adopted_device: boolean;
  rows: AdoptedRow[];
}

export interface AdoptedListResponse {
  devices: AdoptedDeviceGroup[];
}

/**
 * The reply to ``span_panel/adopted/curate``: the record as stored, and the
 * consequences of the save that the record does not show on its face
 * (``total_increasing``, ``statistics_removed``).
 */
export interface AdoptedCurateResponse {
  record: Record<string, string>;
  warnings: string[];
}

// -- Card configuration --

export interface CardConfig {
  device_id?: string;
  history_days?: number;
  history_hours?: number;
  history_minutes?: number;
  chart_metric?: string;
  show_panel?: boolean;
  show_battery?: boolean;
  show_evse?: boolean;
  visible_sub_entities?: Record<string, boolean>;
  tab_style?: "text" | "icon";
}

// -- Chart & history types --

export interface HistoryPoint {
  time: number;
  value: number;
}

export type HistoryMap = Map<string, HistoryPoint[]>;

export interface ChartMetricDef {
  entityRole: string;
  label: () => string;
  unit: (v: number) => string;
  format: (v: number) => string;
  fixedMin?: number;
  fixedMax?: number;
}

// -- Favorites --

export interface PanelFavoritesEntry {
  circuits: string[];
  sub_devices: string[];
}

/**
 * Cross-panel favorites, keyed by the main SPAN panel device id
 * (HA device registry id) and grouping the panel-local circuit uuids
 * and sub-device HA device ids the user has marked.
 */
export interface FavoritesMap {
  [panelDeviceId: string]: PanelFavoritesEntry;
}

export type FavoriteKind = "circuit" | "sub_device";

/**
 * Origin metadata for a favorited circuit or sub-device, used by the
 * Favorites pseudo-panel to route per-target service calls back to the
 * correct SPAN panel/config entry after aggregating across panels.
 */
export interface FavoriteRef {
  panelDeviceId: string;
  kind: FavoriteKind;
  /** Real circuit uuid (kind ``circuit``) or HA device id (kind ``sub_device``). */
  targetId: string;
  configEntryId: string | null;
}

/**
 * Merged topology for the Favorites pseudo-panel. Circuits and
 * sub-devices are keyed by composite ids ``"{panelDeviceId}|{targetId}"``
 * so identifiers from different panels can't collide.
 * ``_favoriteRefs`` maps composite ids back to their origin for
 * downstream service calls.
 */
export interface FavoritesTopology extends PanelTopology {
  _favoriteRefs: Record<string, FavoriteRef>;
}

// -- Graph settings --

export interface CircuitGraphOverride {
  horizon: string;
  has_override: boolean;
}

export interface GraphSettings {
  global_horizon?: string;
  circuits?: Record<string, CircuitGraphOverride>;
  sub_devices?: Record<string, CircuitGraphOverride>;
}

// -- Monitoring --

export interface MonitoringPointInfo {
  name?: string;
  monitoring_enabled?: boolean;
  utilization_pct?: number;
  over_threshold_since?: string | null;
  has_override?: boolean;
  continuous_threshold_pct?: number;
  spike_threshold_pct?: number;
  window_duration_m?: number;
  cooldown_duration_m?: number;
}

export interface MonitoringGlobalSettings {
  continuous_threshold_pct?: number;
  spike_threshold_pct?: number;
  window_duration_m?: number;
  cooldown_duration_m?: number;
  notify_targets?: string | string[];
  notification_title_template?: string;
  notification_message_template?: string;
  enable_persistent_notifications?: boolean;
  enable_event_bus?: boolean;
  notification_priority?: string;
}

export interface MonitoringStatusResponse {
  enabled?: boolean;
  global_settings?: MonitoringGlobalSettings;
  circuits?: Record<string, MonitoringPointInfo>;
  mains?: Record<string, MonitoringPointInfo>;
}

export interface CallServiceResponse {
  response?: unknown;
}

export interface MonitoringStatus {
  circuits?: Record<string, MonitoringPointInfo>;
  mains?: Record<string, MonitoringPointInfo>;
}

// -- Graph horizon preset --

export interface GraphHorizonPreset {
  ms: number;
  refreshMs: number;
  useRealtime: boolean;
}

// -- Shedding priority --

export interface SheddingPriorityDef {
  icon: string;
  icon2?: string;
  color: string;
  label: () => string;
  textLabel?: string;
}

// -- Sub-device entity collection --

export interface SubDeviceEntityRef {
  entityId: string;
  key: string;
  devId: string;
}

// -- Entity descriptor for sub-device entity finder --

export interface EntityDescriptor {
  names: string[];
  suffixes: string[];
}

// -- Dual-tab layout classification --

export type DualTabLayout = "row-span" | "col-span" | null;
