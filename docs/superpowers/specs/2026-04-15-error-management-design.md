# Error Management Design Spec

**Date:** 2026-04-15 **Scope:** span-card frontend + span_panel backend (websocket.py) **Branch:** feature/favorites-view

## Problem

The span-card frontend has no user-facing error management for panel unavailability. When a SPAN panel goes offline:

- Charts silently stop updating (`parseFloat("unavailable")` returns NaN, samples are skipped)
- Switch toggles fail silently (console.error only)
- Favorites, history, monitoring, and graph settings fetches fail silently
- The only user-visible error display is `_showError()` inside the side panel, which auto-dismisses after 5 seconds and only covers service calls made from
  within the side panel

The backend already tracks `panel_offline` state in the coordinator and surfaces it via a `binary_sensor.*_panel_status` entity that is always available.
Entities have per-type availability strategies. The frontend does not consume any of these signals.

## Design Decisions

| Decision                    | Choice                                                      | Rationale                                                                     |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Card vs panel error UX      | Identical in both contexts                                  | Users expect consistent behavior                                              |
| Retry behavior              | Automatic (3x backoff) + manual fallback                    | Handles transient failures automatically; gives user control after exhaustion |
| Stale data visual treatment | Banner only, no opacity/degradation                         | Clean, non-distracting; banner is sufficient signal                           |
| Panel status detection      | Watch `binary_sensor.*_panel_status`                        | Single source of truth maintained by coordinator                              |
| Error display location      | Top-of-dashboard banner                                     | Side panel implies configuration, not system state                            |
| Service call error location | Same top banner                                             | Consistent single location for all errors                                     |
| Banner persistence          | State-driven; persistent errors stay until condition clears | Panel offline must never be displaced by transient errors                     |
| Transient error stacking    | New transient replaces previous transient                   | Prevents banner noise from rapid failures                                     |

## Architecture

### ErrorStore (`src/core/error-store.ts`)

Singleton class managing all active error state.

#### Error Entry Shape

```typescript
interface ErrorEntry {
  id: string; // unique key, e.g. "panel-offline", "service:set_threshold:abc123"
  level: "info" | "warning" | "error";
  message: string; // localized display string
  persistent: boolean; // true = stays until explicitly cleared; false = auto-dismiss
  ttl?: number; // auto-dismiss ms for transient errors (default 5000)
  retryFn?: () => void; // optional retry callback, shown as "Retry" button
  timestamp: number; // when the error was added
}
```

#### Two-Lane Model

- **Persistent lane** — entries with `persistent: true` (e.g., panel offline). Remain until explicitly removed via `ErrorStore.remove(id)`. Multiple persistent
  errors can coexist (e.g., two panels both offline in the integration panel view). Never displaced by transient errors.
- **Transient lane** — entries with `persistent: false` (e.g., failed service call). Auto-dismiss after `ttl` ms. Only one transient error is displayed at a
  time — a new transient error replaces the previous one regardless of `id`. If the same `id` is re-added, the timer resets. This prevents banner noise from
  rapid successive failures.

#### API

```typescript
class ErrorStore {
  add(entry: ErrorEntry): void;
  remove(id: string): void;
  clear(filter?: { persistent?: boolean }): void;
  get active(): ErrorEntry[]; // persistent first, then transient
  subscribe(cb: () => void): () => void; // returns unsubscribe fn
  watchPanelStatus(hass: HomeAssistant, entityId: string): void;
  updateHass(hass: HomeAssistant): void;
}
```

#### Panel Status Watching

- `watchPanelStatus(hass, entityId)` is called once after topology discovery with the `panel_status` binary sensor entity ID from the topology response.
- On each `hass` property update, the card/panel calls `ErrorStore.updateHass(hass)`.
- The store reads `hass.states[entityId].state`:
  - `"off"` (panel offline) -> adds persistent `"panel-offline"` error at level `"error"`
  - `"on"` -> removes the `"panel-offline"` error; briefly adds a transient `"info"` entry ("SPAN Panel reconnected")
  - `"unavailable"` or `"unknown"` -> treated as offline

### RetryManager (`src/core/retry-manager.ts`)

Wraps async operations with automatic retry and backoff, dispatches to ErrorStore on exhaustion.

#### Behavior

