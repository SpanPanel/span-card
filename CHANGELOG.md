# Changelog

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
