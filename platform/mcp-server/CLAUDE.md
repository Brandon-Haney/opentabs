# MCP Server Instructions

## Overview

Discovers plugins, registers their tools, resources, and prompts as MCP capabilities, dispatches tool calls, resource reads, and prompt gets to the Chrome extension via WebSocket, receives plugin log entries and forwards them to MCP clients via the logging capability, converts tool progress notifications into MCP `notifications/progress` events, and serves health/config endpoints. The server maintains an in-memory audit log of the last 500 tool invocations, queryable via `GET /audit` (with Bearer auth), with aggregate stats included in the `/health` response's `auditSummary` field.

## Key Files

```
platform/mcp-server/src/
├── index.ts              # Entry point (HTTP + WebSocket server, hot reload)
├── dev-mode.ts           # Dev mode detection (--dev flag / OPENTABS_DEV env var)
├── config.ts             # ~/.opentabs/config.json management + auth.json secret handling
├── discovery.ts          # Discovery orchestrator (resolve → load → register)
├── resolver.ts           # Plugin specifier resolution (npm + local paths)
├── loader.ts             # Plugin artifact loading (package.json, IIFE, tools.json)
├── registry.ts           # Immutable PluginRegistry with O(1) tool, resource, and prompt lookup
├── extension-protocol.ts # JSON-RPC protocol with Chrome extension
├── mcp-setup.ts          # MCP tool, resource, and prompt registration from discovered plugins
├── state.ts              # In-memory server state (PluginRegistry)
├── log-buffer.ts         # Per-plugin circular log buffer (last 1000 entries)
├── file-watcher.ts       # Watches local plugin dist/ directories (dev mode only)
└── version-check.ts      # npm update checks for installed plugins
```

## Plugin Discovery

The MCP server discovers plugins from two sources: (1) **npm auto-discovery** scans global `node_modules` for packages matching `opentabs-plugin-*` and `@*/opentabs-plugin-*` patterns, and (2) **local plugins** listed in the `localPlugins` array in `~/.opentabs/config.json` (filesystem paths to plugins under active development). Each discovered plugin is loaded by reading `package.json` (with an `opentabs` field for metadata), `dist/adapter.iife.js` (the adapter bundle), and `dist/tools.json` (tool schemas, resource metadata, and prompt metadata). Local plugins override npm plugins of the same name. Discovery is a four-phase pipeline: resolve → load → determine trust tier → build an immutable registry.

## Dispatch Pipeline

### Tool Dispatch

Tool dispatch uses a 30s timeout (`DISPATCH_TIMEOUT_MS`) by default. When a tool reports progress, the timeout resets to 30s from the last progress notification — so a tool that reports progress at least once every 30s will never time out. An absolute ceiling of 5 minutes (`MAX_DISPATCH_TIMEOUT_MS = 300_000`) applies regardless of progress, preventing indefinitely running tools. The extension has a matching `MAX_SCRIPT_TIMEOUT_MS` (295s, 5s less than the server max) to ensure the extension always responds before the server times out.

### Progress Reporting

Long-running tools can report incremental progress to MCP clients via an optional second argument to `handle()`. The `handle(params, context?)` signature provides a `ToolHandlerContext` with a `reportProgress({ progress, total, message? })` callback. Progress flows from the adapter (MAIN world `CustomEvent`) → ISOLATED world content script relay → `chrome.runtime.sendMessage` → extension background → WebSocket `tool.progress` JSON-RPC notification → MCP server → `notifications/progress` to MCP clients. The wire format from extension to server is `{ jsonrpc: '2.0', method: 'tool.progress', params: { dispatchId, progress, total, message? } }`. The `dispatchId` correlates progress back to the pending dispatch via the JSON-RPC request ID. Progress notifications are fire-and-forget — errors in the progress chain do not affect the tool result. The MCP server only emits `notifications/progress` if the MCP client included a `progressToken` in the tools/call request's `_meta`; otherwise progress is silently dropped.

