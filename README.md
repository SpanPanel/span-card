# SPAN Panel Card

A custom Lovelace card for Home Assistant that renders a physical representation of a SPAN electrical panel, showing circuits laid out by their actual tab
positions.

![SPAN Panel Card](images/config.png)

## Features

- Two-column grid matching the physical panel layout (odd tabs left, even tabs right)
- 240V circuits span both columns
- Live power readings with utilization bar
- Breaker rating badges, showing the panel's rating
- Relay on/off status indicators
- Historical power/current charts per circuit
- EVSE, BESS, Solar and solar inverter sub-device sections
- Auto-discovers all circuit entities from a single device selection

## Requirements

- [SPAN Panel integration](https://github.com/SpanPanel/span) **v2.0.5 or later** installed and configured
- Circuits must have `tabs` attributes (included in SPAN Panel integration v1.2+)

## Installation

As of SPAN Panel integration **v2.0.5**, this card is automatically registered as a Lovelace resource by the integration itself — no separate installation is
required. The integration serves the card JS from its own static path and writes the resource entry on setup.

> **Migrating from HACS or manual install?** If you previously installed this card via HACS or manually copied `span-panel-card.js` to your `www/` directory,
> you should:
>
> 1. Remove the HACS-managed dashboard resource (HACS > Dashboard > SPAN Panel Card > Remove) — or delete the manual `/local/span-panel-card.js` resource from
>    **Settings > Dashboards > Resources**
> 2. Remove `span-panel-card.js` from your `config/www/` directory if present
> 3. Restart Home Assistant
>
> The integration will register its own copy of the card automatically on next startup.

## Configuration

The card includes a visual editor accessible through the dashboard UI. You can also configure it manually in YAML.

### Minimal Configuration

```yaml
type: custom:span-panel-card
device_id: <your_span_panel_device_id>
```

### Full Configuration

```yaml
type: custom:span-panel-card
device_id: <your_span_panel_device_id>
history_days: 0
history_hours: 0
history_minutes: 5
chart_metric: power
show_panel: true
show_battery: true
show_evse: true
show_solar: true
```

### Options

| Option                 | Type    | Default        | Description                                                                       |
| ---------------------- | ------- | -------------- | --------------------------------------------------------------------------------- |
| `device_id`            | string  | **(required)** | The Home Assistant device ID of your SPAN Panel                                   |
| `history_days`         | integer | `0`            | Number of days of history to display in charts (0-30)                             |
| `history_hours`        | integer | `0`            | Number of hours of history to display in charts (0-23)                            |
| `history_minutes`      | integer | `5`            | Number of minutes of history to display in charts (0-59)                          |
| `chart_metric`         | string  | `power`        | Metric to display on circuit charts: `power` or `current`                         |
| `show_panel`           | boolean | `true`         | Show the panel circuits grid                                                      |
| `show_battery`         | boolean | `true`         | Show battery (BESS) sub-device section                                            |
| `show_evse`            | boolean | `true`         | Show EV charger (EVSE) sub-device section                                         |
| `show_solar`           | boolean | `true`         | Show the Solar and solar inverter tiles                                           |
| `visible_sub_entities` | object  | `{}`           | Map of entity IDs to booleans controlling which sub-device entities are displayed |

### Solar and Inverter Tiles

Each solar inverter has a tile with its vendor and model, and the power and chart of the circuit that feeds it. The Solar tile is the first inverter's tile,
with the site's total PV power in a **Site total** row beneath it; on a single-inverter site the two numbers are usually close. Where no single panel circuit
feeds the Solar device's inverter, its headline is the site total, captioned **Site total**. An inverter that no panel circuit feeds shows its identity and that
its output is included in the site total. The editor's Battery section now also offers Meter Power and Nameplate Capacity.

### Copying a Tandem's Ratings from the SPAN App

SPAN Panel MAIN 32 panels report a tandem, two breakers in one space, as one circuit with only the first breaker's rating, while one sensor reads both breakers
together. A 20-20 tandem shows 20 A and can carry 40 A, so current monitoring raises false alerts on it. Copy the second rating from the SPAN app, and
monitoring judges that space against both breakers together: 40 A for a 20-20. Only monitoring uses the copy; the Breaker Rating sensor and the breaker labels
keep showing the panel's rating.

You can copy it in either of two places, which always show the same copy:

- **The Monitoring tab's Rating column**, for several circuits at once. Instructions above the table, **Tandem breakers on SPAN Panel MAIN 32**, say what to
  copy. A circuit that takes a copy shows the panel's rating and a field, `20 A + [  ]`: type the second rating your SPAN app shows for it, and leave the field
  empty for a circuit with a single breaker. While the copy applies, the cell adds what monitoring judges against, `= 40 A`, and ✕ beside the field removes the
  copy. A row with monitoring off keeps its field, dimmed, so you can copy every tandem before turning their monitoring on.
- **A circuit's Monitoring section**, in the side panel opened from its gear in the sidebar dashboard, while monitoring is on for that circuit. **Breaker
  ratings from the SPAN app** shows the panel's rating, read-only, and one field: "If your SPAN app shows two ratings for this circuit, such as 20-20A, enter
  the second one here." **Remove copied ratings** removes the copy, and the section says what the circuit is judged against: "Judged against 40 A: 20-20 from
  your SPAN app (the panel publishes 20 A)". The section is not part of the Lovelace card or the list tabs.

A field saves when you press Enter or leave it, never while you type, and only a whole number of amps of 1 or more; anything else is marked for correction.
Threshold and duration fields save the same way, with a whole number in their range. Every open view shows a changed copy, whether the change came from this
browser, another one or a service call, and a field you are typing in keeps what you typed.

A circuit across two spaces takes the copy the same way, if your SPAN app shows two ratings for it, such as 20-30A. SPAN Panel MAIN 32 panels report only the
average of such a circuit's two legs, which can hide an overloaded leg, so the copy is kept but not applied, and both places recommend turning monitoring off
for that circuit, with a **Turn off monitoring** button.

Thresholds are percentages of the rating a circuit is judged against. If you raised a tandem's thresholds above 100% to stop its alerts, they now apply to both
breakers together, which can let a real overload pass, so both places warn of it. For the circuit's own thresholds, select **Reset** on its row in the table, or
**Use global thresholds** in its Monitoring section; for the global ones, change them under **Global Settings**. Copying changes no threshold, and resetting
thresholds leaves the copy alone.

On panels other than MAIN 32 nothing needs copying, and no field is shown: those panels report each circuit of a multi-load breaker with its own rating, and the
integration judges circuits that share a meter against their capacity together. Nor is a field shown with an integration that predates copied ratings.

### Finding Your Device ID

1. Go to **Settings > Devices & Services**
2. Click your SPAN Panel device
3. The device ID is in the URL: `/config/devices/device/<device_id>`

### History Duration

When `history_days` or `history_hours` are set, `history_minutes` defaults to `0` unless explicitly provided. When neither is set, `history_minutes` defaults to
`5`.

## Data Sources

The card reads the following from the SPAN Panel integration:

| Data                | Source                                     |
| ------------------- | ------------------------------------------ |
| Panel position      | `tabs` attribute on circuit sensors        |
| Power (W)           | Circuit power sensor state                 |
| Breaker rating (A)  | Circuit breaker rating sensor state        |
| Relay on/off        | `relay_state` attribute / switch entity    |
| Voltage             | `voltage` attribute (120V or 240V)         |
| Panel size          | `panel_size` attribute on status sensor    |
| EVSE / BESS / Solar | Sub-devices discovered via `via_device_id` |
