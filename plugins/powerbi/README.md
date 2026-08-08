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

## Tools (10)

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

### Datasets (4)

| Tool | Description | Type |
|---|---|---|
| `list_datasets` | List reachable semantic models | Read |
| `get_dataset` | Look up one semantic model by ID | Read |
| `describe_dataset` | List a model's tables, measures, and columns | Write |
| `execute_dax` | Run a DAX query against a semantic model | Write |

## How It Works

This plugin runs inside your Power BI tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
