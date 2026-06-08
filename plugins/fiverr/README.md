# Fiverr

OpenTabs plugin for Fiverr — gives AI agents access to Fiverr through your authenticated browser session.

## Install

```bash
opentabs plugin install fiverr
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-fiverr
```

## Setup

1. Open [fiverr.com](https://www.fiverr.com) in Chrome and log in
2. Open the OpenTabs side panel — the Fiverr plugin should appear as **ready**

## Tools (8)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_page_context` | Identify the logged-in user and current page | Read |

### Gigs (2)

| Tool | Description | Type |
|---|---|---|
| `search_gigs` | Search Fiverr gigs by keyword | Read |
| `get_gig_details` | Get full details for a gig | Read |

### Sellers (1)

| Tool | Description | Type |
|---|---|---|
| `get_seller_profile` | Get a seller’s public profile | Read |

### Messages (4)

| Tool | Description | Type |
|---|---|---|
| `list_conversations` | List Fiverr inbox conversations | Read |
| `get_conversation` | Read a conversation thread | Read |
| `draft_message` | Compose a message preview without sending | Write |
| `send_message` | Send a message to a Fiverr user | Write |

## How It Works

This plugin runs inside your Fiverr tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