### Resource and Prompt Dispatch

Resources and prompts follow the same dispatch pipeline as tools: MCP server → WebSocket → Chrome extension → adapter IIFE → page context. The `resource.read` dispatch sends a URI to the adapter's `resource.read(uri)` function and returns `ResourceContent`. The `prompt.get` dispatch sends a prompt name and arguments to the adapter's `prompt.render(args)` function and returns `PromptMessage[]`. Unlike tool dispatch, resource reads and prompt gets do not support progress reporting or invocation lifecycle hooks. The `dist/tools.json` manifest file stores resource metadata (`{ uri, name, description, mimeType }`) and prompt metadata (`{ name, description, arguments }`) alongside tool schemas — the `read()` and `render()` runtime functions exist only in the adapter IIFE.

## Plugin Logging

The plugin SDK exports a `log` namespace (`log.debug`, `log.info`, `log.warn`, `log.error`) that routes structured log entries from plugin tool handlers and lifecycle hooks through the platform to MCP clients and the CLI. The transport chain is: adapter IIFE (page context) → `window.postMessage` → ISOLATED world relay script → `chrome.runtime.sendMessage` → background service worker → WebSocket `plugin.log` JSON-RPC → MCP server → `sendLoggingMessage` to MCP clients + `console.log` to `server.log`. The MCP server maintains a per-plugin circular buffer (1000 entries) for log entries, exposed via the `/health` endpoint's `pluginDetails[].logBufferSize` field. When running outside the adapter runtime (e.g., unit tests), the logger falls back to `console` methods. The adapter IIFE wrapper sets up the log transport via `_setLogTransport()` (accessed through `globalThis.__openTabs._setLogTransport` to avoid SDK version mismatches) and batches entries (flush every 100ms or 50 entries).

## Dev vs Production Mode

The MCP server operates in two modes, controlled by the `--dev` CLI flag or `OPENTABS_DEV=1` environment variable. **Production mode** (default) runs on Node.js (`node dist/index.js`), performs static plugin discovery at startup with no file watchers and no config watching, and uses `node:http` + `ws` for the HTTP+WebSocket server. **Dev mode** runs under Bun with `bun --hot`, enables file watchers for local plugin `dist/` directories, config file watching, and uses `Bun.serve()` for the server. The `POST /reload` endpoint is available in both modes (behind bearer auth and rate limiting), allowing `opentabs-plugin build` to trigger rediscovery in either mode. The mode is determined once at startup in `dev-mode.ts` and accessible via `isDev()`.

### Hot Reload (Dev Mode Only)

In dev mode, the MCP server runs under `bun --hot`. On file changes, Bun re-evaluates the module while preserving `globalThis`. The server uses a `globalThis`-based cleanup pattern to tear down the previous instance (close WebSocket, stop file watchers, free the port) and reinitialize cleanly. Hot reload is a platform contributor feature — production users run the server via `opentabs start` (Node.js). In both modes, the `POST /reload` endpoint triggers plugin rediscovery without restarting the process.

