# Airbnb

OpenTabs plugin for Airbnb — gives AI agents access to Airbnb through your authenticated browser session.

## Install

```bash
opentabs plugin install airbnb
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-airbnb
```

## Setup

1. Open [airbnb.com](https://www.airbnb.com) in Chrome and log in
2. Open the OpenTabs side panel — the Airbnb plugin should appear as **ready**

## Tools (14)

### User (2)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the current Airbnb user profile | Read |
| `get_user_thumbnail` | Get a user thumbnail image by user ID | Read |

### Wishlists (3)

| Tool | Description | Type |
|---|---|---|
| `list_wishlists` | List wishlists for the current user | Read |
| `get_wishlist_items` | Get wishlists containing specific listings | Read |
| `remove_from_wishlist` | Remove listings from wishlists | Write |

### Messages (3)

| Tool | Description | Type |
|---|---|---|
| `list_message_threads` | List message threads from inbox | Read |
| `get_message_thread` | Get messages in a thread by thread ID | Read |
| `get_inbox_filters` | Get inbox filter categories with unread counts | Read |

### Search (2)

| Tool | Description | Type |
|---|---|---|
| `search_suggestions` | Get search autocomplete suggestions | Read |
| `get_search_results` | Extract search results from the current page | Read |

### Listings (1)

| Tool | Description | Type |
|---|---|---|
| `get_listing_from_page` | Extract listing details from the current page | Read |

### Navigation (2)

| Tool | Description | Type |
|---|---|---|
| `get_header_info` | Get header navigation and unread counts | Read |
| `is_host` | Check if the current user is a host | Write |

### Map (1)

| Tool | Description | Type |
|---|---|---|
| `get_map_viewport_info` | Get location name for a map viewport | Read |

## How It Works

This plugin runs inside your Airbnb tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
