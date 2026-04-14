# Changelog

## 0.9.1

### Fixed

- **Blank dashboard after backgrounding or navigation** — The panel and card could go permanently blank when returning after the browser tab was backgrounded or
  after navigating away within HA. Root cause was unawaited async renders that cleared the container before WS calls, with no recovery when those calls failed.
  - Panel: `_render()` now separates shell creation from tab rendering; all async tab renders are properly awaited with retry logic and a 15-second timeout to
    prevent hung WS calls from blocking recovery
  - Panel: `_discoverPanels()` no longer marks discovery complete until the WS call succeeds, so a failed discovery retries on the next `hass` update
  - Card: Added DOM health checks in `connectedCallback`, `visibilitychange`, and `hass` setter — re-renders from existing topology if `<ha-card>` is missing
  - Card: Added `.catch()` on discovery promise chain to prevent `_discovering` from being permanently stuck

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
