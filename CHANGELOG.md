# Changelog

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
