# Google Calendar

OpenTabs plugin for Google Calendar — gives AI agents access to Google Calendar through your authenticated browser session.

## Install

```bash
opentabs plugin install google-calendar
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-google-calendar
```

## Setup

1. Open [calendar.google.com](https://calendar.google.com) in Chrome and log in
2. Open the OpenTabs side panel — the Google Calendar plugin should appear as **ready**

## Tools (18)

### Events (9)

| Tool | Description | Type |
|---|---|---|
| `list_events` | List events on a calendar | Read |
| `get_event` | Get a specific event by ID | Read |
| `create_event` | Create a new calendar event | Write |
| `update_event` | Update an existing event | Write |
| `delete_event` | Delete a calendar event | Write |
| `quick_add_event` | Create an event from natural language text | Write |
| `move_event` | Move an event to another calendar | Write |
| `list_event_instances` | List instances of a recurring event | Read |
| `search_events` | Search events across all calendars | Read |

### Calendars (5)

| Tool | Description | Type |
|---|---|---|
| `list_calendars` | List all calendars the user has access to | Read |
| `get_calendar` | Get calendar metadata by ID | Read |
| `create_calendar` | Create a new secondary calendar | Write |
| `update_calendar` | Update calendar metadata | Write |
| `delete_calendar` | Delete a secondary calendar | Write |

### Free/Busy (1)

| Tool | Description | Type |
|---|---|---|
| `query_freebusy` | Query free/busy information for calendars | Read |

### Settings (3)

| Tool | Description | Type |
|---|---|---|
| `list_settings` | List all user calendar settings | Read |
| `get_setting` | Get a specific user setting | Read |
| `get_colors` | Get available color definitions | Read |

## How It Works

This plugin runs inside your Google Calendar tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
