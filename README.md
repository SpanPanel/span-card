# SPAN Panel Card

A custom Lovelace card for Home Assistant that renders a physical representation of a SPAN electrical panel, showing circuits laid out by their actual tab positions.

## Features

- Two-column grid matching the physical panel layout (odd tabs left, even tabs right)
- 240V circuits span both columns
- Live power readings with utilization bar
- Breaker rating badges
- Relay on/off status indicators
- EVSE and BESS sub-device sections
- Auto-discovers all circuit entities from a single device selection

## Requirements

- [SPAN Panel integration](https://github.com/SpanPanel/span) installed and configured
- Circuits must have `tabs` attributes (included in SPAN Panel integration v1.2+)

## Installation

### Manual

1. Copy `span-panel-card.js` to your `config/www/` directory
2. Add the resource in HA: Settings > Dashboards > Resources > Add:
   - URL: `/local/span-panel-card.js`
   - Type: JavaScript Module

### HACS (coming soon)

Not yet available in HACS.

## Configuration

Add the card to a dashboard:

```yaml
type: custom:span-panel-card
device_id: <your_span_panel_device_id>
```

To find your device ID:
1. Go to Settings > Devices
2. Click your SPAN Panel device
3. The device ID is in the URL: `/config/devices/device/<device_id>`

## Data Sources

The card reads the following from the SPAN Panel integration:

| Data | Source |
|---|---|
| Panel position | `tabs` attribute on circuit sensors |
| Power (W) | Circuit power sensor state |
| Breaker rating (A) | Circuit breaker rating sensor state |
| Relay on/off | `relay_state` attribute / switch entity |
| Voltage | `voltage` attribute (120V or 240V) |
| Panel size | `panel_size` attribute on status sensor |
| EVSE / BESS | Sub-devices discovered via `via_device_id` |
