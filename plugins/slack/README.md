# Slack

OpenTabs plugin for Slack (standard workspaces). For Enterprise Grid, use slack-enterprise. — gives AI agents access to Slack through your authenticated browser session.

## Install

```bash
opentabs plugin install slack
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-slack
```

## Setup

1. Open [slack.com](https://app.slack.com) in Chrome and log in
2. Open the OpenTabs side panel — the Slack plugin should appear as **ready**

## Tools (22)

### Messages (6)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a message to a channel or thread | Write |
| `edit_message` | Edit an existing message | Write |
| `delete_message` | Delete a message from a channel | Write |
| `read_messages` | Read recent messages from a channel | Read |
| `read_thread` | Read replies in a thread | Read |
| `search_messages` | Search messages across channels | Read |

### Channels (5)

| Tool | Description | Type |
|---|---|---|
| `list_channels` | List workspace channels | Read |
| `get_channel_info` | Get detailed information about a channel | Read |
| `create_channel` | Create a new channel | Write |
| `set_channel_topic` | Set the topic of a channel | Write |
| `set_channel_purpose` | Set the purpose of a channel | Write |

### Users (4)

| Tool | Description | Type |
|---|---|---|
| `invite_to_channel` | Invite a user to a channel | Write |
| `list_members` | List members of a channel | Read |
| `get_user_profile` | Get a user's profile information | Read |
| `list_users` | List workspace users | Read |

### DMs (1)

| Tool | Description | Type |
|---|---|---|
| `open_dm` | Open a direct message conversation | Write |

### Files (2)

| Tool | Description | Type |
|---|---|---|
| `upload_file` | Upload a file to a channel | Write |
| `list_files` | List files in a channel or workspace | Read |

### Reactions (4)

| Tool | Description | Type |
|---|---|---|
| `add_reaction` | Add an emoji reaction to a message | Write |
| `remove_reaction` | Remove an emoji reaction from a message | Write |
| `pin_message` | Pin a message to a channel | Write |
| `unpin_message` | Unpin a message from a channel | Write |

## How It Works

This plugin runs inside your Slack tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
