# Microsoft Teams

OpenTabs plugin for Microsoft Teams — gives AI agents access to Microsoft Teams through your authenticated browser session.

## Install

```bash
opentabs plugin install teams
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-teams
```

## Setup

1. Open [teams.live.com](https://teams.live.com/v2/) in Chrome and log in
2. Open the OpenTabs side panel — the Microsoft Teams plugin should appear as **ready**

## Tools (11)

### Chats (4)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List recent chats | Read |
| `get_conversation_details` | Get chat details and members | Read |
| `create_chat` | Create a new chat conversation | Write |
| `set_channel_topic` | Set a chat topic | Write |

### Messages (4)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a message to a chat | Write |
| `read_messages` | Read messages from a chat | Read |
| `edit_message` | Edit a chat message | Write |
| `delete_message` | Delete a chat message | Write |

### Members (2)

| Tool | Description | Type |
|---|---|---|
| `invite_to_channel` | Add a user to a group chat | Write |
| `remove_member` | Remove a user from a group chat | Write |

### People (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get current user info | Read |

## How It Works

This plugin runs inside your Microsoft Teams tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
