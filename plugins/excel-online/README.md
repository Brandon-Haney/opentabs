# Excel Online

OpenTabs plugin for Microsoft Excel Online — gives AI agents access to Excel Online through your authenticated browser session.

## Install

```bash
opentabs plugin install excel-online
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-excel-online
```

## Setup

1. Open [excel.cloud.microsoft](https://excel.cloud.microsoft/) in Chrome and log in
2. Open the OpenTabs side panel — the Excel Online plugin should appear as **ready**

## Tools (28)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the authenticated user profile | Read |

### Workbook (5)

| Tool | Description | Type |
|---|---|---|
| `get_workbook_info` | Get current workbook metadata | Read |
| `calculate_workbook` | Recalculate all formulas | Write |
| `evaluate_formula` | Evaluate a formula and return the result | Write |
| `list_named_items` | List named ranges and constants | Read |
| `add_named_item` | Create a named range or constant | Write |

### Worksheets (4)

| Tool | Description | Type |
|---|---|---|
| `list_worksheets` | List all worksheets in the workbook | Read |
| `add_worksheet` | Add a new worksheet | Write |
| `update_worksheet` | Update worksheet name, position, or visibility | Write |
| `delete_worksheet` | Delete a worksheet by name | Write |

### Ranges (7)

| Tool | Description | Type |
|---|---|---|
| `get_range` | Read cell values from a range | Read |
| `get_used_range` | Get the used range of a worksheet | Read |
| `update_range` | Write values or formulas to a range | Write |
| `clear_range` | Clear cell contents or formatting | Write |
| `insert_range` | Insert cells and shift existing data | Write |
| `delete_range` | Delete cells and shift remaining data | Write |
| `sort_range` | Sort data in a range by columns | Write |

### Tables (8)

| Tool | Description | Type |
|---|---|---|
| `list_tables` | List all tables in the workbook | Read |
| `create_table` | Create a table from a data range | Write |
| `delete_table` | Delete a table | Write |
| `get_table_rows` | Get all rows from a table | Read |
| `get_table_columns` | Get column definitions of a table | Read |
| `add_table_row` | Add rows to a table | Write |
| `delete_table_row` | Delete a row from a table by index | Write |
| `add_table_column` | Add a column to a table | Write |

### Charts (3)

| Tool | Description | Type |
|---|---|---|
| `list_charts` | List all charts in a worksheet | Read |
| `create_chart` | Create a chart from data | Write |
| `delete_chart` | Delete a chart | Write |

## How It Works

This plugin runs inside your Excel Online tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
