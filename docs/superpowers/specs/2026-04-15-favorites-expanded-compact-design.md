# Favorites list view: compact expanded row

Date: 2026-04-15 Repo: `span-card` (consumed by `span` HA integration)

## Problem

In the By-Area and By-Activity views, expanding a list row currently renders a full breaker "slot" above the chart: breaker badge, name, power/current value,
toggle pill, shedding icon, utilization %, gear. Every value in that expanded header is already shown in the collapsed list row beside it. The duplication
wastes vertical space that would be better used by the chart.

The expanded view does contribute two things the collapsed row does not: a tappable on/off toggle, and a gear that opens the side panel for that circuit.

## Goal

Make the expanded list row show only the chart. Move the two unique controls into the collapsed row so they are always reachable without losing affordance.

## Scope

Applies to every invocation of `ListViewController` — both the Favorites full-page panel and the span-panel card dashboard's By-Area / By-Activity views.
Breaker grid view is not affected.

## Design

### 1. List row (collapsed)

New layout, left to right:

```text
[breaker badge] [name] [shedding] [util%] [ON/OFF badge*] [power] [gear] [chevron]
```

Changes versus today:

- **Gear button** added between power and chevron. Uses the same `.gear-icon.circuit-gear` class and `data-uuid` attribute the breaker grid uses. Gear color
  follows the existing "has custom overrides" rule (`MONITORING_COLORS.custom` vs `#555`). Clicks route to `DashboardController.onGearClick` via the existing
  `.gear-icon` delegated handler — no new wiring.
- **ON/OFF badge becomes tappable** only when `circuit.is_user_controllable !== false && circuit.entities?.switch`. When tappable the badge gains a
  `list-status-toggle` class (adds `cursor: pointer`, hover state). When not tappable, the badge renders exactly as it does today — static.
- Tappable badge clicks route to `DashboardController.onToggleClick`. Event delegation in `list-view-controller.ts` extends its toggle selector to
  `.toggle-pill, .list-status-toggle`.

The existing `list-status-on` / `list-status-off` classes continue to control badge color.

OFF circuits continue to render an empty power cell.

### 2. Expanded content (chart-only)

New helper in `core/list-renderer.ts`:

```ts
export function buildExpandedChartHTML(
  uuid: string,
  circuit: Circuit,
  hass: HomeAssistant,
  config: CardConfig,
  monitoringInfo: MonitoringPointInfo | null
): string;
```

Produces:

```html
<div class="list-expanded-content" data-expanded-uuid="{uuid}">
  <div class="circuit-slot circuit-chart-only {state-classes}" data-uuid="{uuid}">
    <div class="chart-container"></div>
  </div>
</div>
```

Where `{state-classes}` is a space-joined string of any of `circuit-off`, `circuit-producer`, `circuit-alert`, `circuit-custom-monitoring` — produced by a new
shared helper (see §3).

`buildExpandedCircuitHTML` is deleted. All three call sites in `list-view-controller.ts` switch to `buildExpandedChartHTML`.

Preserving the `.circuit-slot[data-uuid]` wrapper is intentional: `DashboardController.updateDOM` walks that selector to attach charts to their
`.chart-container`. Zero changes required in the chart-attachment pipeline.

The `circuit-chart-only` class is a CSS-only marker (tight padding, full-bleed chart). It does not gate any logic.

### 3. Shared state-class helper

Extract into `core/list-renderer.ts` (or a new `core/circuit-state.ts` — picked during implementation based on import cleanliness):

```ts
export function getCircuitStateClasses(circuit: Circuit, monitoringInfo: MonitoringPointInfo | null, isOn: boolean, isProducer: boolean): string;
```

Returns a class string containing any of: `circuit-off`, `circuit-producer`, `circuit-alert`, `circuit-custom-monitoring`.

`grid-renderer.ts` `renderCircuitSlot` adopts this same helper so grid and list stay in sync. This is the only factoring change in `renderCircuitSlot`.

### 4. Event handling in `ListViewController`

`_bindEvents` changes:

- Toggle selector widens: `target.closest(".toggle-pill, .list-status-toggle")`.
- Gear selector unchanged (`.gear-icon`). The list-row gear uses the same class, so it is already covered.

`updateCollapsedRows` additions:

- When a circuit flips, it already updates badge text and `list-status-on`/`list-status-off`. Also ensure `list-status-toggle` is added/removed if
  controllability changes (rare, but cheap).
- Sort logic and expanded-row pairing in `partitionRowGroups` / `reorderListRows` unchanged.

`_toggleExpand`, `_applyFilter`, favorites state persistence (`FAVORITES_VIEW_STATE_CHANGED_EVENT`, `_expandedUuids`, `_searchQuery`) all unchanged.

### 5. CSS (`card/card-styles.ts`)

Add:

```css
.list-row .gear-icon {
  background: transparent;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: #555;
  display: inline-flex;
  align-items: center;
}
.list-row .gear-icon:hover {
  color: var(--primary-text-color);
}

.list-status-badge.list-status-toggle {
  cursor: pointer;
  user-select: none;
}
.list-status-badge.list-status-toggle:hover {
  filter: brightness(1.15);
}

.list-expanded-content {
  padding: 0;
}

.circuit-slot.circuit-chart-only {
  border: none;
  padding: 8px 12px;
  margin: 0;
}
```

Chart height within `.circuit-chart-only .chart-container` must match today's expanded chart height. Exact value is pinned during implementation by reading the
current rule; noted as a verification point.

Remove the now-redundant `.list-expanded-content .circuit-slot { border: none; margin: 0; }` override.

Existing `.circuit-alert` / `.circuit-custom-monitoring` rules continue to style `.circuit-slot` and therefore also apply to `.circuit-slot.circuit-chart-only`
— alert/custom border signaling is preserved on the expanded chart.

## Files touched

- `src/core/list-renderer.ts` — add `buildExpandedChartHTML`, update `buildListRowHTML` (gear, tappable badge), extract `getCircuitStateClasses`, delete
  `buildExpandedCircuitHTML`.
- `src/core/grid-renderer.ts` — adopt `getCircuitStateClasses` in `renderCircuitSlot`.
- `src/core/list-view-controller.ts` — swap renderer at three sites; widen toggle selector; badge-class upkeep in `updateCollapsedRows`.
- `src/card/card-styles.ts` — gear rules, tappable badge rules, chart-only slot rules; remove redundant override.

Not touched: `panel/span-panel.ts`, `card/span-panel-card.ts`, `core/dashboard-controller.ts`, `core/header-renderer.ts`, `core/favorites-*`,
`core/area-resolver.ts`, `core/history-loader.ts`, `core/graph-settings.ts`, chart module, side panel.

## Verification points for implementation

1. Confirm `DashboardController.onToggleClick` resolves `data-uuid` from an ancestor that reaches `.list-row`. If today the lookup walks only to
   `.circuit-slot`, widen to `.circuit-slot, .list-row`.
2. Enumerate tests that assert presence of `.circuit-header` / `.circuit-status` inside expanded content; update them to the new chart-only structure.
3. Measure current `.chart-container` height in an expanded list row and match it in the new rule so the change does not shrink the chart.

## Manual test plan

- Expand rows in By-Activity and By-Area, in both Favorites and the regular dashboard card.
- Confirm header/status no longer duplicate list-row info.
- Tap the ON/OFF badge on a controllable circuit: state flips, row re-sorts, badge color updates.
- Tap the ON/OFF badge on a non-controllable (PV) circuit: nothing happens, no hover cursor.
- Tap the list-row gear: side panel opens for that circuit.
- Trigger a monitoring alert: expanded chart area shows the alert border.
- Reload the Favorites page: expansion state restores; chart remounts; no layout jumps.
- Breaker grid view: unchanged.

## Out of scope

- Adding alert/error visuals to the collapsed list row.
- Restyling the side panel or breaker-grid view.
- Any change to the tab bar, monitoring tabs, or settings.
- Changes to `span` HA integration backend code.
