# Setup Plugin Skill

Set up an OpenTabs plugin for use. Follow each step below to search, install, verify, review, test, and configure the plugin.

Replace `<plugin-name>` with the actual plugin name (e.g., `slack`, `github`) and `<package-name>` with the npm package name (e.g., `opentabs-plugin-slack`, `@opentabs-dev/opentabs-plugin-slack`).

---

## Step 1: Search for the Plugin

Search npm to find the plugin package:

```bash
opentabs plugin search <plugin-name>
```

This lists matching packages with their descriptions and versions. Look for the official package (usually `@opentabs-dev/opentabs-plugin-<plugin-name>` or `opentabs-plugin-<plugin-name>`).

If the search returns no results, the plugin may not be published to npm. Check if the user has a local plugin directory to add instead.

---

## Step 2: Install the Plugin

Install the plugin via the CLI:

```bash
opentabs plugin install <package-name>
```

This installs the package globally and triggers plugin rediscovery. The MCP server picks it up automatically (no restart needed).

**If the install fails:**
- Check the package name is correct
- Check npm registry access: `npm ping`
- For scoped packages, ensure the user is authenticated: `npm whoami`

For local plugins (under active development), add the path instead:

```bash
opentabs config set localPlugins.add /path/to/plugin
```

---

## Step 3: Open the Target Web App

The user needs to open the web app that the plugin targets in a Chrome browser tab. The plugin's URL patterns determine which tabs it matches.

Ask the user to navigate to the appropriate URL in their browser.

---

## Step 4: Verify Plugin Loaded

Check that the plugin was discovered and a matching tab is ready:

```
plugin_list_tabs(plugin: "<plugin-name>")
```

