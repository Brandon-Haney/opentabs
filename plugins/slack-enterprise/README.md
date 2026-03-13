# Slack Enterprise

OpenTabs plugin for Slack Enterprise Grid — gives AI agents access to your enterprise Slack workspace through your authenticated browser session.

> For standard (non-enterprise) Slack workspaces, use [`@opentabs-dev/opentabs-plugin-slack`](https://www.npmjs.com/package/@opentabs-dev/opentabs-plugin-slack) instead.

## Install

```bash
opentabs plugin install slack-enterprise
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-slack-enterprise
```

## Setup

1. Open [app.slack.com](https://app.slack.com) in Chrome and log in to your Enterprise Grid workspace
2. Open the OpenTabs side panel — the Slack Enterprise plugin should appear as **ready**

## Tools (40)

### Messages (7)

| Tool | Description | Type |
|---|---|---|
| `send_message` | Send a message to a channel or DM | Write |
| `read_messages` | Read messages from a channel with date filtering and pagination | Read |
| `read_thread` | Read thread replies including the parent message | Read |
| `reply_to_thread` | Reply to a specific message thread | Write |
| `react_to_message` | Add an emoji reaction to a message | Write |
| `update_message` | Edit an existing message | Write |
| `delete_message` | Delete a message from a channel | Write |

### Search (3)

| Tool | Description | Type |
|---|---|---|
| `search_messages` | Full-text search across channels with sort and pagination | Read |
| `search_files` | Search files by name or type | Read |
| `search_users` | Search users by name or email | Read |

### Channels (3)

| Tool | Description | Type |
|---|---|---|
| `list_channels` | List workspace channels with type filtering and pagination | Read |
| `get_channel_info` | Get channel details (topic, purpose, member count) | Read |
| `list_channel_members` | List member user IDs of a channel | Read |

### Conversations (11)

| Tool | Description | Type |
|---|---|---|
| `open_dm` | Open a 1:1 or group direct message conversation | Write |
| `create_channel` | Create a new public or private channel | Write |
| `archive_channel` | Archive a channel | Write |
| `unarchive_channel` | Restore an archived channel | Write |
| `set_channel_topic` | Update a channel's topic | Write |
| `set_channel_purpose` | Update a channel's purpose | Write |
| `invite_to_channel` | Add users to a channel | Write |
| `kick_from_channel` | Remove a user from a channel | Write |
| `rename_channel` | Rename a channel | Write |
| `join_channel` | Join a public channel | Write |
| `leave_channel` | Leave a channel | Write |

### Users (3)

| Tool | Description | Type |
|---|---|---|
| `get_user_info` | Get user profile details | Read |
| `list_users` | List workspace users with pagination | Read |
| `get_my_profile` | Get the authenticated user's own profile | Read |

### Files (3)

| Tool | Description | Type |
|---|---|---|
| `get_file_info` | Get file metadata and download URL | Read |
| `list_files` | List files with channel, user, and type filters | Read |
| `upload_file` | Upload a file to a channel (text or binary, max 20MB) | Write |

### Pins (3)

| Tool | Description | Type |
|---|---|---|
| `pin_message` | Pin a message to a channel | Write |
| `unpin_message` | Unpin a message from a channel | Write |
| `list_pins` | List all pinned items in a channel | Read |

### Stars (5)

| Tool | Description | Type |
|---|---|---|
| `star_message` | Star a message for quick access | Write |
| `star_file` | Star a file for quick access | Write |
| `unstar_message` | Remove a star from a message | Write |
| `unstar_file` | Remove a star from a file | Write |
| `list_stars` | List starred/saved items | Read |

### Reactions (2)

| Tool | Description | Type |
|---|---|---|
| `remove_reaction` | Remove an emoji reaction from a message | Write |
| `get_reactions` | Get all reactions on a message | Read |

## How It Works

This plugin runs inside your Enterprise Grid Slack tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens, OAuth apps, or bot users required. All operations happen as you, with your permissions.

Enterprise Grid workspaces store both an organization-level token and workspace-level tokens. This plugin automatically selects the correct token for each API call.

## License

MIT
