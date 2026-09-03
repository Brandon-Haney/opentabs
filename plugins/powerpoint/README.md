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

## Tools (58)

### Account (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current user profile | Read |
| `reauthenticate` | Clear stale MSAL state and reload the tab to force a fresh Graph token | Write |
| `diagnose` | Read-only Microsoft Graph connectivity and auth check — token sources (no values), drive resolution, reload marker, single-attempt Graph probes (`/me`, and `/shares` on SharePoint when the drive id is unknown) | Read |

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

### Presentations (3)

| Tool | Description | Type |
|---|---|---|
| `create_presentation` | Create a new blank presentation | Write |
| `get_preview_url` | Get an embeddable preview URL | Read |
| `open_in_editor` | Open a deck in the web editor for live editing | Write |

### Sessions (4)

Batched editing. Open a session once, run many edit tools against an in-memory copy, then commit a single upload — instead of paying the download/upload round-trip on every edit.

| Tool | Description | Type |
|---|---|---|
| `open_presentation` | Open a batched edit session for a presentation | Read |
| `commit_presentation` | Commit pending session edits with eTag safety | Write |
| `discard_presentation` | Throw away a session without saving | Write |
| `list_presentation_sessions` | List all open batched edit sessions | Read |

### Slides (31)

Live tools (marked *co-authoring*) edit the deck that is open in the web editor through its co-authoring session, so the change appears for every editor immediately. The remaining tools read and write the saved PPTX package through Microsoft Graph.

| Tool | Description | Type |
|---|---|---|
| `get_slide_structure` | Get a slide as named slots (title, body) rather than shapes | Read |
| `set_placeholder_text` | Write text into a slide slot by role (title, body) | Write |
| `get_live_outline` | Read the open deck's live text, formatting, and structure (co-authoring) | Read |
| `set_text` | Replace slide text by its current content, keeping the formatting (co-authoring) | Write |
| `set_font_size` | Resize slide text by its visible content (co-authoring) | Write |
| `format_text` | Format slide text (size/bold/italic/underline/color/font) by its content (co-authoring) | Write |
| `align_text` | Align a paragraph in the open deck (co-authoring) | Write |
| `add_slide_live` | Add a slide to the open deck (co-authoring) | Write |
| `delete_slide_live` | Delete a slide from the open deck (co-authoring) | Write |
| `move_slide_live` | Reorder a slide in the open deck (co-authoring) | Write |
| `set_slide_background` | Set a slide's background colour in the open deck (co-authoring) | Write |
| `list_slide_layouts` | List the layouts available for new slides | Read |
| `add_slide` | Create a new slide from a layout | Write |
| `delete_slide` | Remove a slide from a presentation | Write |
| `duplicate_slide` | Clone an existing slide in place | Write |
| `move_slide` | Reorder a slide within the deck | Write |
| `set_slide_hidden` | Hide a slide from the slide show, or restore it | Write |
| `get_slides` | List all slides with their text content | Read |
| `get_slide_content` | Get text and notes for a specific slide | Read |
| `get_slide_layout` | Get the structural layout of a slide (shapes, positions, text, fill) | Read |
| `add_text_box` | Add a new text box to a slide | Write |
| `add_shape` | Add a preset shape (rectangle, ellipse, arrow, ...) to a slide | Write |
| `add_image` | Insert an image onto a slide | Write |
| `add_table` | Add a data-filled table to a slide | Write |
| `update_shape` | Edit a shape's text, geometry, rotation, or fill | Write |
| `fit_text` | Write text at the largest size that fits the shape | Write |
| `delete_shape` | Remove a shape from a slide | Write |
| `duplicate_shape` | Clone a shape in place | Write |
| `get_slide_notes` | Read speaker notes from a slide | Read |
| `update_slide_notes` | Modify speaker notes on a slide | Write |
| `get_comments` | Read reviewer comments and threaded replies | Read |

### Sharing (3)

| Tool | Description | Type |
|---|---|---|
| `list_permissions` | List sharing permissions for a file | Read |
| `create_sharing_link` | Create a sharing link for a file | Write |
| `delete_permission` | Remove a sharing permission | Write |

## Reading comments

`get_comments` returns reviewer comments with their author, timestamp, threaded replies, and the id of the shape each one is anchored to. That `anchor_shape_id` matches the shape ids from `get_slide_layout`, so an agent can go from "what did Scott object to" to the exact table or text box on the slide.

Microsoft Graph exposes no comments API for PowerPoint at any version, and Office.js has no `PowerPoint.Comment` — so this reads the comment parts out of the PPTX package directly. Two consequences worth knowing:

- **Only comments in the last saved version are visible.** A comment posted seconds ago may not appear until PowerPoint flushes it to the file.
- **Resolved and deleted comments are gone.** PowerPoint removes them from the package rather than flagging them, so no tool can recover them from the file.

## How It Works

This plugin runs inside your PowerPoint Online tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

On SharePoint- and OneDrive-hosted presentations the Microsoft Graph token is captured from the page's AAD round-trip on load. The page only mints that token on a cold load, so on a tab left open for more than about an hour the token expires and tools return an auth error — call `reauthenticate` to reload the tab and capture a fresh one.

## License

MIT
