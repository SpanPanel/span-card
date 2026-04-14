# Changelog

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
