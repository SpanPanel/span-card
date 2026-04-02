# Developer Guide

## Prerequisites

- Node.js 20+
- npm

## Setup

```bash
npm install
```

This installs all dev dependencies and sets up lefthook pre-commit hooks.

## Scripts

| Command              | Description                                        |
| -------------------- | -------------------------------------------------- |
| `npm run build`      | Type-check and produce minified production bundles |
| `npm run dev`        | Watch mode with hot-reload (no minification)       |
| `npm run typecheck`  | Type-check only (no output)                        |
| `npm run lint`       | Run ESLint on `src/`                               |
| `npm test`           | Run test suite                                     |
| `npm run test:watch` | Run tests in watch mode                            |

## Project Structure

```text
src/
  types.ts                  # Shared TypeScript interfaces
  constants.ts              # Global constants, metric definitions, named magic numbers
  i18n.ts                   # Internationalization (en, es, fr, ja, pt)
  index.ts                  # Card entry point — registers custom elements

  card/
    span-panel-card.ts      # Main Lovelace card (extends HTMLElement)
    card-discovery.ts       # WebSocket topology discovery + entity fallback
    card-styles.ts          # Card CSS

  core/
    dashboard-controller.ts # Shared controller (used by card + panel dashboard)
    grid-renderer.ts        # Breaker grid HTML builder
    header-renderer.ts      # Panel header HTML builder
    sub-device-renderer.ts  # BESS/EVSE sub-device HTML builder
    dom-updater.ts          # Incremental DOM updates for live data
    history-loader.ts       # Loads history from HA recorder (raw + statistics)
    monitoring-status.ts    # Monitoring status cache + utilization helpers
    graph-settings.ts       # Graph horizon settings cache + effective horizon lookup
    side-panel.ts           # Sliding configuration panel (custom element)

  panel/
    index.ts                # Integration panel entry point
    span-panel.ts           # Panel container with tab navigation
    tab-dashboard.ts        # Dashboard tab (delegates to DashboardController)
    tab-monitoring.ts       # Monitoring configuration tab
    tab-settings.ts         # Settings tab (graph horizons, integration link)

  editor/
    span-panel-card-editor.ts  # Visual card editor for Lovelace UI

  chart/
    chart-options.ts        # ECharts configuration builder
    chart-update.ts         # Chart DOM creation/update

  helpers/
    sanitize.ts             # HTML escaping (XSS prevention)
    format.ts               # Power/unit formatting
    layout.ts               # Tab-to-grid position calculations
    chart.ts                # Chart metric selection
    history.ts              # History duration, sampling, deduplication
    entity-finder.ts        # Sub-device entity discovery by name/suffix

tests/                      # Unit tests (vitest)
scripts/
  validate-i18n.mjs         # Validates translation key consistency across languages
  fix-markdown.sh           # Markdown formatting helper
dist/
  span-panel-card.js        # Card bundle (IIFE, minified)
  span-panel.js             # Integration panel bundle (IIFE, minified)
```

## Architecture

The project produces two independent bundles from two entry points:

1. **`src/index.ts`** &rarr; `dist/span-panel-card.js` — the Lovelace custom card
2. **`src/panel/index.ts`** &rarr; `dist/span-panel.js` — the integration panel

Both share the same core modules. The `DashboardController` in `src/core/dashboard-controller.ts` encapsulates all shared dashboard behavior (live sampling,
history loading, horizon maps, slide-to-confirm, toggle/gear clicks, resize observation) so the card and panel dashboard tab delegate to it rather than
duplicating logic.

### Data Flow

```text
Home Assistant
  ├─ Device Registry       → panel discovery
  ├─ Entity Registry       → entity fallback discovery
  ├─ WebSocket API         → span_panel/panel_topology
  ├─ Recorder (history)    → raw history + statistics
  └─ hass.states           → live entity state
        │
        ▼
  DashboardController
  ├─ recordSamples()       → live power sampling (1s interval)
  ├─ refreshRecorderData() → periodic recorder refresh (30s)
  ├─ buildHorizonMaps()    → per-circuit/sub-device graph horizons
  └─ updateDOM()           → incremental DOM updates
        │
        ▼
  Renderers (grid, header, sub-device, chart)
```

