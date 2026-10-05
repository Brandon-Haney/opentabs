# Oracle Fusion

OpenTabs plugin for Oracle Fusion Cloud Applications — gives AI agents access to Oracle Fusion through your authenticated browser session.

## Install

```bash
opentabs plugin install oracle-fusion
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-oracle-fusion
```

## Setup

1. Open [oraclecloud.com](https://oraclecloud.com) in Chrome and log in
2. Open the OpenTabs side panel — the Oracle Fusion plugin should appear as **ready**

## Configuration

Configure settings via `opentabs plugin configure oracle-fusion` or the side panel.

| Setting | Type | Required | Description |
|---|---|---|---|
| `instanceUrl` | url | No | The URL of your Oracle Fusion instance if it uses a custom domain (e.g., https://erp.example.com). Leave empty for standard *.oraclecloud.com instances. |
| `inventoryWorkArea` | string | No | Label of the home page tile that opens the Inventory Management work area. Set this when your organization has renamed the tile. Defaults to Inventory Management. |
| `purchaseOrdersWorkArea` | string | No | Label of the home page tile that opens the Purchase Orders work area. Set this when your organization has renamed the tile. Defaults to Purchase Orders. |

## Tools (6)

### Inventory (4)

| Tool | Description | Type |
|---|---|---|
| `get_item_quantities` | Get on-hand, receiving and inbound quantities by subinventory and locator | Read |
| `search_completed_transactions` | Search completed inventory transactions by item, date and source | Read |
| `search_movement_requests` | Search movement request lines with source and destination locators | Read |
| `search_pending_transactions` | Search pending and failed inventory transactions with their errors | Read |

### Receiving (1)

| Tool | Description | Type |
|---|---|---|
| `search_expected_shipments` | Search open PO, ASN, transfer and RMA lines awaiting receipt | Read |

### Purchasing (1)

| Tool | Description | Type |
|---|---|---|
| `search_purchase_orders` | Search purchase orders and read their lines | Read |

## How It Works

This plugin runs inside your Oracle Fusion tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT

## Notes

- **Which tab to open.** Sign in to your own Fusion instance (`https://<your-instance>.oraclecloud.com/fscmUI/faces/FuseWelcome`) and keep any classic Fusion page open, such as the home page or a work area.
- **Searches run in a background session.** The plugin opens its own Fusion window on the server and searches there, so the page you are looking at does not change while a tool runs.
- **Your Fusion permissions apply.** The plugin reaches only the work areas and tasks your account can open, and returns the columns your results table shows. Columns you add to the table appear under `additional_columns`.
- **English labels.** Search fields and result columns are matched by their English labels, so the Fusion session language must be English.
- **Renamed work areas.** If your organization renamed the Inventory Management tile on the home page, set the `inventoryWorkArea` setting to the tile's label.
- **Large searches.** Every matching row is exported on each call. A whole organization for one day can be around a thousand rows and take about ten seconds; filter by item or a short date range where you can.
- **Expanded rows stay expanded.** Reading item quantities expands the results tree level by level, and Fusion remembers expanded rows for your session, so the same items show expanded when you next open View Item Quantities yourself.
- **Pending transaction details.** Searching pending transactions opens each returned transaction to read its full record (locator, destination, source document, reason and any fields your organization added), one round trip each. Keep the page small, or turn details off for a quick count.
- **Transaction details and who made them.** The completed transactions table has no transaction type, reason or user. With `include_details`, each returned transaction's detail page and About This Record dialog are read as well (type, action, reason, transfer side, created and last updated by), several round trips each, so pages are capped at 100.
- **Availability.** With `include_availability`, item quantities also report available to transact and available to reserve for every row, from Fusion's Item Availability dialog. On-hand stock that is reserved, picked or staged shows as on hand but not available. The movement request holding it is an open line with status Preapproved (not Approved), found with `search_movement_requests` by item and `line_status: "preapproved"`.
- **Shared Fusion session state.** Fusion keeps some choices per session rather than per window: expanded tree rows and the category chosen in a work area's Tasks panel. The plugin sets the Tasks category it needs each time, so your own Tasks panel may show a different category afterwards.
- **Expected shipments and partial numbers.** Receive Expected Shipments matches document numbers exactly. With `partial_match`, the plugin first searches the field's lookup dialog for every document containing the text (as "Search and Select" does in the UI), then searches each match, up to 25. It covers the inventory organization Fusion has selected for the work area. Each document number searched comes back with a status: `open`, `no_open_lines` (Fusion knows it but nothing is waiting), or `not_found` (receiving in this organization does not know it — it may not exist, belong to another store, or never have become receivable).
- **Movement request columns.** The locators, reason, requester and store/invoice reference are columns Manage Movement Requests hides by default. The plugin shows every column once (View → Columns → Show All), and Fusion keeps that choice, so your own view of the table shows every column afterwards.
- **Movement request details and picks.** With `include_details`, each movement request on the returned page is opened to read its customer and order (Additional Information) and the picks of every line. A line's own source fields are often blank because Fusion chooses the source when picking; the picks show where the stock was really taken from.
- **Searches without an export.** Receive Expected Shipments and Manage Movement Requests have no Export button, so their rows are read from the page, and Fusion renders at most 500 rows at once. A search matching more is refused with the count, so it can be narrowed.
- **Purchase orders.** `search_purchase_orders` works in the Purchase Orders work area (set `purchaseOrdersWorkArea` if your tile is renamed). The page fills Buyer with your own name; the plugin clears it so every buyer's orders are searched, and it includes closed orders unless told not to. With `include_lines`, each order opens in its own tab as in the UI and is closed again afterwards, answering the "changes will be lost" warning with Yes — the plugin never changes an order, so nothing is lost.
- **Working on this plugin.** [docs/adf-field-guide.md](docs/adf-field-guide.md) explains how the plugin drives Fusion and every trap found so far; [docs/adding-a-screen.md](docs/adding-a-screen.md) is the recipe for adding a screen.
