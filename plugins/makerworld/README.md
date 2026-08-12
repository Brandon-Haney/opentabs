# MakerWorld

OpenTabs plugin for MakerWorld — gives AI agents access to MakerWorld through your authenticated browser session.

## Install

```bash
opentabs plugin install makerworld
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-makerworld
```

## Setup

1. Open [makerworld.com](https://makerworld.com) in Chrome and log in
2. Open the OpenTabs side panel — the MakerWorld plugin should appear as **ready**

## Tools (22)

### Points (8)

| Tool | Description | Type |
|---|---|---|
| `get_points_summary` | Get the current point balance | Read |
| `get_points_progress` | Progress and caps for point-earning tasks | Read |
| `list_transactions` | List point earning and spending history | Read |
| `list_shops` | List regional point shop stores | Read |
| `list_shop_products` | List point shop products and their point costs | Read |
| `list_redemptions` | List past point redemptions | Read |
| `get_cash_redemption_info` | Get the exclusive-point cash-out rate and limits | Read |
| `redeem_product` | Spend points on a point shop product (irreversible) | Write |

### Analytics (3)

| Tool | Description | Type |
|---|---|---|
| `list_model_stats` | Per-model performance metrics for a date range | Read |
| `list_profile_stats` | Per-print-profile performance metrics for a date range | Read |
| `get_analytics_timeseries` | Metric series over time for the account, a model, or a profile | Read |

### Models (3)

| Tool | Description | Type |
|---|---|---|
| `list_my_models` | List your published models with lifetime totals | Read |
| `get_model` | Get full detail for one model | Read |
| `set_model_visibility` | Take a model offline or bring it back online | Write |

### Uploads (4)

| Tool | Description | Type |
|---|---|---|
| `upload_model` | Upload model files and create an unpublished draft | Write |
| `list_drafts` | List unpublished model drafts | Read |
| `publish_draft` | Publish a draft model publicly | Write |
| `delete_draft` | Permanently delete an unpublished draft | Write |

### Account (3)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the signed-in account profile | Read |
| `update_profile` | Update your public profile and privacy settings | Write |
| `list_notifications` | List account notifications | Read |

### Reference (1)

| Tool | Description | Type |
|---|---|---|
| `list_licenses` | List licenses available for models | Read |

## How It Works

This plugin runs inside your MakerWorld tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## Uploading Models

`upload_model` creates a **draft** — it never publishes. Review the draft on MakerWorld, then release it with
`publish_draft`, or discard it with `delete_draft`.

Files are supplied as base64 (`content_base64`) or as an **https** URL (`source_url`). Plain-http URLs, including
loopback addresses such as `http://127.0.0.1`, cannot be used: MakerWorld sends a
`connect-src 'self' https:` content security policy together with `block-all-mixed-content`, so the page is not
permitted to fetch them. Since base64 travels through the tool call itself, this route is practical up to a few
megabytes — upload larger models through the MakerWorld web interface.

## Points and Redemption

Point balances are split into **regular** and **exclusive** points. Only exclusive points can be redeemed for cash
or gift cards; regular points are limited to the point shop. `get_points_summary` reports the split,
`get_cash_redemption_info` gives the per-point cash rate, and `list_shop_products` gives each item's point cost —
comparing the two shows which redemption route returns more value per point.

`redeem_product` spends points irreversibly and MakerWorld does not reverse redemptions. Keep it on the `ask`
permission so every call requires explicit approval.

## Analytics

`list_model_stats` and `list_profile_stats` return per-item metrics for a date range, which is the basis for
ranking performance. `get_analytics_timeseries` returns the same metrics over time at day, week, month, or year
resolution — prefer a coarser granularity over long ranges, since `day` returns one row per day.

Lifetime totals (from `list_my_models` and `get_model`) and date-range totals are different figures; use the
range-based tools whenever the question is about a period.

## License

MIT
