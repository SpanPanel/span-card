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
  index.ts                  # Card entry point — registers custom elements, the card and the section strategy

  card/
    span-panel-card.ts      # Main Lovelace card (extends HTMLElement)
    card-discovery.ts       # WebSocket topology discovery + entity fallback
    card-suggestion.ts      # The card the card picker suggests for an entity of the integration's
    card-styles.ts          # Card CSS

  strategy/
    span-panel-section-strategy.ts  # Dashboard section of one panel: its card, at the section's full width

  core/
    dashboard-controller.ts # Shared controller (used by card + panel dashboard)
    grid-renderer.ts        # Breaker grid HTML builder
    header-renderer.ts      # Panel header HTML builder
    sub-device-renderer.ts  # BESS/EVSE sub-device HTML builder
    dom-updater.ts          # Incremental DOM updates for live data
    history-loader.ts       # Loads history from HA recorder (raw + statistics)
    monitoring-status.ts    # Monitoring status cache + utilization helpers
    monitoring-access.ts    # Who may change monitoring, and how the views keep to it
    control-access.ts       # Who may operate a panel's relays and priorities, and the one way the card sends a change
    graph-settings.ts       # Graph horizon settings cache + effective horizon lookup
    side-panel.ts           # Sliding configuration panel (custom element)
    registry-types.ts       # Device and entity registry entries, and the panel filter
    panel-devices.ts        # The SPAN panels in the device registry, by the config entry that owns each
    device-rename.ts        # Device renames, which a showing topology's labels follow
    lovelace-registration.ts  # Entries in the frontend's lists of custom cards and strategies

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

### Dashboard Editor Registration

`src/index.ts` adds the card bundle's parts to the lists Home Assistant's dashboard editor reads:

- **The card**, in `window.customCards`. Its `getEntitySuggestion` answers for an entity of the integration's with the card of the panel the entity's device
  belongs to, which the card picker lists under Community (Home Assistant 2026.6+).
- **The section strategy**, in `window.customStrategies` as `span-panel`, and its element `ll-strategy-section-span-panel`, which the editor offers under
  Community sections (Home Assistant 2026.11+). A section is written as `strategy: {type: custom:span-panel, device_id: …}`, with any of the card's other
  options beside `device_id`, and holds the card alone, given those options.

`registerCustomCard()` and `registerCustomStrategy()` add to a list that is already there rather than replacing it, because the frontend keeps the list it found
when it loaded. A second copy of the bundle on a page, such as one a leftover HACS resource loads, registers nothing: its card module's `@customElement`
definition is unguarded and throws while the bundle's modules load, before `src/index.ts` reaches either call. Called again regardless, each adds an entry of a
type once.

A section's width in its view is the `column_span` saved on the section itself, which the user sets in the section's settings; the sections view reads it from
the saved config, not from what the strategy generates (frontend 20261028). The strategy gives the card `grid_options: {columns: full}`, so the card fills the
section at whatever width the user picks. The section reads no registry, so it declares no `registryDependencies` and is not regenerated when one changes; the
card follows the registries itself.

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

Shared types live in `src/types.ts`:

- `HomeAssistant` — subset of the HA frontend type used by this project
- `PanelDevice` — a SPAN panel's device registry entry
- `PanelTopology` — circuits, sub-devices, panel entities
- `Circuit` — name, tabs, entities, breaker rating, shedding info
- `CardConfig` — user-facing card configuration
- `HistoryMap` — `Map<string, HistoryPoint[]>` for power/current history
- `ChartMetricDef` — defines how a metric is formatted and displayed
- `GraphSettings` — per-circuit and global graph horizon overrides
- `MonitoringStatus` — utilization, alerts, thresholds

The Home Assistant registry entries live in `src/core/registry-types.ts`:

- `DeviceRegistryEntry`, `EntityRegistryEntry` — the fields the card reads of the device and entity registry lists
- `isPanelDevice()` — whether a device is a panel: one of the integration's config entries owns it, and it is neither a battery or charger reached through
  another device nor a circuit's child device
- `sharesOwner()` — whether the config entry that owns a panel owns a device too, as it owns each of the panel's own devices
- `owningPanelDevice()` — the panel one of those devices belongs to, or the device itself where it is a panel
- `deviceName()` — a device's name as Home Assistant shows it
- `entityOwnName()` — an entity's own name, the user's before the integration's, without its device's