**Known issue**: `bun --hot` file watchers can go stale on long-running processes (22+ hours). If `bun run build` does not trigger a hot reload (verify via the `/health` endpoint's `reloadCount`), restart the MCP server process manually. Note: `tsc` uses `writeFileSync` (in-place, preserves inodes), so this is not a kqueue inode invalidation issue — it is a bug in Bun's file watcher that surfaces on long-running processes (see oven-sh/bun#14568, oven-sh/bun#15200).

## Authentication and Secrets

The WebSocket secret is stored exclusively in `~/.opentabs/extension/auth.json` as `{ "secret": "<hex>" }`. This file is the single source of truth — `config.json` does not store the secret. On startup, the MCP server calls `loadSecret()` which reads the secret from `auth.json`, or generates a new one and writes `auth.json` if it doesn't exist. The secret is also re-read on every config reload (`reloadCore`) so that `opentabs config rotate-secret` takes effect without restarting the server. CLI commands (`status`, `audit`, `plugin reload`) and `opentabs-plugin build` read the secret from `auth.json` via their own helper functions. Secret rotation is done via `opentabs config rotate-secret`, which generates a new secret, writes it to `auth.json`, and notifies the running server via `POST /reload`. The server detects the secret change in `reloadCore` and sends `extension.reload` over the existing WebSocket, causing the extension to restart and reconnect with the new credentials automatically.

## Browser Tools

The MCP server registers built-in browser tools (`platform/mcp-server/src/browser-tools/`) that operate on Chrome tabs via the extension's WebSocket connection. These tools are always available regardless of installed plugins. They cover tab management (`browser_open_tab`, `browser_list_tabs`, `browser_close_tab`), page interaction (`browser_click_element`, `browser_type_text`, `browser_execute_script`), inspection (`browser_get_tab_content`, `browser_get_page_html`, `browser_screenshot_tab`, `browser_query_elements`), storage and cookies (`browser_get_storage`, `browser_get_cookies`), network capture (`browser_enable_network_capture`, `browser_get_network_requests`), and extension diagnostics (`extension_get_state`, `extension_get_logs`). Each browser tool is defined using `defineBrowserTool()` with a Zod schema and handler function.

## Site Analysis Tool

`plugin_analyze_site` is a high-level browser tool that comprehensively analyzes a web page to produce actionable intelligence for building OpenTabs plugins. Use it when developing a new plugin for a website — it reveals how the site authenticates users, what APIs it calls, what framework it uses, and what data is available in the DOM and storage. The tool orchestrates multiple browser tool capabilities (tab management, network capture, script execution, cookie reading) and passes collected data through six detection modules in `platform/mcp-server/src/browser-tools/analyze-site/`:

- `detect-auth.ts` — detects cookie sessions, JWTs in localStorage/sessionStorage, Bearer/Basic auth headers, API key headers, CSRF tokens, custom auth headers, and auth data in window globals
- `detect-apis.ts` — classifies captured network requests by protocol (REST, GraphQL, gRPC-Web, JSON-RPC, tRPC, WebSocket, SSE, form submissions), groups by endpoint, filters noise, and identifies the primary API base URL
- `detect-framework.ts` — identifies frontend frameworks (React, Next.js, Vue, Nuxt, Angular, Svelte, jQuery, Ember, Backbone) with versions, and detects SPA vs MPA and SSR
- `detect-globals.ts` — scans non-standard window globals and flags those containing auth-related data
- `detect-dom.ts` — detects forms (action, method, fields), interactive elements, and data-\* attribute patterns
- `detect-storage.ts` — lists cookie, localStorage, and sessionStorage key names with auth-relevance flags (values are never read for security)

The tool returns a structured report including a `suggestions` array of concrete plugin tool ideas derived from the detected APIs, forms, and endpoints. Each suggestion includes a `toolName`, `description`, `approach` (with specific endpoint), and `complexity` rating. Input: `{ url: string, waitSeconds?: number }`. The detection modules are pure analysis functions — they receive pre-collected data and return structured results, keeping the analysis testable independently of the browser.

## MCP Tool Design Guidelines

- **Tool descriptions must be accurate and informative** — descriptions are shown to AI agents, so clarity is critical for proper tool usage
- **Keep parameter descriptions clear** — explain what each parameter does and provide examples where helpful
- **Update descriptions when behavior changes** — if a tool's functionality changes, update its description immediately
- **Design for usefulness** — think about how AI agents and engineers will actually use the tool; make it intuitive and powerful
- **Design for composability** — consider how tools can work together; tools should complement each other to make this MCP server the most powerful toolset for engineers
- **Return actionable data** — tool responses should include IDs, references, and context that enable follow-up actions with other tools