- Wraps any `() => Promise<T>` call
- On failure: retries up to 3 times with exponential backoff (1s, 2s, 4s)
- On exhaustion: adds a transient error to the ErrorStore with failure message and optional retry callback
- On success after prior failure: removes the error from the store
- If the ErrorStore has an active `panel-offline` persistent error, skips automatic retries for service calls and immediately dispatches a transient error
  ("Panel offline - action unavailable")

#### API

```typescript
class RetryManager {
  constructor(private store: ErrorStore) {}

  async callWS<T>(hass: HomeAssistant, msg: Record<string, unknown>, opts?: { errorId?: string; errorMessage?: string; retries?: number }): Promise<T>;

  async callService(
    hass: HomeAssistant,
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
    opts?: { errorId?: string; errorMessage?: string; retries?: number }
  ): Promise<void>;
}
```

The `errorId` controls deduplication (e.g., all graph horizon calls share `"service:graph_horizon"`). If omitted, auto-generated from service/WS type.

#### Scope

RetryManager is for user-initiated actions (service calls) and one-shot fetches (topology discovery, history loads). It does NOT wrap data fetches that have
their own 30-second polling caches (graph settings, monitoring status, favorites) — those caches re-attempt on the next poll cycle.

### `<span-error-banner>` Component (`src/core/error-banner.ts`)

LitElement custom element that renders active errors from the ErrorStore.

#### Rendering Rules

- Subscribes to ErrorStore on `connectedCallback`, unsubscribes on `disconnectedCallback`
- Renders all persistent errors first, then the current transient error
- Each error: icon (left) + message text + optional "Retry" button (right)
- Colors via HA CSS variables:
  - `error` level: `var(--error-color)` background tint
  - `warning` level: `var(--warning-color)` background tint
  - `info` level: `var(--info-color)` background tint
- Icons: `mdi:alert-circle` (error), `mdi:alert` (warning), `mdi:information` (info)
- Persistent errors: no dismiss button
- Transient errors: no dismiss button, auto-dismiss via TTL
- When no errors active: renders nothing (no reserved space)

#### Placement

- `span-panel-card.ts`: inside `<ha-card>`, above the tab bar and content
- `span-panel.ts`: below the header/panel selector, above tab content
- Same component in both contexts

#### Styling

- Full width of card/panel
- Compact: small vertical padding, standard card font size
- Stacked persistent + transient errors separated by thin divider
- Entrance/exit: opacity fade transition (~200ms)

## Backend Change

### WebSocket Topology Response (`websocket.py`)

Add the `panel_status` binary sensor entity ID to the topology response's entity map. Currently `_PANEL_SENSOR_KEYS` only resolves `sensor.*` entities. Add a
parallel lookup for the `binary_sensor.*_panel_status` entity.

The topology response `panel_entities` map gains:

```json
{
  "panel_status": "binary_sensor.span_panel_xxx_panel_status"
}
```

Implementation: use `build_binary_sensor_unique_id(serial, "panel_status")` from `id_builder.py` to construct the unique*id (pattern:
`span*{serial}\_panel_status`), then resolve via `entity_registry.async_get_entity_id("binary_sensor", DOMAIN,
unique_id)`. Add this alongside the existing `\_build_panel_entity_map`call in`handle_panel_topology`.

### Frontend Type Change (`types.ts`)

Add `panel_status?: string` to the `PanelEntities` interface.

## Integration Points

### Side Panel (`side-panel.ts`)

Remove `_showError()` method, `#error-msg` div element, and auto-dismiss timer. All ~15 call sites route through ErrorStore instead. The side panel receives the
ErrorStore instance as a property.

### Dashboard Controller (`dashboard-controller.ts`)

- Switch toggle (line 367): replace `console.error` catch with RetryManager call
- History refresh (line 314): replace silent catch with ErrorStore transient error ("Unable to load historical data")
- Graph settings fetch (line 157): dispatch transient error on failure instead of silent fallback

### Card (`span-panel-card.ts`)

- Add `<span-error-banner>` to render output above tab bar
- Create ErrorStore instance, pass to child components
- Replace discovery error static div with ErrorStore persistent error + retry callback
- Call `ErrorStore.watchPanelStatus()` after topology discovery
- Call `ErrorStore.updateHass()` on each `hass` property update

### Panel (`span-panel.ts`)

- Add `<span-error-banner>` below header, above tab content
- Create ErrorStore instance, pass to child components
- Surface device discovery and favorites fetch errors
- Call `ErrorStore.watchPanelStatus()` after discovery
- Call `ErrorStore.updateHass()` on each `hass` property update

