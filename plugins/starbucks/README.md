# Starbucks

OpenTabs plugin for Starbucks — manage rewards, find stores, browse the menu, and view your account — gives AI agents access to Starbucks through your authenticated browser session.

## Install

```bash
opentabs plugin install starbucks
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-starbucks
```

## Setup

1. Open [starbucks.com](https://www.starbucks.com/account/for-you) in Chrome and log in
2. Open the OpenTabs side panel — the Starbucks plugin should appear as **ready**

## Tools (20)

### Account (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get current user profile and rewards info | Read |
| `get_cards` | List all Starbucks cards and balances | Read |
| `get_payment_methods` | List all payment methods in wallet | Read |

### Rewards (2)

| Tool | Description | Type |
|---|---|---|
| `get_rewards` | Get Stars balance and available reward tiers | Read |
| `get_earn_rates` | Get Stars earn rates by payment type | Read |

### Feed (1)

| Tool | Description | Type |
|---|---|---|
| `get_feed` | Get personalized promotions and offers feed | Read |

### Stores (2)

| Tool | Description | Type |
|---|---|---|
| `find_stores` | Find nearby Starbucks stores by coordinates | Read |
| `toggle_favorite_store` | Add or remove a store from favorites | Write |

### Menu (2)

| Tool | Description | Type |
|---|---|---|
| `get_store_menu` | Get menu categories for a store | Read |
| `get_product` | Get product details by number and form | Read |

### Orders (6)

| Tool | Description | Type |
|---|---|---|
| `get_previous_orders` | List previous orders | Read |
| `get_favorite_products` | List favorite menu products | Read |
| `add_favorite_product` | Save a product to favorites | Write |
| `delete_favorite_product` | Remove a product from favorites | Write |
| `get_store_time_slots` | Get available pickup time slots | Read |
| `price_order` | Calculate order price without placing it | Write |

### Cart (4)

| Tool | Description | Type |
|---|---|---|
| `get_cart` | View current cart contents | Read |
| `add_product_to_cart` | Add a product to the cart | Write |
| `update_product_quantity` | Change cart item quantity or remove it | Write |
| `navigate_to_checkout` | Go to cart page for checkout | Write |

## How It Works

This plugin runs inside your Starbucks tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
