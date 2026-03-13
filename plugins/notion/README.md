# Notion

OpenTabs plugin for Notion — gives AI agents access to Notion through your authenticated browser session.

## Install

```bash
opentabs plugin install notion
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-notion
```

## Setup

1. Open [notion.so](https://www.notion.so) in Chrome and log in
2. Open the OpenTabs side panel — the Notion plugin should appear as **ready**

## Tools (18)

### Pages (8)

| Tool | Description | Type |
|---|---|---|
| `search` | Search pages and blocks | Write |
| `list_pages` | List pages in the workspace | Read |
| `get_page` | Get a page with its content | Read |
| `create_page` | Create a new page | Write |
| `update_page` | Update a page's title, icon, or cover | Write |
| `delete_page` | Archive a page to trash | Write |
| `update_block` | Update a block's text content | Write |
| `delete_block` | Delete a block from a page | Write |

### Blocks (2)

| Tool | Description | Type |
|---|---|---|
| `get_block_children` | Get child blocks of a block or page | Read |
| `append_block` | Append content to a page | Write |

### Users (2)

| Tool | Description | Type |
|---|---|---|
| `get_user` | Get a user's profile | Read |
| `list_users` | List workspace members | Read |

### Databases (6)

| Tool | Description | Type |
|---|---|---|
| `get_database` | Get a database schema | Read |
| `query_database` | Query rows from a database | Read |
| `create_database_item` | Add a row to a database | Write |
| `update_database_item` | Update a database row by setting property values | Write |
| `list_databases` | List databases in the workspace | Read |
| `create_database` | Create a new database | Write |

## How It Works

This plugin runs inside your Notion tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
