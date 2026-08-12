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

Point balances are split into **regular** and **exclusive** points. Point shop items, gift cards included, are
payable with either kind and MakerWorld draws on both in the same order, so a shop redemption should be forecast
against the combined balance. Cashing out is the one route restricted to exclusive points. `get_points_summary`
reports the split, `get_cash_redemption_info` gives the per-point cash rate, and `list_shop_products` gives each
item's point cost — comparing the two shows which redemption route returns more value per point.

`redeem_product` spends points irreversibly and MakerWorld does not reverse redemptions. Keep it on the `ask`
permission so every call requires explicit approval.

## Analytics

`list_model_stats` and `list_profile_stats` return per-item metrics for a date range, which is the basis for
ranking performance. `get_analytics_timeseries` returns the same metrics over time at day, week, month, or year
resolution — prefer a coarser granularity over long ranges, since `day` returns one row per day.

Lifetime totals (from `list_my_models` and `get_model`) and date-range totals are different figures; use the
range-based tools whenever the question is about a period.

`analyze_earnings_velocity` answers a question those tools cannot: which models earned the most in the least
time. A lifetime total rewards age, so an ordinary model published a year ago outranks a strong one published
last month. This measures every model from its own publication date instead — points inside the launch window,
points in the first 90 days, and days taken to reach a point threshold — and sets that against the last 30 days
to separate a model that opened well and went quiet from one that still earns daily. It walks the whole point
ledger once and aggregates locally, so it costs a handful of requests regardless of how many models exist.

Two figures in that output are worth reading together. `points_in_launch_window` says how fast a design found
its audience, and `momentum` — the recent daily rate over the lifetime daily rate — says whether it still has
one. A high launch with low momentum is a design whose niche is now saturated; a modest launch with momentum
near or above 1 is still compounding.

## License

MIT