A panel is told by the config entry that owns it, not by an identifier in the integration's domain. Home Assistant 2026.8 split each device that several config
entries shared into one device per entry, each keeping the shared device's identifiers, so a helper that had linked itself to a panel owns a copy of the panel's
device, its SPAN identifier included. The integration's entries come from one of two places in `src/core/panel-devices.ts`:

- `discoverPanelDevices()` lists the panels for the card editor and the sidebar dashboard from the device registry list, judging each device against the entries
  `config_entries/get` returns, which any user may ask for. Each request reports under an error id of its own, `fetch:devices` and `fetch:config_entries`.
- `spanEntryIdsOf()` names the entries from the frontend's registries without asking: the owner of each device an entity of the integration's in `hass.entities`
  sits on. The card picker's suggestion and the section strategy's starting config use it, since neither waits for an answer.

A panel's own devices are told the same way. The split also left a helper that had linked itself to a battery or a charger owning a copy of that device, whose
`via_device_id` can point at the panel. `owningPanelDevice()` and the entity fallback's circuits and sub-devices (`discoverEntitiesFallback()`) take only a
device `sharesOwner()` accepts.

### Monitoring Changes

Only a Home Assistant administrator may change a panel's monitoring: the integration refuses a logged-in user who is not one each of its monitoring services
that changes something, while `get_monitoring_status` stays open to everyone. `src/core/monitoring-access.ts` holds the card's side of that rule:

- `monitoringWrites(hass)` is the one way the card sends a monitoring change, one method per service. It sends nothing for a user `canEditMonitoring()` does not
  accept, which is anyone the frontend does not say is an administrator, and it turns the integration's Unauthorized into a `MonitoringChangeRefused`, whose
  message says only an administrator can change monitoring, so each view's report of a failed change says that. `tests/monitoring-access.test.ts` fails where
  one of these services is named anywhere else in `src/`.
- For anyone else, the Monitoring tab and a circuit's Monitoring section show every setting as it stands, under a note from `readOnlyNote()` saying why nothing
  there can be changed. `lockMonitoringControls()` makes each field read-only, so what it holds can still be read and selected, and disables every other control
  but the rating marks, which change nothing. The side panel locks again what the package ratings editor redraws. The frontend can say who the user is only
  after a view is drawn, so the sidebar dashboard draws the Monitoring tab, and an open side panel its Monitoring section, again as `canEditMonitoring()`
  changes.

### Control Changes

The integration's control gate decides who may operate a panel's relays and shedding priorities: its options can switch control off or let only an administrator
operate them, and a user whose Home Assistant permissions do not allow controlling the panel's entities, as one in the Read Only group, may not.
`panel_topology` says what the gate would decide for the user who asked, as `control_access: {may_operate, reason}`. Where `may_operate` is false, `reason` is
the first of `control_disabled`, `admin_only` and `read_only` that applies. `src/core/control-access.ts` holds the card's side of that rule:

- `controlAccess(topology)` reads it. `may_operate` decides, and `reason` only picks the hint; a reason the card does not know reads as none, which the generic
  hint answers. Where the topology says nothing, as from an integration that predates the field or from the entity fallback, the controls are taken as operable,
  as they always were, and the gate still refuses what it refuses. This reader alone takes silence as operable. Past it the access is required: a circuit side
  panel's config (`CircuitModeConfig.controlAccess`) and each Favorites circuit ref (`FavoriteCircuitRef`) must carry one, so the compiler flags a path that
  omits it, and a Favorites circuit with no circuit ref is not operable (`CONTROLS_NOT_KNOWN`). `circuitControlAccess()` answers for one circuit, in the
  Favorites view from its own panel's ref. `viewControlAccess()` answers for a view's "Enable Switches" slider, which is operable where any of the view's
  circuits is.
