# Confluence

OpenTabs plugin for Confluence — gives AI agents access to Confluence through your authenticated browser session.

## Install

```bash
opentabs plugin install confluence
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-confluence
```

## Setup

1. Open [atlassian.net](https://atlassian.net) in Chrome and log in
2. Open the OpenTabs side panel — the Confluence plugin should appear as **ready**

## Tools (19)

### Spaces (2)

| Tool | Description | Type |
|---|---|---|
| `list_spaces` | List available spaces | Read |
| `get_space` | Get a space by ID | Read |

### Pages (9)

| Tool | Description | Type |
|---|---|---|
| `list_pages` | List pages in a space | Read |
| `get_page` | Get a page by ID | Read |
| `create_page` | Create a new page | Write |
| `update_page` | Update an existing page | Write |
| `delete_page` | Delete a page by ID | Write |
| `get_page_children` | List child pages of a page | Read |
| `list_page_attachments` | List attachments on a page | Read |
| `get_attachment` | Save an attachment to a path | Read |
| `list_page_versions` | List page version history | Read |

### Search (1)

| Tool | Description | Type |
|---|---|---|
| `search` | Search content using CQL | Write |

### Comments (3)

| Tool | Description | Type |
|---|---|---|
| `list_comments` | List comments on a page | Read |
| `create_comment` | Add a comment to a page | Write |
| `delete_comment` | Delete a comment from a page | Write |

### Labels (3)

| Tool | Description | Type |
|---|---|---|
| `list_labels` | List labels on a page | Read |
| `add_label` | Add a label to a page | Write |
| `remove_label` | Remove a label from a page | Write |

### Users (1)

| Tool | Description | Type |
|---|---|---|
| `get_user_profile` | Get a user profile | Read |

## How It Works

This plugin runs inside your Confluence tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
