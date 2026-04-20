export const CARD_STYLES: string = `
  :host {
    --span-accent: var(--primary-color, #4dd9af);
  }

  /* Card shell — replaces <ha-card>. Theme variables (--ha-card-*) are
     stable HA contracts (not the deprecated component APIs flagged by the
     2026.4 frontend blog), so they stay in place to keep visual parity
     with the rest of HA's dashboards. */
  .span-card {
    display: block;
    padding: 24px;
    background: var(--card-background-color, #1c1c1c);
    color: var(--primary-text-color, #e0e0e0);
    border-radius: var(--ha-card-border-radius, 12px);
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #333));
    box-shadow: var(--ha-card-box-shadow, none);
  }

  .panel-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px 16px;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--divider-color, #333);
  }
  .header-left { flex: 1 1 300px; min-width: 0; }
  .header-center { flex: 0 0 auto; }
  .header-right { flex: 0 1 auto; min-width: 0; }

  .panel-identity {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    margin-bottom: 12px;
  }

  .panel-title {
    font-size: 1.8em;
    font-weight: 700;
    margin: 0;
    color: var(--primary-text-color, #fff);
  }

  .panel-serial {
    font-size: 0.85em;
    color: var(--secondary-text-color, #999);
    font-family: monospace;
  }

  .panel-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 16px 32px;
  }

  /* Favorites view header: gear + slide-to-arm + right-anchored legend/W-A cluster. */
  .favorites-summary {
    padding: 8px 24px;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  /* Override the generic .gear-icon { margin-left: auto } rule so the
     favorites gear stays flush-left instead of floating to the right of
     the flex row (same idea as .panel-identity .panel-gear does for
     real-panel headers). */
  .favorites-summary .favorites-gear {
    margin-left: 0;
  }
  /* Right-anchored cluster wrapping the shedding legend + W/A unit toggle.
     margin-left:auto moved here from .favorites-summary-unit-toggle so the
     legend and toggle cluster together, matching the real-panel header
     layout. */
  .favorites-summary-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .favorites-subdevices-section {
    padding: 8px 16px 0;
  }

  /* Favorites view: responsive grid of per-contributing-panel status cards. */
  .favorites-panel-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--divider-color, #333);
  }
  .favorites-panel-card {
    background: var(--secondary-background-color, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--divider-color, #333);
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .favorites-panel-card-title {
    font-size: 0.85em;
    font-weight: 600;
    color: var(--primary-text-color);
    opacity: 0.85;
  }
  .favorites-panel-card .panel-stats {
    gap: 10px 20px;
  }
  .favorites-panel-card .stat-value {
    font-size: 1.15em;
  }

  .stat { display: flex; flex-direction: column; }
  .stat-label { font-size: 0.8em; color: var(--secondary-text-color, #999); margin-bottom: 2px; }
  .stat-row { display: flex; align-items: baseline; gap: 2px; }
  .stat-value { font-size: 1.5em; font-weight: 700; color: var(--primary-text-color, #fff); }
  .stat-unit { font-size: 0.7em; font-weight: 400; color: var(--secondary-text-color, #999); }

  .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; padding-top: 8px; }
  .header-right-top { display: flex; gap: 20px; align-items: center; }
  .meta-item { font-size: 0.8em; color: var(--secondary-text-color, #999); }

  .shedding-legend { display: flex; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  .shedding-legend-item { display: inline-flex; align-items: center; gap: 3px; }
  .shedding-legend-item span-icon { --mdc-icon-size: 16px; }
  .shedding-legend-secondary { --mdc-icon-size: 12px; opacity: 0.8; }
  .shedding-legend-text { font-size: 9px; font-weight: 600; }
  .shedding-legend-label { font-size: 0.7em; color: var(--secondary-text-color, #999); }

  .panel-gear {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--secondary-text-color);
    opacity: 0.6;
    padding: 4px;
    margin-left: 8px;
    vertical-align: middle;
  }
  .panel-gear:hover { opacity: 1; }
  .header-center {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8px;
  }
  .panel-identity .panel-gear {
    margin-left: 0;
  }
  .slide-confirm {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 160px;
    height: 28px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--primary-color, #4dd9af) 20%, var(--secondary-background-color, #333));
    vertical-align: middle;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  .slide-confirm-text {
    position: absolute;
    width: 100%;
    text-align: center;
    font-size: 0.65em;
    font-weight: 600;
    color: var(--secondary-text-color, #999);
    pointer-events: none;
    z-index: 0;
  }
  .slide-confirm-knob {
    position: absolute;
    left: 2px;
    top: 2px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--secondary-text-color, #666);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    z-index: 1;
    transition: none;
  }
  .slide-confirm-knob span-icon {
    --mdc-icon-size: 14px;
    color: var(--card-background-color, #1c1c1c);
  }
  .slide-confirm-knob.snapping {
    transition: left 0.25s ease;
  }
  .slide-confirm.confirmed {
    background: color-mix(in srgb, var(--state-active-color, var(--span-accent)) 25%, transparent);
  }
  .slide-confirm.confirmed .slide-confirm-text {
    color: var(--state-active-color, var(--span-accent));
  }
  .slide-confirm.confirmed .slide-confirm-knob {
    background: var(--state-active-color, var(--span-accent));
  }
  .switches-disabled .toggle-pill {
    opacity: 0.3;
    pointer-events: none;
  }
  .unit-toggle {
    display: inline-flex;
    background: var(--secondary-background-color, #333);
    border-radius: 6px;
    overflow: hidden;
    margin-left: 8px;
  }
  .unit-btn {
    padding: 4px 10px;
    border: none;
    background: none;
    color: var(--secondary-text-color);
    font-size: 0.75em;
    font-weight: 600;
    cursor: pointer;
  }
  .unit-btn.unit-active {
    background: var(--primary-color, #4dd9af);
    color: var(--text-primary-color, #000);
  }

  .monitoring-summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 16px;
    font-size: 0.8em;
    background: rgba(76, 175, 80, 0.1);
    border: 1px solid var(--divider-color, #333);
    border-top: none;
  }
  .monitoring-active { color: #4caf50; }
  .monitoring-counts { display: flex; gap: 12px; }
  .count-warning { color: #ff9800; }
  .count-alert { color: #f44336; }
  .count-overrides { color: var(--secondary-text-color); }

  .panel-grid {
    display: grid;
    /* Five columns: left tab label, left cell, explicit 8px spacer,
       right cell, right tab label. Spacer is in-band rather than a
       column-gap so we can keep inter-cell space without paying an
       equal gap between each cell and its tab label. The tab columns
       are sized to fit a 2-digit breaker number (the font is 0.85em
       of the panel body ≈ 14px glyph width). */
    grid-template-columns: 14px 1fr 8px 1fr 14px;
    column-gap: 0;
    row-gap: 8px;
    align-items: stretch;
  }

  .tab-label {
    display: flex;
    align-items: center;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--secondary-text-color, #999);
    user-select: none;
  }
  .tab-left { justify-content: flex-start; }
  .tab-right { justify-content: flex-end; }

  .circuit-slot {
    background: var(--secondary-background-color, var(--card-background-color, #2a2a2a));
    border: 1px solid var(--divider-color, #333);
    border-radius: 12px;
    padding: 14px 16px 20px;
    min-height: 140px;
    transition: opacity 0.3s;
    position: relative;
    overflow: hidden;
  }

  .circuit-col-span { min-height: 280px; }
  .circuit-row-span { border-left: 3px solid var(--span-accent); }
  .circuit-off .circuit-name,
  .circuit-off .breaker-badge,
  .circuit-off .power-value,
  .circuit-off .chart-container { opacity: 0.35; }
  .circuit-off .toggle-pill,
  .circuit-off .gear-icon { opacity: 1; }

  .circuit-empty {
    opacity: 0.2;
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-style: dashed;
  }
  .empty-label { color: var(--secondary-text-color, #999); font-size: 0.85em; }

  .circuit-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 6px;
    gap: 8px;
  }

  .circuit-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }

  .breaker-badge {
    background: color-mix(in srgb, var(--span-accent) 15%, transparent);
    color: var(--span-accent);
    font-size: 0.7em;
    font-weight: 700;
    padding: 2px 3px;
    border-radius: 4px;
    white-space: nowrap;
    border: 1px solid color-mix(in srgb, var(--span-accent) 25%, transparent);
    flex-shrink: 0;
  }

  .circuit-name {
    font-size: 0.9em;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--primary-text-color, #e0e0e0);
  }

  .circuit-controls { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }

  /* Truncation-driven fold for By Panel breaker cells. The .is-folded
     class is added/removed by the JS observer in
     src/core/truncation-fold.ts when the .circuit-name actually
     ellipsizes. Pixel thresholds can't get this right because name
     length varies wildly per circuit (e.g. "Spa" vs
     "Commissioned PV System") — only measuring the live name vs its
     container catches the exact moment of truncation.

     When folded the nested flex wrappers (.circuit-header,
     .circuit-info, .circuit-controls, .circuit-status) collapse via
     'display: contents' so the leaf elements participate directly in
     the outer grid: name gets the whole first row, readings/controls/
     gear drop to a second row, chart stays as the full-width third. */
  .circuit-slot.is-folded {
    display: grid;
    /* Columns: badges + relay-toggle pack tight on the left, slack
       absorbed by the 1fr column between the relay and the power
       reading, keeping power + gear pinned to the right edge. The
       previous layout placed the slack between the shedding icon and
       the relay, which read as wasted padding the user pointed out. */
    grid-template-columns: auto auto auto auto 1fr auto auto;
    /* Rows: name and controls sized to content; chart absorbs any
       extra cell height. Without the explicit 1fr on row 3, a tall
       cell (e.g. .circuit-col-span's 280px min-height for 240V
       double-pole breakers) distributes excess space equally across
       all three rows via the default align-content:stretch, which
       pushes the chart down and vertically inflates the badge and
       relay toggle to fill the controls row. */
    grid-template-rows: auto auto 1fr;
    grid-template-areas:
      "name  name  name name   name name  name"
      "badge util  shed status .    power gear"
      "chart chart chart chart chart chart chart";
    row-gap: 6px;
    column-gap: 8px;
  }
  .circuit-slot.is-folded > .circuit-header,
  .circuit-slot.is-folded > .circuit-status,
  .circuit-slot.is-folded > .circuit-header > .circuit-info,
  .circuit-slot.is-folded > .circuit-header > .circuit-controls {
    display: contents;
  }
  .circuit-slot.is-folded .circuit-name {
    grid-area: name;
    justify-self: start;
  }
  .circuit-slot.is-folded .breaker-badge {
    grid-area: badge;
  }
  .circuit-slot.is-folded .utilization {
    grid-area: util;
  }
  .circuit-slot.is-folded .shedding-icon,
  .circuit-slot.is-folded .shedding-composite {
    grid-area: shed;
  }
  .circuit-slot.is-folded .toggle-pill {
    grid-area: status;
    justify-self: end;
  }
  .circuit-slot.is-folded .power-value {
    grid-area: power;
    justify-self: end;
  }
  .circuit-slot.is-folded .gear-icon.circuit-gear {
    grid-area: gear;
    justify-self: end;
  }
  .circuit-slot.is-folded > .chart-container {
    grid-area: chart;
  }

  .power-value { font-size: 0.9em; color: var(--primary-text-color, #fff); white-space: nowrap; }
  .power-value strong { font-weight: 700; font-size: 1.1em; }
  .power-unit { font-size: 0.8em; font-weight: 400; color: var(--secondary-text-color, #999); margin-left: 1px; }
  .circuit-producer .power-value strong { color: var(--info-color, #4fc3f7); }

  .toggle-pill {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 4px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 0.65em;
    font-weight: 600;
    transition: background 0.2s;
    user-select: none;
    min-width: 40px;
  }
  .toggle-on {
    padding-left: 6px;
    background: color-mix(in srgb, var(--state-active-color, var(--span-accent)) 25%, transparent);
    color: var(--state-active-color, var(--span-accent));
  }
  .toggle-off {
    padding-right: 6px;
    background: color-mix(in srgb, var(--secondary-text-color) 15%, transparent);
    color: var(--secondary-text-color, #999);
  }
  .toggle-knob {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    transition: background 0.2s, margin 0.2s;
  }
  .toggle-on .toggle-knob {
    background: var(--state-active-color, var(--span-accent));
    margin-left: auto;
  }
  .toggle-off .toggle-knob {
    background: var(--secondary-text-color, #999);
    margin-right: auto;
    order: -1;
  }

  .circuit-status {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    padding: 0 4px;
  }
  .shedding-icon { opacity: 0.8; cursor: default; }
  .shedding-composite {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .shedding-icon-secondary { opacity: 0.8; }
  .shedding-label {
    font-size: 10px;
    font-weight: 600;
    opacity: 0.8;
  }
  .gear-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    opacity: 0.6;
    transition: opacity 0.2s;
    margin-left: auto;
  }
  .gear-icon:hover { opacity: 1; }
  .utilization {
    font-size: 0.75em;
    font-weight: 600;
  }
  .utilization-normal { color: #4caf50; }
  .utilization-warning { color: #ff9800; }
  .utilization-alert { color: #f44336; }
  .circuit-alert {
    border-color: #f44336 !important;
    box-shadow: 0 0 8px rgba(244, 67, 54, 0.3);
  }
  .circuit-custom-monitoring {
    border-left: 3px solid #ff9800;
  }

  .chart-container {
    width: 100%;
    aspect-ratio: 4 / 1;
    margin-top: 4px;
    overflow: hidden;
    min-width: 0;
  }

  .sub-devices {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--divider-color, #333);
  }

  .sub-device {
    background: var(--secondary-background-color, var(--card-background-color, #2a2a2a));
    border: 1px solid var(--divider-color, #333);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .sub-device-bess,
  .sub-device-full {
    grid-column: 1 / -1;
  }

  .sub-device-header { display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
  .sub-device-type { font-size: 0.7em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--span-accent); }
  .sub-device-name { font-size: 0.85em; color: var(--secondary-text-color, #999); flex: 1; }
  .sub-power-value { font-size: 0.9em; color: var(--primary-text-color, #fff); white-space: nowrap; }
  .sub-power-value strong { font-weight: 700; font-size: 1.1em; }
  .sub-device .chart-container { margin-bottom: 8px; aspect-ratio: auto; }

  .bess-charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 10px;
  }
  .bess-chart-col { min-width: 0; }
  .bess-chart-title {
    font-size: 0.75em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--secondary-text-color, #999);
    margin-bottom: 4px;
  }
  .bess-chart-col .chart-container { aspect-ratio: auto; }
  .sub-entity { display: flex; gap: 6px; padding: 3px 0; font-size: 0.85em; }
  .sub-entity-name { color: var(--secondary-text-color, #999); }
  .sub-entity-value { font-weight: 500; color: var(--primary-text-color, #e0e0e0); }

  /* ── Shared tab bar ────────────────────────────────────── */

  .shared-tab-bar {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--divider-color, #333);
  }

  .shared-tab {
    padding: 8px 16px;
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 500;
    color: var(--primary-text-color);
    opacity: 0.6;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    transition: opacity 0.15s;
  }

  .shared-tab:hover {
    opacity: 0.85;
  }

  .shared-tab.active {
    opacity: 1;
    border-bottom-color: var(--span-accent);
  }

  /* ── List view search ──────────────────────────────────── */

  .list-search-container {
    margin-bottom: 12px;
    position: relative;
  }

  .list-search {
    width: 100%;
    padding: 8px 36px 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--divider-color, #333);
    background: var(--secondary-background-color, #2a2a2a);
    color: var(--primary-text-color);
    font-size: 0.9em;
    box-sizing: border-box;
    outline: none;
  }

  .list-search:focus {
    border-color: var(--span-accent);
  }

  .list-search-clear {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--secondary-text-color);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    opacity: 0.7;
  }

  .list-search-clear:hover {
    opacity: 1;
  }

  .list-unit-toggle {
    display: inline-flex;
    margin-bottom: 12px;
  }

  /* ── List rows ─────────────────────────────────────────── */

  .list-view {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Each circuit is wrapped in a .list-cell so the row + its optional
     expanded chart stay together. In single-column flex mode the cell
     just stacks naturally. In multi-column grid mode the cell becomes
     one grid item, so the chart is always in the same column as its
     row. Area headers (rendered as siblings, not inside a cell) span
     all columns via their inline "grid-column: 1 / -1". */
  .list-cell {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .list-view[data-columns="2"],
  .list-view[data-columns="3"] {
    display: grid;
    grid-template-columns: repeat(var(--list-cols), minmax(0, 1fr));
    gap: 6px 8px;
    flex-direction: initial;
  }
  /* On narrow viewports a 2/3-column list would squeeze rows into an
     unreadable shape, so force stacking regardless of user preference. */
  @media (max-width: 599px) {
    .list-view[data-columns="2"],
    .list-view[data-columns="3"] {
      display: flex;
      flex-direction: column;
    }
  }

  .list-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    gap: 10px;
    /* min-width: 0 lets the row shrink below the sum of its
       non-shrinking children when its parent .list-cell is in a
       narrow CSS-grid track (multi-column list mode). Without this
       the row would maintain its intrinsic min-content width and
       overflow the cell, leaving the name unshrunk and the
       truncation-fold observer with no signal to react to. */
    min-width: 0;
    background: var(--card-background-color, #1c1c1c);
    border: 1px solid var(--divider-color, #333);
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .list-row:hover {
    background: var(--secondary-background-color, #2a2a2a);
  }

  .list-row.circuit-off {
    opacity: 0.5;
  }

  .list-row.list-row-expanded {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }

  .list-circuit-name {
    flex: 1;
    color: var(--primary-text-color);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-status-badge {
    font-size: 0.75em;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .list-status-on {
    color: #4dd9af;
  }

  .list-status-off {
    color: #f44336;
  }

  .list-power-value {
    font-size: 0.9em;
    font-weight: 600;
    flex-shrink: 0;
    /* No min-width / text-align:right: the old 70px right-aligned
       cell left a visible blank column for short readings (e.g.
       "1.3A" in a 70px slot), which robbed horizontal space from
       .list-circuit-name on narrow rows. Let the value hug the
       preceding relay control and size to its content so the freed
       width flows back into the flex:1 name column. */
  }

  .list-expand-toggle {
    background: none;
    border: none;
    color: var(--secondary-text-color);
    cursor: pointer;
    padding: 4px;
    transition: transform 0.2s;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .list-expand-toggle.expanded {
    transform: rotate(180deg);
  }

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

  /* Truncation-driven fold for list rows. The .is-folded class is
     added/removed by the JS observer in src/core/truncation-fold.ts
     when the .list-circuit-name actually ellipsizes — pixel breakpoints
     can't track this because name length varies wildly per circuit
     ("Spa" vs "Commissioned PV System") and any single threshold
     misfires for the other end of the range. Switch to a two-row grid
     so the name gets the full width (paired only with the expand
     chevron) and the badges/controls/reading/gear drop to a secondary
     row underneath. Named areas keep the CSS readable despite the flat
     HTML child order. */
  .list-row.is-folded {
    display: grid;
    /* Row 1: name spans the row up to the chevron at the trailing
       column. Row 2: badge + util + shed + relay-toggle pack left,
       the 1fr column absorbs slack between the relay and the power
       reading, power + gear stay pinned to the right edge. The
       earlier layout placed the slack between the shedding icon and
       the relay, which the user flagged as wasted padding. */
    grid-template-columns: auto auto auto auto 1fr auto auto;
    grid-template-areas:
      "name  name name name   name  name  chevron"
      "badge util shed status .     power gear";
    row-gap: 6px;
    column-gap: 8px;
  }
  .list-row.is-folded > .list-circuit-name {
    grid-area: name;
    justify-self: start;
  }
  .list-row.is-folded > .list-expand-toggle {
    grid-area: chevron;
  }
  .list-row.is-folded > .breaker-badge {
    grid-area: badge;
  }
  .list-row.is-folded > .utilization {
    grid-area: util;
  }
  .list-row.is-folded > .shedding-icon,
  .list-row.is-folded > .shedding-composite {
    grid-area: shed;
  }
  .list-row.is-folded > .toggle-pill,
  .list-row.is-folded > .list-status-badge {
    grid-area: status;
  }
  .list-row.is-folded > .list-power-value {
    grid-area: power;
    justify-self: end;
  }
  .list-row.is-folded > .gear-icon.circuit-gear {
    grid-area: gear;
    justify-self: end;
  }

  /* ── Expanded circuit content ──────────────────────────── */

  .list-expanded-content {
    padding: 0;
    background: var(--card-background-color, #1c1c1c);
    border: 1px solid var(--divider-color, #333);
    border-top: none;
    border-radius: 0 0 8px 8px;
    margin-top: -6px;
    margin-bottom: 2px;
  }

  .circuit-slot.circuit-chart-only {
    border: none;
    margin: 0;
    background: none;
    padding: 8px 12px;
    min-height: 0;
  }

  /* ── Area headers ──────────────────────────────────────── */

  .area-header {
    padding: 16px 12px 6px;
    font-weight: 600;
    font-size: 0.85em;
    color: var(--secondary-text-color);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ── No results ────────────────────────────────────────── */

  .list-no-results {
    padding: 24px;
    text-align: center;
    color: var(--secondary-text-color);
  }

`;