- `controlWrites(hass, access)` is the one way the card sends a change: `setRelay()` sends `switch.turn_on` or `switch.turn_off`, and `setPriority()` sends
  `select.select_option`, each over the websocket, so Home Assistant shows no toast of its own beside the card's banner. It sends nothing where the access does
  not allow it, rejecting with a `ControlChangeRefused` that says why. Home Assistant's Unauthorized (`isUnauthorized()`), for a user the integration lets
  operate the panel whose permissions do not cover this one entity, comes back as a `ControlChangeRefused` saying so in the user's language, since its own
  message is English. The card sends nothing to the integration's control lock switch; "Enable Switches" is the card's own arming of its toggles.
- `tests/control-access.test.ts` reads the text of `src/` and fails where:
  - a relay or priority service (`turn_on`, `turn_off`, `toggle`, `select_option`, `select_next`, `select_previous`, `select_first` or `select_last`) is named
    outside the module, quoted, after its domain (`"switch.toggle"`) or in a REST path (`"services/switch/toggle"`);
  - `callService` is called, or named anywhere but the `HomeAssistant` type, or `callApi(` or the `execute_script` command appears;
  - `call_service` appears other than as a message's `type`, so a message built from a constant is seen;
  - a `call_service` message holds a spread, which could bring a domain in;
  - a `call_service` message outside the module names any domain but `domain: INTEGRATION_DOMAIN`, or names more than one.

  It reads text, not code: a message changed after it is built, as by `msg.domain = "switch"`, is not seen.

- `reportControlFailure()` puts a failed change in the error store, saying why as the gate said it: the refusal's translation key is looked up in the
  integration's exception translations (`serviceErrorMessage()`), so an armed control lock, a relay operated a moment ago, or a policy that changed since the
  topology was fetched each read as the gate words them.
- Where the user may not operate the controls, each is drawn disabled and titled with why (`controlAccessHint()`): the side panel's relay switch and priority
  select, under a note in the first of their sections (`controlNoteHTML()`); each toggle pill in the breaker grid and the list rows (`toggle-forbidden`); and
  the slider (`slide-confirm-forbidden`, which `bindSlideConfirm()` never arms), with a note under the panel's name.
- The Favorites view mixes panels, so its slider can be armed where the user may operate any of them, and its strip carries no note. Instead each panel the user
  may not operate says why under its own name in the stats grid (`favoritesPanelAccess()`), and a tap on one of its toggles, whose title a touch never shows,
  puts the hint in the banner as a transient warning, in the store's one transient slot, so tapping again replaces it rather than stacking it.
- The side panel's switch and select are named by their labels and described by the note (`aria-labelledby`, `aria-describedby`). The pill and the slider are
  plain elements with no role, so their titles and the note, not an ARIA state, say why. The gear, the favorite, the graph horizon and the read-only monitoring
  stay open.
- A refused change never stays shown: the side panel's switch and select show again what Home Assistant reports, and a toggle pill only ever shows that.
- The access arrives with each topology, and `sameTopologyStructure()` counts a change of it as a change of structure, so the views draw again. The sidebar
  waits for an open side panel to close before it draws a view again, so that panel takes the new access in place (`refreshControlAccess()`), keeping what else
  it shows. The card draws its view again at once: its By Panel side panel sits outside the view and takes the new access in place, while a By Activity or By
  Area side panel is drawn over with its list.

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
- `no-restricted-syntax` keeps reads of the `friendly_name` state attribute, which Home Assistant is retiring, out of `src/`: take an entity's own name from the
  registry, or ask `hass.formatEntityName` for the parts by name. The rule rejects the attribute's name wherever it is written out:
  - a property access: `attrs.friendly_name`, `attrs?.friendly_name`
  - a string: `attrs["friendly_name"]`, `"friendly_name" in attrs`, a quoted key
  - a template literal's text: ``attrs[`friendly_name`]``
  - a property key: `const { friendly_name } = attrs`, whether given a new name or a default, nested or in a parameter, and a key of an object literal

  It cannot see a name that is never written out: a key put together at run time (`"friendly_" + "name"`), a key held in a variable, or code that reads every
  attribute at once. `tests/friendly-name-lint.test.ts` holds a case of each form.

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

The SPAN Panel integration bundles both files and serves them from its own static path, so no HACS or manual installation is needed. It registers
`dist/span-panel.js` as its sidebar panel and loads `dist/span-panel-card.js` on every dashboard as an extra frontend module.

To update the distributed files after changes:

```bash
npm run build
```

Then commit the updated `dist/` files.
