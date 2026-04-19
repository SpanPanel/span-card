# Changelog

## 0.9.5

### Fixed

- **Favorites view blanks after `visibilitychange` restore** — Restored a `_recoverIfNeeded` helper on the panel's visibilitychange handler. It wraps
  `_scheduleTabRender` in try/catch **and** verifies `#tab-content` received content; on thrown error or zero child nodes, it makes the initial render and then
  retries up to three times with 2s / 4s / 6s backoff (four total renders in the worst case). The Favorites render path clears its container before awaiting
  several async build steps (`FavoritesController.build`, `fetchAndBuildHorizonMaps`, `fetchMergedMonitoringStatus`), and when HA's WebSocket drops mid-render
  one of those resolved empty or null without throwing, leaving the container blank with no console error. The retry catches the silent bailout. Dashboard (By
  Panel) avoided the symptom because its simpler render produces an error message on failure instead of bailing quietly. The helper matches the pre-LitElement
  behaviour removed during the `c4154d2` refactor.
- **List row `.list-power-value` min-width shrank the name column for no benefit** — Dropped the 70px `min-width` and `text-align: right` on
  `.list-power-value`. Short readings (`1.3A`) were right-aligned inside a 70px cell, leaving a ~40px empty column between the relay control and the reading
  that robbed width from the `flex:1 .list-circuit-name`. The value now sizes to content and hugs the preceding relay pill; the freed column flows back into the
  name.

### Changed

- **Narrow-viewport list rows fold to a two-row grid** — New `@media (max-width: 520px)` rule switches `.list-row` from flex to grid with `grid-template-areas`
  so the circuit name occupies the whole first row (paired with the expand chevron) and `breaker-badge`, `utilization`, shedding icon, status control, power
  value, and gear drop to a second row. A `1fr` gap column between the status and power slots keeps the relay pill snug against the reading.
- **By Panel breaker cells fold based on grid width, not viewport** — Made `.panel-grid` a size-query container (`container-type: inline-size`) and added an
  `@container (max-width: 760px)` rule on `.circuit-slot`. Each cell is half the grid's width, so truncation kicks in well before any viewport media query would
  trigger. The fold uses `display: contents` on `.circuit-header`, `.circuit-info`, `.circuit-controls`, and `.circuit-status` so the leaf elements can be
  placed directly via `grid-area` on the outer grid — name spans the full first row, the second row mirrors the list-row layout (badge, util, shed, status,
  power, gear), and `.chart-container` stays as a full-width third row.

## 0.9.4

### Added

- **Compact expanded list rows** — Expanding a row in By Activity / By Area now shows only the chart. The gear icon and a real toggle-pill (arm-protected by the
  slide-to-confirm) moved onto the always-visible list row so expanding no longer duplicates information above the chart.
- **Configurable list view columns** — 1 / 2 / 3 column grid for By Activity and By Area, set in Graph Settings → List View Columns. Persisted in localStorage
  as a browser-wide preference (single key, not scoped per device). Narrow viewports (< 600px) force single-column regardless. Expanded charts stay in their own
  column so row-to-chart association stays clear.
- **Favorites per-panel status grid** — The Favorites view now renders a responsive grid of per-contributing-panel status cards (Site / Grid / Upstream /
  Downstream / Solar / Battery) below the slider + W/A row. One card per panel that contributes to the Favorites set; live values update on each tick.
- **Slide-to-arm in Favorites** — Favorites view header now hosts the slide-confirm control so tappable ON/OFF toggles in list rows can actually fire. The
  non-Favorites list views (By Activity / By Area on real panels) also gain a working slide-to-arm (previously the slider rendered but drag handlers were never
  bound).
- **Panel tabs inline with dropdown** — The panel tab bar (By Panel / By Activity / By Area / Monitoring) now sits on the same row as the panel-selector
  dropdown in the toolbar.

### Fixed

- **Favorites utilization % now renders** — The list view was passing `null` monitoring status for Favorites, leaving utilization badges blank. Added per-entry
  fetch + merge (`mergeMonitoringStatuses`) with a keyed 30s cache so cross-panel favorites show the same utilization data the single-panel views show.
