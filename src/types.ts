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
