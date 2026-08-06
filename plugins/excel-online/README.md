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

## Tools (69)

### Account (2)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get the authenticated user profile | Read |
| `reauthenticate` | Force a fresh Microsoft Graph token by clearing stale MSAL state and reloading the tab | Write |

### Workbook (5)

| Tool | Description | Type |
|---|---|---|
| `get_workbook_info` | Get current workbook metadata | Read |
| `calculate_workbook` | Recalculate all formulas | Write |
| `evaluate_formula` | Evaluate a formula and return the result | Write |
| `list_named_items` | List named ranges and constants | Read |
| `add_named_item` | Create a named range or constant | Write |

### Worksheets (6)

| Tool | Description | Type |
|---|---|---|
| `list_worksheets` | List all worksheets in the workbook | Read |
| `add_worksheet` | Add a new worksheet | Write |
| `update_worksheet` | Update worksheet name, position, or visibility | Write |
| `delete_worksheet` | Delete a worksheet by name | Write |
| `protect_worksheet` | Lock a worksheet against editing | Write |
| `unprotect_worksheet` | Unlock a protected worksheet | Write |

### Ranges (13)

| Tool | Description | Type |
|---|---|---|
| `get_range` | Read cell values from a range | Read |
| `get_used_range` | Get the used range of a worksheet | Read |
| `update_range` | Write values or formulas to a range | Write |
| `clear_range` | Clear cell contents or formatting | Write |
| `insert_range` | Insert cells and shift existing data | Write |
| `delete_range` | Delete cells and shift remaining data | Write |
| `sort_range` | Sort data in a range by columns | Write |
| `remove_duplicates` | Remove duplicate rows from a range | Write |
| `text_to_columns` | Split delimited text into columns | Write |
| `toggle_range_autofilter` | Add or remove AutoFilter dropdowns on a range | Write |
| `filter_range_column` | Filter a column of a range AutoFilter by values | Write |
| `filter_range_custom` | Filter a range column by a comparison | Write |
| `filter_range_top` | Filter a range column to its top/bottom N | Write |

### Formatting (14)

| Tool | Description | Type |
|---|---|---|
| `format_range` | Apply fill, font, and alignment formatting | Write |
| `set_number_format` | Set how cell values are displayed | Write |
| `set_dimensions` | Set column widths, row heights, or autofit | Write |
| `hide_rows_columns` | Hide or unhide rows and columns | Write |
| `group_rows_columns` | Group or ungroup rows or columns | Write |
| `set_borders` | Apply or remove borders on a range | Write |
| `merge_cells` | Merge a range into one cell | Write |
| `unmerge_cells` | Split merged cells back apart | Write |
| `format_range_advanced` | Strikethrough, text rotation, and indent | Write |
| `set_hyperlink` | Add or remove a native cell hyperlink | Write |
| `add_conditional_format` | Add a conditional-formatting rule | Write |
| `apply_cell_style` | Apply a built-in named cell style | Write |
| `add_data_validation` | Add a data-validation rule to a range | Write |
| `clear_data_validation` | Remove data validation from a range | Write |

### Tables (13)

| Tool | Description | Type |
|---|---|---|
| `list_tables` | List Excel Tables, and flag whether PivotTables exist | Read |
| `create_table` | Create a table from a data range | Write |
| `insert_table` | Write data and create a styled table in one call | Write |
| `update_table` | Change table style and display options | Write |
| `convert_table_to_range` | Convert a table into a plain range | Write |
| `delete_table` | Delete a table | Write |
| `get_table_rows` | Get all rows from a table | Read |
| `get_table_columns` | Get column definitions of a table | Read |
| `add_table_row` | Add rows to a table | Write |
| `delete_table_row` | Delete a row from a table by index | Write |
| `add_table_column` | Add a column to a table | Write |
| `filter_table` | Filter a table by a column | Write |
| `clear_table_filters` | Clear filters on a table | Write |

### Data Model (7)

| Tool | Description | Type |
|---|---|---|
| `inspect_data_model` | Inspect connections, PivotTables, and all available cube measures | Write |
| `list_pivot_tables` | List PivotTables with their zones and pinned filters | Read |
| `get_pivot_field_layout` | Read a PivotTable's live field layout and ids | Read |
| `add_pivot_field` | Place a measure or hierarchy into a PivotTable zone | Write |
| `get_pivot_filter_members` | List a page filter's members and their ids | Read |
| `set_pivot_filter` | Set the members a PivotTable page filter selects | Write |
| `refresh_pivot` | Refresh a workbook data connection | Write |

### Charts (5)

| Tool | Description | Type |
|---|---|---|
| `list_charts` | List all charts in a worksheet | Read |
| `create_chart` | Create a chart from data | Write |
| `update_chart` | Change a chart title, position, or size | Write |
| `get_chart_image` | Render a chart to a base64 PNG | Read |
| `delete_chart` | Delete a chart | Write |

### View (1)

| Tool | Description | Type |
|---|---|---|
| `freeze_panes` | Freeze or unfreeze rows and columns | Write |

### Layout (2)

| Tool | Description | Type |
|---|---|---|
| `set_print_area` | Set or extend the worksheet print area | Write |
| `insert_page_break` | Insert a manual page break at a cell | Write |

### Review (1)

| Tool | Description | Type |
|---|---|---|
| `add_comment` | Add a threaded comment or reply | Write |

## How It Works

This plugin runs inside your Excel Online tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
