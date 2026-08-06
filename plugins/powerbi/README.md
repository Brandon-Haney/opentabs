# Power BI

OpenTabs plugin for Microsoft Power BI — gives AI agents access to Power BI through your authenticated browser session.

## Install

```bash
opentabs plugin install powerbi
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-powerbi
```

## Setup

1. Open [app.powerbi.com](https://app.powerbi.com/) in Chrome and log in
2. Open the OpenTabs side panel — the Power BI plugin should appear as **ready**

## Tools (9)

### Workspaces (1)

| Tool | Description | Type |
|---|---|---|
| `list_workspaces` | List workspaces the user belongs to | Read |

### Apps (1)

| Tool | Description | Type |
|---|---|---|
| `list_apps` | List installed Power BI apps | Read |

### Reports (3)

| Tool | Description | Type |
|---|---|---|
| `list_reports` | List reachable reports and their semantic models | Read |
| `get_report` | Get one report by ID | Read |
| `list_report_pages` | List the pages in a report | Read |

### Dashboards (1)

| Tool | Description | Type |
|---|---|---|
| `list_dashboards` | List reachable dashboards | Read |

### Datasets (3)

| Tool | Description | Type |
|---|---|---|
| `list_datasets` | List reachable semantic models | Read |
| `describe_dataset` | List a model's tables, measures, and columns | Write |
| `execute_dax` | Run a DAX query against a semantic model | Write |

## How It Works

This plugin runs inside your Power BI tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## Every tool is read-only

The table above classifies `describe_dataset` and `execute_dax` as writes because it
classifies by name. They are not. `describe_dataset` reads model metadata and
`execute_dax` runs a DAX `EVALUATE`, which cannot mutate a model. **This plugin has no
write path to Power BI at all** — nothing it can do changes a report, a model, or a
workspace.

## Empty results that are normal, not errors

If you reach Power BI content through published **apps** rather than by belonging to
workspaces — which is how most report consumers are set up — then:

- **`list_workspaces` returns an empty list.** You are not a member of any workspace.
  This is correct, not a failure.
- **`list_dashboards` may be empty** if your organisation publishes only reports.
- Every workspace-scoped Power BI endpoint (`/groups/...`) answers **401** for you.

Use **`list_reports`** instead. It is the dependable discovery route: it returns every
report you can reach along with its `dataset_id` *and* `dataset_workspace_id`, which the
workspace endpoints will not tell you. `list_datasets` builds on it, merging models found
that way with any you own and tagging each with how it was found.

## What you need permission-wise

- **Reading** reports, pages, apps and the model list needs nothing beyond access to the
  content.
- **`execute_dax` and `describe_dataset` need Build permission** on the model. Without it
  they fail with an authorisation error, which means the model owner has not granted it —
  not that the tool is broken.
- `describe_dataset` uses the `INFO.VIEW.*` DAX functions. The older `INFO.*` family
  requires elevated model permissions that a Build-only user does not have.

## Using it with an Excel workbook

An Excel workbook connected to Power BI records the semantic-model ID in its connection
string. The `excel-online` plugin's `inspect_data_model` surfaces it as `dataset_id`, and
that is the same ID `execute_dax` and `describe_dataset` take. So a workbook whose
PivotTables show a handful of measures can be queried here for anything else the model
publishes, without touching the workbook.

## Notes on results

- `execute_dax` always requests nulls to be included. Left at the service default, a null
  cell has its key omitted entirely, which silently drops a column from a row rather than
  reporting a blank.
- The service returns **no column list**, so columns are derived from the union of keys
  across every row — never the first row alone. If rows disagree on their key set the
  result says so via `columns_consistent` rather than hiding it.
- Limit rows **inside the query** (`TOPN`, `SUMMARIZECOLUMNS`) rather than relying on
  `max_rows`, which truncates only after the full result has crossed the network.
- Service limits: one query per request, 1,000,000 rows, 100,000 values, roughly 15 MB
  per response, and the endpoint is throttled.

Query results stay in your browser session and the local MCP transport. They are not
written to disk and not sent anywhere else, and error bodies are truncated so result data
cannot leak into logs.

## License

MIT