### Tab Monitoring (`tab-monitoring.ts`)

Replace silent `.catch(() => {})` patterns (lines 669, 679) with ErrorStore transient errors.

### Cache Stores

These already have 30s polling. On fetch failure, dispatch a transient error to ErrorStore in addition to returning cached/default data:

- `monitoring-status.ts` — "Unable to load monitoring status"
- `favorites-store.ts` — "Unable to load favorites"
- `graph-settings.ts` — "Unable to load graph settings"

### Area Resolver (`area-resolver.ts`)

Replace silent subscription failure (line 94) with a transient warning via ErrorStore.

### Card Discovery (`card-discovery.ts`)

Wire retry callback into ErrorStore persistent error entry so the user can re-trigger discovery without reloading the dashboard.

### Constants (`constants.ts`)

Remove `ERROR_DISPLAY_MS` (5000ms). The ErrorStore defines its own `DEFAULT_ERROR_TTL = 5000` constant internally.

## i18n Keys

All new strings added to `i18n.ts` for all 5 locales (en, es, fr, ja, pt):

### Persistent Errors

| Key                         | English                         |
| --------------------------- | ------------------------------- |
| `error.panel_offline`       | SPAN Panel unreachable          |
| `error.panel_offline_named` | SPAN Panel '{name}' unreachable |
| `error.discovery_failed`    | Unable to connect to SPAN Panel |

### Transient Errors

| Key                             | English                             |
| ------------------------------- | ----------------------------------- |
| `error.service_failed`          | Action failed: {detail}             |
| `error.relay_failed`            | Unable to toggle relay              |
| `error.shedding_failed`         | Unable to update shedding priority  |
| `error.threshold_failed`        | Unable to save threshold            |
| `error.graph_horizon_failed`    | Unable to update graph time horizon |
| `error.favorites_fetch_failed`  | Unable to load favorites            |
| `error.favorites_toggle_failed` | Unable to update favorite           |
| `error.history_failed`          | Unable to load historical data      |
| `error.monitoring_failed`       | Unable to load monitoring status    |
| `error.graph_settings_failed`   | Unable to load graph settings       |

### Info

| Key                       | English                |
| ------------------------- | ---------------------- |
| `error.panel_reconnected` | SPAN Panel reconnected |

### UI

| Key               | English                     |
| ----------------- | --------------------------- |
| `error.retry`     | Retry                       |
| `card.connecting` | Connecting to SPAN Panel... |

## File Impact Summary

### New Files (3)

| File                        | Purpose                          |
| --------------------------- | -------------------------------- |
| `src/core/error-store.ts`   | ErrorStore singleton             |
| `src/core/retry-manager.ts` | RetryManager utility             |
| `src/core/error-banner.ts`  | `<span-error-banner>` LitElement |

### Backend Change (1)

| File                                        | Change                                                |
| ------------------------------------------- | ----------------------------------------------------- |
| `custom_components/span_panel/websocket.py` | Add `panel_status` binary sensor to topology response |

### Modified Frontend Files (12)

| File                               | Change                                              |
| ---------------------------------- | --------------------------------------------------- |
| `src/core/side-panel.ts`           | Remove `_showError()`, route errors to ErrorStore   |
| `src/core/dashboard-controller.ts` | Replace silent catches with ErrorStore/RetryManager |
| `src/card/span-panel-card.ts`      | Add banner, ErrorStore, panel status watching       |
| `src/panel/span-panel.ts`          | Add banner, ErrorStore, panel status watching       |
| `src/panel/tab-monitoring.ts`      | Replace silent catches                              |
| `src/core/monitoring-status.ts`    | Dispatch error on fetch failure                     |
| `src/core/favorites-store.ts`      | Dispatch error on fetch failure                     |
| `src/core/graph-settings.ts`       | Dispatch error on fetch failure                     |
| `src/core/area-resolver.ts`        | Dispatch warning on failure                         |
| `src/card/card-discovery.ts`       | Wire retry into ErrorStore                          |
| `src/i18n.ts`                      | Add error keys for 5 locales                        |
| `src/constants.ts`                 | Remove `ERROR_DISPLAY_MS`                           |
| `src/types.ts`                     | Add `panel_status` to `PanelEntities`               |
