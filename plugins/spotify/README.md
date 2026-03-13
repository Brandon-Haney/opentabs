# Spotify

OpenTabs plugin for Spotify — gives AI agents access to Spotify through your authenticated browser session.

## Install

```bash
opentabs plugin install spotify
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-spotify
```

## Setup

1. Open [open.spotify.com](https://open.spotify.com) in Chrome and log in
2. Open the OpenTabs side panel — the Spotify plugin should appear as **ready**

## Tools (21)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get current Spotify user profile | Read |

### Browse (1)

| Tool | Description | Type |
|---|---|---|
| `search` | Search Spotify catalog | Write |

### Artists (1)

| Tool | Description | Type |
|---|---|---|
| `get_artist` | Get artist details and top tracks | Read |

### Albums (1)

| Tool | Description | Type |
|---|---|---|
| `get_album` | Get album details with tracks | Read |

### Playlists (1)

| Tool | Description | Type |
|---|---|---|
| `get_playlist` | Get playlist details with tracks | Read |

### Library (1)

| Tool | Description | Type |
|---|---|---|
| `get_saved_tracks` | Get saved tracks from library | Read |

### Playback (15)

| Tool | Description | Type |
|---|---|---|
| `get_playback_state` | Get current playback state | Read |
| `get_currently_playing` | Get the currently playing track | Read |
| `start_playback` | Start or resume playback | Write |
| `pause_playback` | Pause playback | Write |
| `skip_to_next` | Skip to next track | Write |
| `skip_to_previous` | Skip to previous track | Write |
| `seek_to_position` | Seek to a position in the current track | Write |
| `set_volume` | Set playback volume | Write |
| `set_repeat_mode` | Set repeat mode (off, context, or track) | Write |
| `toggle_shuffle` | Enable or disable shuffle mode | Write |
| `get_available_devices` | List available Spotify playback devices | Read |
| `transfer_playback` | Transfer playback to a different device | Write |
| `add_to_queue` | Add a track or episode to the playback queue | Write |
| `get_queue` | Get the current playback queue | Read |
| `get_recently_played` | Get recently played tracks | Read |

## How It Works

This plugin runs inside your Spotify tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
