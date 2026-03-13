# Costco

OpenTabs plugin for Costco Wholesale — gives AI agents access to Costco through your authenticated browser session.

## Install

```bash
opentabs plugin install costco
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-costco
```

## Setup

1. Open [costco.com](https://www.costco.com) in Chrome and log in
2. Open the OpenTabs side panel — the Costco plugin should appear as **ready**

## Tools (16)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get logged-in member profile | Read |

### Products (3)

| Tool | Description | Type |
|---|---|---|
| `search_products` | Extract and enrich products from the current search page | Read |
| `get_product` | Get product details by item number | Read |
| `get_products` | Get multiple products by item numbers | Read |

### Inventory (1)

| Tool | Description | Type |
|---|---|---|
| `get_product_availability` | Check product inventory and availability | Read |

### Locations (1)

| Tool | Description | Type |
|---|---|---|
| `geocode_location` | Convert ZIP/city to coordinates | Write |

### Lists (6)

| Tool | Description | Type |
|---|---|---|
| `get_lists` | Get shopping lists | Read |
| `get_list_items` | Get items in a shopping list | Read |
| `create_list` | Create a new shopping list | Write |
| `add_to_list` | Add a product to a shopping list | Write |
| `remove_list_item` | Remove an item from a shopping list | Write |
| `delete_list` | Delete a shopping list | Write |

### Navigation (4)

| Tool | Description | Type |
|---|---|---|
| `navigate_to_product` | Open a product page in the browser | Write |
| `navigate_to_search` | Open search results in the browser | Write |
| `navigate_to_cart` | Open the shopping cart page | Write |
| `navigate_to_checkout` | Open the checkout page | Write |

## How It Works

This plugin runs inside your Costco tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
