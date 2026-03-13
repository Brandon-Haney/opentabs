# Webflow

OpenTabs plugin for Webflow — gives AI agents access to Webflow through your authenticated browser session.

## Install

```bash
opentabs plugin install webflow
```

Or install globally via npm:

```bash
npm install -g @opentabs-dev/opentabs-plugin-webflow
```

## Setup

1. Open [webflow.com](https://webflow.com) in Chrome and log in
2. Open the OpenTabs side panel — the Webflow plugin should appear as **ready**

## Tools (15)

### Account (1)

| Tool | Description | Type |
|---|---|---|
| `get_current_user` | Get your Webflow profile | Read |

### Workspaces (7)

| Tool | Description | Type |
|---|---|---|
| `list_workspaces` | List all workspaces | Read |
| `get_workspace` | Get workspace details | Read |
| `get_workspace_permissions` | Get your workspace permissions | Read |
| `list_workspace_members` | List workspace members | Read |
| `get_workspace_billing` | Get workspace billing plan | Read |
| `get_workspace_entitlements` | Get workspace feature entitlements | Read |
| `list_folders` | List workspace folders | Read |

### Sites (7)

| Tool | Description | Type |
|---|---|---|
| `list_sites` | List sites in a workspace | Read |
| `get_site` | Get site details | Read |
| `get_site_domains` | Get site domains and subdomain | Read |
| `get_site_hosting` | Get site hosting details | Read |
| `get_site_pages` | List pages in a site | Read |
| `get_site_permissions` | Get your site permissions | Read |
| `list_site_forms` | List forms on a site | Read |

## How It Works

This plugin runs inside your Webflow tab through the [OpenTabs](https://opentabs.dev) Chrome extension. It uses your existing browser session — no API tokens or OAuth apps required. All operations happen as you, with your permissions.

## License

MIT