- **List / panel view flashing on tab, W/A, and panel switches** — Event handlers were both mutating `@state` and explicitly scheduling renders, so every
  interaction fired two concurrent re-renders. Fixed by moving to the reactive-only path and adding a render coalescer plus a supersession-token guard so
  superseded renders bail out at each async boundary.
- **Amps chart didn't redraw on unit switch** — `powerHistory` merged new-metric points into the existing Watts map under the same UUID key. Now cleared before
  every full re-render.
- **`[data-uuid]` selector shadowing** — `dom-updater` scoped to `.circuit-slot[data-uuid]` so the expanded chart-only slot is targeted instead of the list row
  (which now also carries `data-uuid`).
- **ON/OFF badge no longer silently non-functional** — The tappable badge now routes through the real toggle pipeline with the slide-confirm gate; list views
  previously dropped clicks because no `.slide-confirm` element existed in their header.
- **Favorites view now shows offline banner per contributing panel** — Previously the Favorites view silently hid the red "SPAN Panel unreachable" banner even
  when a contributing panel was offline. The view now renders one banner row per offline panel, labeled with the panel's name (e.g. "Span Panel 2 unreachable"),
  so users mixing favorites from multiple panels can see which one is down.
- **Graph Settings → List View Columns selector now shows the current setting** — the 1/2/3 segmented control rendered without any styling in the side-panel's
  shadow DOM, so the active option was invisible. The side-panel now ships its own `.unit-toggle` styles and highlights the current column count.

### Changed

- **Utilization % moved next to breaker badge** — In both the list rows and the By Panel breaker-grid slots, the utilization percent now sits immediately after
  the breaker badge rather than alongside the battery shedding icon, where it competed visually with battery SoC.
- **Favorites header simplified** — Removed the redundant "Favorites · N favorites" text (the dropdown already says "Favorites"). The header row now holds just
  the slide-to-arm and W/A unit toggle.
- **`buildListRowHTML` replaced the static ON/OFF badge with a real toggle-pill** for controllable circuits. Non-controllable circuits (PV, no switch entity)
  keep a static text badge so they can't be accidentally toggled.

### Architecture

- Extracted `buildPanelStatsHTML` / `updatePanelStatsBlock` so stats-block render + update are shared between the persistent panel header and the Favorites
  per-panel grid.
- Extracted `mergeMonitoringStatuses` pure helper plus a new `MonitoringStatusMultiCache` per-entry keyed cache;
  `DashboardController.fetchMergedMonitoringStatus` now reuses cached results within the 30s TTL instead of fanning out WS calls on every render.
- Extracted `FavoritesViewState` persistence (`src/panel/favorites-view-state.ts`) and the render coalescing / token helpers (`src/panel/coalesce.ts`) out of
  the ~1000-line panel element. Both are pure and now tested.
- `CARD_STYLES` emitted once via Lit `static styles` rather than `insertAdjacentHTML`'d per tab render.
- `CSS.escape` wrapper applied to every identifier-interpolated `querySelector`.
- Each circuit in a list view now wraps its row + optional expansion in a `.list-cell` container so the expansion stays in the same CSS-grid column as its row
  in multi-column mode.
- Debounced Favorites view-state localStorage persistence (250ms) so long search queries don't thrash storage.
- Tests grew from 109 → 132 (new coverage: `getCircuitStateClasses`, `mergeMonitoringStatuses`, `FavoritesController.build` composite-id construction, and
  render-coalescing / supersession-token contracts).

## 0.9.3

### Added

- **Cross-panel Favorites view** — A synthetic "Favorites" entry appears in the dashboard panel dropdown (only when at least one favorite is configured) and
  aggregates favorited circuits and sub-devices (BESS, EVSE) from every configured SPAN panel into a single workspace.
  - Heart toggles in the Graph Settings side panel and per-circuit / per-sub-device side panels (dashboard mode only — never in the standalone Lovelace card).
  - Favorites view shows By Activity / By Area / Monitoring tabs (no By Panel). When more than one panel contributes, circuit and sub-device names are prefixed
    with their panel name. Sub-device tiles render above the circuit list. Monitoring stacks per-panel blocks.
  - Stateful: active tab, expanded rows, and search query persist via localStorage and restore on return.