### Key Types

All shared types live in `src/types.ts`:

- `HomeAssistant` — subset of the HA frontend type used by this project
- `PanelTopology` — circuits, sub-devices, panel entities
- `Circuit` — name, tabs, entities, breaker rating, shedding info
- `CardConfig` — user-facing card configuration
- `HistoryMap` — `Map<string, HistoryPoint[]>` for power/current history
- `ChartMetricDef` — defines how a metric is formatted and displayed
- `GraphSettings` — per-circuit and global graph horizon overrides
- `MonitoringStatus` — utilization, alerts, thresholds

## TypeScript

The project uses strict TypeScript with these compiler options:

- `strict: true`
- `noUncheckedIndexedAccess: true` — forces guarding Record/array index access
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- Target: ES2020, bundled as IIFE by Rollup

Type-checking runs before every build (`tsc --noEmit && rollup -c`) and in the pre-commit hook.

## Build

Rollup bundles each entry point into a single IIFE file:

- **Production** (`npm run build`): TypeScript plugin compiles `.ts`, then Terser minifies
- **Development** (`npm run dev`): TypeScript plugin compiles `.ts`, no minification, watch mode

The TypeScript plugin handles compilation; `tsc --noEmit` is used only for type-checking. No `.js` output is produced by `tsc` directly.

## Linting

ESLint uses the flat config format with `typescript-eslint`:

- `eslint:recommended` + `tseslint.configs.recommended`
- `eqeqeq` (strict equality)
- `no-var`, `prefer-const`
- `@typescript-eslint/no-shadow`
- `consistent-return`
- Unused vars with `argsIgnorePattern: ^_`

Prettier handles formatting (160 char width, 2-space indent, double quotes).

## Testing

Tests use [Vitest](https://vitest.dev/) and live in `tests/`. They cover all pure helper functions and core utilities:

```bash
npm test              # single run
npm run test:watch    # watch mode
```

To add a test, create `tests/<module>.test.ts` and import from `../src/<path>.js` (TypeScript resolves `.js` imports to `.ts` files).

## Pre-commit Hooks

Lefthook runs these checks in parallel on staged files:

| Hook          | Glob                             | Command                          |
| ------------- | -------------------------------- | -------------------------------- |
| prettier      | `*.{ts,js,mjs,json,md,yml,yaml}` | `prettier --check`               |
| eslint        | `*.{ts,js,mjs}`                  | `eslint`                         |
| typecheck     | `src/**/*.ts`                    | `tsc --noEmit`                   |
| markdownlint  | `*.md`                           | `markdownlint-cli2`              |
| i18n-validate | `src/**/*.ts`                    | `node scripts/validate-i18n.mjs` |

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:

- **lint job**: ESLint, Prettier, TypeScript type-check, Vitest, markdownlint
- **build job**: Full production build (`npm run build`)

## Internationalization

Translations live in `src/i18n.ts` with 5 languages: `en`, `es`, `fr`, `ja`, `pt`.

The `scripts/validate-i18n.mjs` script checks:

1. Every `t("key")` call in source has a matching English key
2. Every English key exists in all other languages
3. No orphaned keys in non-English languages

Run manually: `node scripts/validate-i18n.mjs`

## Adding a New Translation Key

1. Add the key to the `en` block in `src/i18n.ts`
2. Add translations for `es`, `fr`, `ja`, `pt`
3. Run `node scripts/validate-i18n.mjs` to verify

## Distribution

The SPAN Panel integration serves the card automatically from its static path. No HACS or manual installation is required. The integration registers both
`dist/span-panel-card.js` and `dist/span-panel.js` as Lovelace resources.

To update the distributed files after changes:

```bash
npm run build
```

Then commit the updated `dist/` files.
