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

`diagnose_listing` splits each model into its funnel and sizes what a better listing could be worth. Impressions
to views is close to a pure measure of the title and cover image, since that is all a browsing user sees before
clicking; views to prints measures the page. Each rate is compared against the upper quartile of your own
catalogue and the shortfall is carried through the rest of that model's funnel, which is the part that makes the
number mean anything — a poor click-through rate on a model nobody prints is worth almost nothing, while a small
shortfall on a model with heavy traffic and strong print conversion is worth a lot. Ranking on any single rate
points at the wrong models.

The page-side estimate is capped at doubling the prints a design has already drawn. Without that cap the tool
ranks unproven niches first, because a mount for one specific car converts at a twelfth of the benchmark and the
uncapped arithmetic reads that as an enormous opportunity. A low print rate is as often narrow demand as a weak
page, and the metrics cannot tell the two apart — `list_model_feedback` can.

`list_model_feedback` reads the comments and ratings, which is the only qualitative signal MakerWorld exposes.
Ratings carry a score, whether the print succeeded, and the problem category chosen on a low score; requests for
variants usually surface in the replies rather than the top-level comments. Reach for it before acting on any
page-side recommendation, and to find what people are asking you to build next.

## Editing a published listing

`update_model` changes the title, description, or tags of a model that is already live, and nothing else. Cover
image, model files, print profiles, license, and category are carried through untouched — those are where a bad
write does real damage, and none of them are what listing analysis produces.

The model stays live throughout. MakerWorld does not patch a published design; requesting its editor page forks a
draft, and the tool then PUTs the whole draft back and submits it. An automated review usually clears within a
few minutes, at which point the new version swaps in. Until then the old version keeps serving, and the design
ID, URL, impressions, prints, and points all survive the round trip.

Three consequences worth knowing. The draft must be read immediately before writing, because it carries
time-limited signed URLs for the model files. An edit in review does not appear in `list_drafts` — MakerWorld
keeps edit-drafts out of the draft list entirely, so an abandoned one is invisible rather than cluttering.

And publishing re-derives **printer compatibility** from the model file. That is not a side effect the tool can
suppress: the draft carries no compatibility fields, so the server decides. The result is not guaranteed to be a
superset of what was there before. Observed both directions on real models — one small part gained five newer
printers while keeping every older one, and one larger part kept a narrowed list that a browser editor session
had already recomputed. `update_model` therefore returns `printer_compatibility_before`; compare it against
`get_print_profiles` once review clears rather than assuming the change was harmless.

`get_print_profiles` reads compatibility from `instances[].extention.modelInfo`, which is the only reliable
source — the dedicated instances endpoint omits it entirely. It also reports the printers a profile does *not*
cover, which is how a model published before a printer existed reveals that it silently excludes those owners.

`suggest_tags` is the autocomplete the upload form uses, and reports how many models carry each tag. It turns tag
choice into something checkable: a tag on thousands of models is a crowded search, one on a handful may be too
obscure to bring traffic, and it confirms the spelling MakerWorld actually stores.

Two figures in the velocity output are worth reading together. `points_in_launch_window` says how fast a design found
its audience, and `momentum` — the recent daily rate over the lifetime daily rate — says whether it still has
one. A high launch with low momentum is a design whose niche is now saturated; a modest launch with momentum
near or above 1 is still compounding.

## License

MIT
