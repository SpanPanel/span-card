export const CARD_STYLES = `
  :host {
    --span-accent: var(--primary-color, #4dd9af);
  }

  ha-card {
    padding: 24px;
    background: var(--card-background-color, #1c1c1c);
    color: var(--primary-text-color, #e0e0e0);
    border-radius: var(--ha-card-border-radius, 12px);
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #333));
    box-shadow: var(--ha-card-box-shadow, none);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--divider-color, #333);
  }

  .panel-identity {
    display: flex;
    align-items: baseline;
    gap: 12px;
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
    gap: 32px;
  }

  .stat { display: flex; flex-direction: column; }
  .stat-label { font-size: 0.8em; color: var(--secondary-text-color, #999); margin-bottom: 2px; }
  .stat-row { display: flex; align-items: baseline; gap: 2px; }
  .stat-value { font-size: 1.5em; font-weight: 700; color: var(--primary-text-color, #fff); }
  .stat-unit { font-size: 0.7em; font-weight: 400; color: var(--secondary-text-color, #999); }

  .header-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; padding-top: 8px; align-self: stretch; }
  .header-right-top { display: flex; gap: 20px; align-items: center; }
  .meta-item { font-size: 0.8em; color: var(--secondary-text-color, #999); }

  .shedding-legend { display: flex; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
  .shedding-legend-item { display: inline-flex; align-items: center; gap: 3px; }
  .shedding-legend-item ha-icon { --mdc-icon-size: 16px; }
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
  .slide-confirm-knob ha-icon {
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
    grid-template-columns: 28px 1fr 1fr 28px;
    gap: 8px;
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
    padding: 2px 7px;
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
    margin-top: 4px;
  }

  .sub-devices {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--divider-color, #333);
  }

  .sub-device {
    margin-bottom: 12px;
    background: var(--secondary-background-color, var(--card-background-color, #2a2a2a));
    border: 1px solid var(--divider-color, #333);
    border-radius: 12px;
    padding: 14px 16px;
  }

  .sub-device-header { display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
  .sub-device-type { font-size: 0.7em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--span-accent); }
  .sub-device-name { font-size: 0.85em; color: var(--secondary-text-color, #999); flex: 1; }
  .sub-power-value { font-size: 0.9em; color: var(--primary-text-color, #fff); white-space: nowrap; }
  .sub-power-value strong { font-weight: 700; font-size: 1.1em; }
  .sub-device .chart-container { margin-bottom: 8px; }

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
  .bess-chart-col .chart-container { }
  .sub-entity { display: flex; gap: 6px; padding: 3px 0; font-size: 0.85em; }
  .sub-entity-name { color: var(--secondary-text-color, #999); }
  .sub-entity-value { font-weight: 500; color: var(--primary-text-color, #e0e0e0); }

  ha-card.narrow { padding: 12px; }
  .narrow .panel-header { flex-direction: column; }
  .narrow .panel-identity { flex-direction: column; gap: 4px; }
  .narrow .panel-title { font-size: 1.4em; }
  .narrow .panel-stats { gap: 16px; flex-wrap: wrap; }
  .narrow .header-center { margin-top: 8px; }
  .narrow .header-right { margin-top: 8px; align-items: flex-start; }
  .narrow .shedding-legend { justify-content: flex-start; }
  .narrow .circuit-slot { min-height: 100px; padding: 10px 12px 16px; }
  .narrow .circuit-col-span { min-height: 200px; }
  .narrow .chart-container { height: 60px; }
  .narrow .circuit-col-span .chart-container { height: 140px; }
`;