- **Persistent panel-stats header** — Site / Grid / Upstream / Downstream / Solar / Battery stats now stay visible across all tabs (By Panel, By Activity, By
  Area, Monitoring) on real panels. Lifted out of the By-Panel grid into the wrapper. Favorites pseudo-panel shows a count summary instead.

### Fixed

- **Sub-device per-target horizon override** — Setting an individual BESS or EVSE horizon from the sub-device side panel had no effect when more than one SPAN
  panel was configured: the service call omitted `config_entry_id`, so the backend wrote the override to the first loaded entry's manager (wrong panel). The
  per-circuit side panel and the panel-mode (Graph Settings) list already threaded it; the sub-device side panel now does too.
- **`<ha-menu-button>` first-render crash** — The dashboard panel no longer creates `ha-menu-button` until Home Assistant has assigned `hass`; HA's component
  reads `this.hass.kioskMode` in `willUpdate` and would throw before the property was set.

### Changed

- **Side-panel domain service calls thread `config_entry_id`** — Circuit horizon, sub-device horizon, and circuit threshold service calls now route to the
  originating panel's config entry. Required for cross-panel Favorites edits to target the right panel and fixes the same-panel bug above.
- **W/A unit toggle moved to the persistent header** — The duplicate toggle below the search bar was removed since the persistent panel-stats header now owns
  it. The Favorites pseudo-panel's summary strip carries its own toggle.

## 0.9.2

### Added

- **By Activity view** — Circuits sorted by power consumption (or current) with collapsible rows that expand to full circuit graphs. Includes search filtering
  and W/A unit toggle.
- **By Area view** — Circuits grouped by Home Assistant area with the same expandable row format. Areas resolve from entity assignments first, then fall back to
  the device area. Live registry subscriptions update grouping when areas change.
- **Shared tab bar** — Both the integration panel and Lovelace card now show By Panel, By Activity, and By Area tabs. The card supports a configurable tab style
  (text or icon) via the card editor.
- **Search with clear button** — Incremental search filtering by circuit name with an X button to reset.

### Changed

- Settings tab removed from the integration panel; graph settings remain accessible via the gear icon in the panel header.
- Shedding icons hidden for circuits with unknown priority (e.g. PV systems).

### Fixed

- `ha-chart-base` receives `hass` before DOM insertion, preventing `performUpdate` errors.

## 0.9.1

### Fixed

- **Blank dashboard after backgrounding** — Migrated panel and card from vanilla `HTMLElement` to LitElement. HA's frontend removes vanilla custom panels during
  WebSocket reconnection without re-creating them; LitElement survives this lifecycle.

### Changed

- Build output switched from IIFE to ESM
- Added `lit` ^3.3.2 dependency

## 0.9.0

- Add integration panel with tab router and multi-panel selector
- Add monitoring tab with overrides table, summary bar, and notification settings
- Add settings tab with integration link and global monitoring configuration
- Add side panel for circuit and panel configuration
- Add A/W toggle switching all values and chart axes
- Add shedding icons, monitoring indicators, and gear icons to circuit cells
- Add i18n support with translations for en, es, fr, ja, pt
- Use topology panel_entities instead of pattern matching

## 0.8.9

- Show amps instead of watts above circuit graphs when chart metric is set to `current`
- Fix Y-axis scale to 0–125% of breaker rating in current mode
- Add red horizontal line at 100% of breaker rating (NEC trip point)
- Add yellow dashed line at 80% of breaker rating (NEC continuous load limit)
- Add total current (amps) stat to panel header

## 0.8.8

- Chart Y-axis formatting uses absolute values for power metric

## 0.8.7

- Use dynamic `panel_size` from topology instead of hardcoded 32

## 0.8.6

- Fix editor storing default 5 minutes when user only changes days/hours
- Use statistics API for long-duration charts
- Fix 0-minute config bug

## 0.8.5

- Add project tooling, CI, and HACS support

## 0.8.4

- Initial SPAN Panel custom Lovelace card
