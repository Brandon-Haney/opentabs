# Microsoft OneNote

OpenTabs plugin for Microsoft OneNote — gives AI agents access to Microsoft OneNote through your authenticated browser session.

## Install

```bash
opentabs plugin install onenote
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-onenote
```

## Setup

1. Open [onenote.cloud.microsoft](https://onenote.cloud.microsoft/) in Chrome and log in
2. Open the OpenTabs side panel — the Microsoft OneNote plugin should appear as **ready**

## Tools (12)

### Notebooks (4)

| Tool | Description | Type |
|---|---|---|
| `list_notebooks` | List all OneNote notebooks | Read |
| `get_notebook` | Get a notebook by ID | Read |
| `create_notebook` | Create a new notebook | Write |
| `get_recent_notebooks` | Get recently accessed notebooks | Read |

### Sections (3)

| Tool | Description | Type |
|---|---|---|
| `list_sections` | List sections in a notebook or across all notebooks | Read |
| `get_section` | Get a section by ID | Read |
| `create_section` | Create a new section in a notebook | Write |

### Section Groups (3)

| Tool | Description | Type |
|---|---|---|
| `list_section_groups` | List section groups in a notebook or across all notebooks | Read |
| `get_section_group` | Get a section group by ID | Read |
| `create_section_group` | Create a section group in a notebook | Write |

### Pages (1)

| Tool | Description | Type |
|---|---|---|
| `create_page` | Create a new page in a section with HTML content | Write |

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current user profile | Read |

## How It Works

This plugin runs inside your Microsoft OneNote tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
