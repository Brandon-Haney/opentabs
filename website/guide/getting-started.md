# Getting Started

Get OpenTabs running in under 5 minutes.

## Prerequisites

- [Bun](https://bun.sh/) (v1.1+)
- [Google Chrome](https://www.google.com/chrome/)
- An MCP-compatible AI agent (e.g., [Claude Code](https://docs.anthropic.com/en/docs/claude-code))

## 1. Install the Chrome Extension

1. Download the latest release from [GitHub Releases](https://github.com/opentabs-dev/opentabs/releases)
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `dist` folder

The OpenTabs icon will appear in your Chrome toolbar.

## 2. Start the MCP Server

```bash
bun --hot platform/mcp-server/dist/index.js
```

The server starts on `http://localhost:3000`. The Chrome extension connects automatically via WebSocket.

## 3. Connect Your AI Agent

Add OpenTabs to your MCP client configuration. For Claude Code, edit `~/.claude/settings/mcp.json`:

```json
{
  "mcpServers": {
    "opentabs": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## 4. Install a Plugin

Plugins add support for specific web applications. Install one from npm:

```bash
bun add opentabs-plugin-slack
```

Or register a local plugin by adding its path to `~/.opentabs/config.json`:

```json
{
  "plugins": ["/path/to/your/plugin"]
}
```

## 5. Use It

Open the web application in Chrome (e.g., Slack), then ask your AI agent to use it:

> "Send a message to #general saying hello"

The AI agent calls the appropriate MCP tool, OpenTabs dispatches it to the Chrome extension, and the adapter executes it in the page context using your session.

## Verify the Setup

Check the MCP server health endpoint:

```bash
curl http://localhost:3000/health
```

You should see the extension status as `"connected"` and your installed plugins listed.

## Next Steps

- [How It Works](/guide/how-it-works) — Understand the architecture
- [Install a Plugin](/guide/install-plugin) — Browse available plugins
- [Creating a Plugin](/plugins/creating-a-plugin) — Build your own