Expected result:
- The plugin appears in the list
- `state` is `ready` (the tab matches and the plugin's `isReady()` returned true)
- At least one tab is shown with `ready: true`

**If the plugin is not listed:**
- Check the server logs: `opentabs logs`
- The plugin may have failed to load (missing `dist/adapter.iife.js`, invalid `package.json`, etc.)

**If state is `unavailable`:**
- The user may need to log in to the web app first
- Wait a few seconds for the page to finish loading, then re-check

**If state is `closed`:**
- No open tab matches the plugin's URL patterns
- Ask the user to open the correct URL

---

## Step 5: Review the Plugin

New plugins start with permission `off` (disabled) and must be reviewed before use. This is a security measure — the plugin adapter runs code in the user's authenticated browser session.

### 5a. Inspect the plugin's adapter code:

```
plugin_inspect(plugin: "<plugin-name>")
```

This returns the full adapter IIFE source code, metadata (name, version, author, line count), and a review token.

### 5b. Review the code for security concerns:

Check for:
- **Network requests**: Are they only to the expected API domains? No exfiltration to third-party servers?
- **Data access**: Does it only read data relevant to its tools? No excessive localStorage/cookie reading?
- **DOM manipulation**: Does it only interact with the target web app's UI? No injecting external scripts?
- **Permissions**: Does it request only the capabilities it needs?

### 5c. Mark the plugin as reviewed:

After reviewing and confirming with the user:

```
plugin_mark_reviewed(
  plugin: "<plugin-name>",
  version: "<version from inspect>",
  reviewToken: "<token from inspect>",
  permission: "ask"
)
```

Use `ask` permission initially — this requires user approval for each tool call. The user can upgrade to `auto` later if they trust the plugin.

---

## Step 6: Test the Plugin

Call a read-only tool first to verify everything works end-to-end:

1. Check which tools are available — they are prefixed with `<plugin-name>_` (e.g., `<plugin-name>_list_channels`, `<plugin-name>_get_profile`)
2. Call a simple read-only tool (list, get, search) to verify:
   - The tool dispatches to the browser tab
   - The adapter extracts auth correctly
   - The API call succeeds
   - The response is well-formatted

If the tool call fails, use the `troubleshoot` skill for guided debugging.

---

## Step 7: Configure Permissions

Once the plugin is working, help the user set permissions based on their trust level:

### Plugin-level permission (applies to all tools):

```bash
# Require approval for every tool call (default after review)
opentabs config set plugin-permission.<plugin-name> ask

# Auto-approve all tool calls (skip approval dialogs)
opentabs config set plugin-permission.<plugin-name> auto

# Disable the plugin
opentabs config set plugin-permission.<plugin-name> off
```

### Per-tool permissions (override the plugin-level default):

```bash
# Auto-approve read-only tools, require approval for write tools
opentabs config set tool-permission.<plugin-name>.list_channels auto
opentabs config set tool-permission.<plugin-name>.send_message ask
```

### Permission resolution order:
1. `skipPermissions` env var (bypasses everything — development only)
2. Per-tool override (`tool-permission.<plugin>.<tool>`)
3. Plugin default (`plugin-permission.<plugin>`)
4. Global default: `off`

---

## Summary

After completing all steps, the plugin is:
- Installed and discovered by the MCP server
- Loaded with a matching browser tab in `ready` state
- Reviewed and approved with the appropriate permission level
- Tested with at least one successful tool call
- Configured with the user's preferred permission settings

The plugin's tools are now available for use in your AI workflow.

---

## Updating This Skill

If the setup process surfaced new patterns, gotchas, or common issues, update this skill file directly (`.claude/skills/setup-plugin/__SKILL__.md`) so future AI agents benefit automatically.

**Rules:**
- Check for duplicates before adding — scan existing content
- Keep learnings generic, not specific to a single plugin

---

# Quick Start Reference

The following reference material covers OpenTabs installation, MCP client configuration, and general setup context.

## What is OpenTabs?

OpenTabs is a platform that gives AI agents access to web applications through the user's authenticated browser session. It consists of:

- **MCP Server** — runs on localhost, serves tools to AI clients via Streamable HTTP
- **Chrome Extension** — injects plugin adapters into matching browser tabs, relays tool calls
- **Plugin SDK** — allows anyone to create plugins as standalone npm packages

When connected, your AI client gets browser tools (tab management, screenshots, DOM interaction, network capture) and plugin tools (e.g., `slack_send_message`, `github_list_repos`) that operate in the user's authenticated context.

## Installation

```bash
npm install -g @opentabs-dev/cli
```

## Starting the Server

```bash
opentabs start
```

On first run, this:
1. Creates `~/.opentabs/` (config, logs, extension files)
2. Generates a WebSocket auth secret at `~/.opentabs/extension/auth.json`
3. Prints MCP client configuration blocks for Claude Code, Cursor, and Windsurf
4. Starts the MCP server on `http://127.0.0.1:9515/mcp`

To re-display the configuration blocks later:

```bash
opentabs start --show-config
```

## Loading the Chrome Extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select `~/.opentabs/extension`

The extension icon appears in the toolbar. Click it to open the side panel showing plugin states and tool permissions.

## Configuring Your MCP Client

Get the auth secret:

```bash
opentabs config show --json --show-secret | jq -r .secret
```

### Claude Code

CLI method (recommended):

```bash
claude mcp add --transport http opentabs http://127.0.0.1:9515/mcp \
  --header "Authorization: Bearer YOUR_SECRET_HERE"
```

Or merge into `~/.claude.json`:

```json
{
  "mcpServers": {
    "opentabs": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9515/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SECRET_HERE"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "opentabs": {
      "type": "http",
      "url": "http://127.0.0.1:9515/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SECRET_HERE"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "opentabs": {
      "serverUrl": "http://127.0.0.1:9515/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SECRET_HERE"
      }
    }
  }
}
```

### OpenCode

Add to `opencode.json` in the project root:

```json
{
  "mcp": {
    "opentabs": {
      "type": "remote",
      "url": "http://127.0.0.1:9515/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SECRET_HERE"
      }
    }
  }
}
```

## Installing a Plugin

```bash
opentabs plugin search              # Browse available plugins
opentabs plugin install <name>      # Install (e.g., opentabs plugin install slack)
```

After installing, open the target web app in Chrome (e.g., `app.slack.com` for Slack). The extension detects the matching tab and loads the plugin adapter.

## Plugin Review Flow

Plugins start with permission `'off'` and must be reviewed before use. When you call a tool on an unreviewed plugin, the error response guides you through the review:

1. Call `plugin_inspect` with the plugin name to retrieve the adapter source code and a review token
2. Review the code for security (the response includes review guidance)
3. If the code is safe, call `plugin_mark_reviewed` with the review token and desired permission (`'ask'` or `'auto'`)
4. The plugin is now active — its tools are available

When a plugin updates to a new version, its permission resets to `'off'` and requires re-review.

## Permission Model

Every tool has a 3-state permission:

| Permission | Behavior |
|------------|----------|
| `'off'` | Disabled — tool call returns an error |
| `'ask'` | Requires human approval via the side panel dialog |
| `'auto'` | Executes immediately without user confirmation |

Configure permissions via CLI:

```bash
opentabs config set plugin-permission.<plugin> ask
opentabs config set tool-permission.<plugin>.<tool> auto
```

To bypass all permission checks (development only):

```bash
OPENTABS_DANGEROUSLY_SKIP_PERMISSIONS=1 opentabs start
```

## Available Tool Categories

### Plugin Tools (`<plugin>_<tool>`)
Execute inside the web page context using the user's authenticated browser session. Each plugin exposes domain-specific tools (e.g., `slack_send_message`, `github_create_issue`).

### Browser Tools (`browser_*`) — 40 built-in tools
General-purpose tools organized by category:
- **Tab Management** — open, close, list, switch tabs
- **Content Retrieval** — read page content, HTML, take screenshots
- **DOM Interaction** — click elements, type text, query selectors
- **Scroll & Navigation** — scroll, navigate, go back/forward
- **Storage & Cookies** — read/write localStorage, sessionStorage, cookies
- **Network Capture** — capture and inspect network requests, WebSocket frames, HAR export
- **Console** — read browser console logs
- **Site Analysis** — comprehensive analysis of a web page for plugin development

### Extension Tools (`extension_*`)
Diagnostics: extension state, logs, adapter injection status, WebSocket connectivity.

## Multi-Tab Targeting

When multiple tabs match a plugin, use `plugin_list_tabs` to discover available tabs and their IDs. Pass the optional `tabId` parameter to any plugin tool to target a specific tab. Without `tabId`, the platform auto-selects the best-ranked tab.

## Verifying the Setup

```bash
opentabs status    # Check server, extension, and plugin status
opentabs doctor    # Run diagnostics and suggest fixes
```

From your AI client, you can also:
1. Call `extension_get_state` to verify the Chrome extension is connected
2. Call `plugin_list_tabs` to see which plugin tabs are ready
