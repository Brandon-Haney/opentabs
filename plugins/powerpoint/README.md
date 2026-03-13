# PowerPoint Online

OpenTabs plugin for Microsoft PowerPoint Online — gives AI agents access to PowerPoint Online through your authenticated browser session.

## Install

```bash
opentabs plugin install powerpoint
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-powerpoint
```

## Setup

1. Open [powerpoint.cloud.microsoft](https://powerpoint.cloud.microsoft) in Chrome and log in
2. Open the OpenTabs side panel — the PowerPoint Online plugin should appear as **ready**

## Tools (26)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current user profile | Read |

### Drive (1)

| Tool | Description | Type |
|---|---|---|
| `get_drive` | Get drive storage quota info | Read |

### Files (13)

| Tool | Description | Type |
|---|---|---|
| `list_children` | List files and folders in a directory | Read |
| `list_recent` | List recently accessed files | Read |
| `search_files` | Search files by name | Read |
| `list_shared_with_me` | List files shared with you | Read |
| `get_item` | Get details of a file or folder | Read |
| `get_download_url` | Get a download URL for a file | Read |
| `get_thumbnails` | Get thumbnail previews of a file | Read |
| `rename_item` | Rename a file or folder | Write |
| `delete_item` | Delete a file or folder | Write |
| `copy_item` | Copy a file to a new location | Write |
| `move_item` | Move a file or folder | Write |
| `create_folder` | Create a new folder | Write |
| `list_versions` | List version history of a file | Read |

### Presentations (2)

| Tool | Description | Type |
|---|---|---|
| `create_presentation` | Create a new blank presentation | Write |
| `get_preview_url` | Get an embeddable preview URL | Read |

### Slides (6)

| Tool | Description | Type |
|---|---|---|
| `get_slides` | List all slides with their text content | Read |
| `get_slide_content` | Get text and notes for a specific slide | Read |
| `update_slide_text` | Modify text on a slide | Write |
| `get_slide_notes` | Read speaker notes from a slide | Read |
| `update_slide_notes` | Modify speaker notes on a slide | Write |
| `delete_slide` | Remove a slide from a presentation | Write |

### Sharing (3)

| Tool | Description | Type |
|---|---|---|
| `list_permissions` | List sharing permissions for a file | Read |
| `create_sharing_link` | Create a sharing link for a file | Write |
| `delete_permission` | Remove a sharing permission | Write |

## How It Works

This plugin runs inside your PowerPoint Online tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
