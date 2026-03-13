# Google Maps

OpenTabs plugin for Google Maps — gives AI agents access to Google Maps through your authenticated browser session.

## Install

```bash
opentabs plugin install google-maps
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-google-maps
```

## Setup

1. Open [www.google.com](https://www.google.com/maps) in Chrome and log in
2. Open the OpenTabs side panel — the Google Maps plugin should appear as **ready**

## Tools (16)

### Map (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_view` | Get current map center, zoom, and query | Read |
| `zoom_map` | Zoom in or out on the map | Write |
| `toggle_layer` | Toggle traffic/transit/biking/terrain layer | Write |

### Search (2)

| Tool | Description | Type |
|---|---|---|
| `search_places` | Search for places near a location | Read |
| `search_nearby` | Search by category near coordinates | Read |

### Places (1)

| Tool | Description | Type |
|---|---|---|
| `get_place_details` | Get place info by name or address | Read |

### Navigation (4)

| Tool | Description | Type |
|---|---|---|
| `navigate_to_directions` | Open directions between two points | Write |
| `navigate_to_location` | Pan the map to specific coordinates | Write |
| `navigate_to_search` | Open search results on the map | Write |
| `navigate_to_place` | Open a place on the map | Write |

### Directions (2)

| Tool | Description | Type |
|---|---|---|
| `get_directions_info` | Read current directions from the map | Read |
| `set_travel_mode` | Switch driving/transit/walking/biking | Write |

### Sharing (4)

| Tool | Description | Type |
|---|---|---|
| `share_location` | Get a shareable Maps link | Write |
| `get_map_url` | Build a Maps URL without navigating | Read |
| `get_place_url` | Generate a shareable place link | Read |
| `get_directions_url` | Generate a shareable directions link | Read |

## How It Works

This plugin runs inside your Google Maps tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
