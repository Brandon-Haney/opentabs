# Project Instructions for Claude

## Project Overview

**OpenTabs Platform** is a Chrome extension + MCP server with a plugin-based architecture. A plugin SDK allows anyone to create OpenTabs plugins as standalone npm packages. The MCP server discovers plugins at runtime, and the Chrome extension dynamically injects plugin adapters into matching tabs — giving AI agents access to web applications through the user's authenticated browser session.

### Architecture

```
┌─────────────┐  Streamable HTTP  ┌─────────────┐  WebSocket  ┌──────────────────┐
│ Claude Code │ ←───────────────→ │ MCP Server  │ ←─────────→ │ Chrome Extension │
│             │  /mcp             │ (localhost) │             │   (Background)   │
└─────────────┘                   └──────┬──────┘             └────────┬─────────┘
                                         │                             │
                                  ┌──────▼──────┐            ┌────────▼─────────┐
                                  │   Plugin    │            │  Adapter IIFEs   │
                                  │  Discovery  │            │  (per plugin,    │
                                  │ (npm + local│            │   injected into  │
                                  │  paths)     │            │   matching tabs) │
                                  └─────────────┘            └────────┬─────────┘
                                                                      │ Same-origin
                                                             ┌────────▼─────────┐
                                                             │   Web APIs       │
                                                             │ (user's session) │
                                                             └──────────────────┘
```

**MCP Server** (`platform/mcp-server`): Discovers plugins, registers their tools, resources, and prompts as MCP capabilities, dispatches tool calls, resource reads, and prompt gets to the Chrome extension via WebSocket, receives plugin log entries and forwards them to MCP clients via the logging capability, converts tool progress notifications into MCP `notifications/progress` events, and serves health/config endpoints. The server maintains an in-memory audit log of the last 500 tool invocations, queryable via `GET /audit` (with Bearer auth), with aggregate stats included in the `/health` response's `auditSummary` field.

**Chrome Extension** (`platform/browser-extension`): Receives plugin definitions from the MCP server via `sync.full`, dynamically registers content scripts for URL patterns, injects adapter IIFEs into matching tabs, dispatches tool calls, resource reads, and prompt gets to the correct tab's adapter, and relays tool progress notifications from adapters back to the MCP server. The `debugger` permission in the manifest is required for network capture via the Chrome DevTools Protocol (`chrome.debugger.attach`, `Network.enable`, `Runtime.enable`) in `network-capture.ts`.

**Plugin SDK** (`platform/plugin-sdk`): Provides the `OpenTabsPlugin` base class, `defineTool`, `defineResource`, and `definePrompt` factory functions, and `ToolHandlerContext` interface for progress reporting. Plugins extend `OpenTabsPlugin` and define tools (with Zod schemas), resources, and prompts.

**Plugin Tools** (`platform/plugin-tools`): Plugin developer CLI (`opentabs-plugin`). The `opentabs-plugin build` command bundles the plugin adapter into an IIFE, generates `dist/tools.json` (containing tool schemas, resource metadata, and prompt metadata), auto-registers the plugin in `~/.opentabs/config.json` (under `localPlugins`), and calls `POST /reload` to notify the running MCP server. Supports `--watch` mode for development.

**CLI** (`platform/cli`): User-facing CLI (`opentabs`). Commands: `start`, `status`, `audit`, `doctor`, `logs`, `plugin create/search`, `config show/set/path`. The `opentabs start` command auto-initializes config and the Chrome extension on first run, then launches the MCP server. The `opentabs logs --plugin <name>` flag filters output to only show logs from a specific plugin. The `opentabs audit` command shows recent tool invocation history from the server's audit log. The `opentabs plugin search [query]` command searches the npm registry for available plugins.

**create-plugin** (`platform/create-plugin`): Scaffolding CLI (`create-opentabs-plugin`) for new plugin projects.

### Tech Stack

- **Language**: TypeScript (strict, ES Modules)
- **Runtime**: Bun (monorepo with workspaces)
- **Build**: `tsc --build` (composite project references)
- **Testing**: Playwright (E2E)
- **UI**: React 19, Tailwind CSS 4 (side panel only)
- **Chrome Extension**: Manifest V3

### Directory Structure

```
opentabs/
├── platform/                      # Core platform packages (bun workspaces)
│   ├── mcp-server/                # MCP server — plugin discovery, tool dispatch
│   │   └── src/
│   │       ├── index.ts           # Entry point (HTTP + WebSocket server, hot reload)
│   │       ├── dev-mode.ts        # Dev mode detection (--dev flag / OPENTABS_DEV env var)
│   │       ├── config.ts          # ~/.opentabs/config.json management + auth.json secret handling
│   │       ├── discovery.ts       # Discovery orchestrator (resolve → load → register)
│   │       ├── resolver.ts        # Plugin specifier resolution (npm + local paths)
│   │       ├── loader.ts          # Plugin artifact loading (package.json, IIFE, tools.json)
│   │       ├── registry.ts        # Immutable PluginRegistry with O(1) tool, resource, and prompt lookup
│   │       ├── extension-protocol.ts  # JSON-RPC protocol with Chrome extension
│   │       ├── mcp-setup.ts       # MCP tool, resource, and prompt registration from discovered plugins
│   │       ├── state.ts           # In-memory server state (PluginRegistry)
│   │       ├── log-buffer.ts      # Per-plugin circular log buffer (last 1000 entries)
│   │       ├── file-watcher.ts    # Watches local plugin dist/ directories (dev mode only)
│   │       └── version-check.ts   # npm update checks for installed plugins
│   ├── browser-extension/         # Chrome extension (MV3)
│   │   ├── src/
│   │   │   ├── background.ts      # Service worker — WebSocket, adapter injection, tool dispatch
│   │   │   ├── offscreen/         # Persistent WebSocket (MV3 workaround)
│   │   │   └── side-panel/        # React side panel UI
│   │   ├── manifest.json          # Extension manifest
│   │   └── build-side-panel.ts    # Bun.build script for side panel
│   ├── plugin-sdk/                # Plugin authoring SDK
│   │   └── src/
│   │       ├── index.ts           # OpenTabsPlugin, defineTool, defineResource, definePrompt, log exports
│   │       └── log.ts             # Structured logging API (sdk.log namespace)
│   ├── plugin-tools/              # Plugin developer CLI (opentabs-plugin)
│   │   └── src/
│   │       ├── cli.ts             # Entry point — `opentabs-plugin` binary
│   │       └── commands/build.ts  # `opentabs-plugin build` command
│   ├── cli/                       # User-facing CLI (opentabs)
│   │   └── src/
│   │       ├── cli.ts             # Entry point — `opentabs` binary
│   │       └── commands/          # start, status, doctor, logs, plugin, config
│   └── create-plugin/             # Plugin scaffolding CLI
│       └── src/
│           └── index.ts           # `create-opentabs-plugin` CLI
├── plugins/                       # Example plugins (fully standalone, NOT in bun workspaces)
│   ├── slack/                     # Slack plugin
│   │   ├── src/
│   │   │   ├── index.ts           # Plugin class extending OpenTabsPlugin
│   │   │   └── tools/             # One file per tool
│   │   └── dist/                  # Build output (adapter.iife.js, tools.json)
│   └── e2e-test/                  # Test plugin for E2E tests
├── e2e/                           # Playwright E2E tests
│   ├── fixtures.ts                # Test fixtures (MCP server, extension, test server)
│   ├── tool-dispatch.e2e.ts       # Full-stack tool dispatch tests
│   ├── lifecycle.e2e.ts           # Hot reload and reconnection tests
│   ├── lifecycle-hooks.e2e.ts     # Plugin lifecycle hooks tests
│   ├── plugin-logging.e2e.ts     # Plugin logging pipeline tests
│   ├── progress.e2e.ts            # Progress notification pipeline tests
│   ├── resources-prompts.e2e.ts   # Resource and prompt dispatch pipeline tests
│   └── test-server.ts             # Controllable test web server
├── eslint.config.ts               # ESLint flat config
├── knip.ts                        # Knip unused code detection config
├── playwright.config.ts           # Playwright config
└── tsconfig.json                  # Root tsconfig with project references
```

### Key Concepts

**Plugin discovery**: The MCP server discovers plugins from two sources: (1) **npm auto-discovery** scans global `node_modules` for packages matching `opentabs-plugin-*` and `@*/opentabs-plugin-*` patterns, and (2) **local plugins** listed in the `localPlugins` array in `~/.opentabs/config.json` (filesystem paths to plugins under active development). Each discovered plugin is loaded by reading `package.json` (with an `opentabs` field for metadata), `dist/adapter.iife.js` (the adapter bundle), and `dist/tools.json` (tool schemas, resource metadata, and prompt metadata). Local plugins override npm plugins of the same name. Discovery is a four-phase pipeline: resolve → load → determine trust tier → build an immutable registry.

**Tool and prompt name prefixing**: Plugin tools and prompts are exposed to MCP clients with a `<plugin>_<name>` prefix (e.g., `slack_send_message` for tools, `slack_greet` for prompts). This prevents name collisions across plugins.

**Resource URI prefixing**: Plugin resource URIs are prefixed with `opentabs+<plugin>://` to make them globally unique across plugins. For example, a resource with URI `slack://channels` in a plugin named `slack` becomes `opentabs+slack://slack://channels`.

**Tab state machine**: Each plugin has three tab states: `closed` (no matching tab), `unavailable` (tab exists but `isReady()` returns false), and `ready` (tab exists and authenticated). The extension reports state changes to the MCP server.

**Authentication and secrets**: The WebSocket secret is stored exclusively in `~/.opentabs/extension/auth.json` as `{ "secret": "<hex>" }`. This file is the single source of truth — `config.json` does not store the secret. On startup, the MCP server calls `loadSecret()` which reads the secret from `auth.json`, or generates a new one and writes `auth.json` if it doesn't exist. The secret is immutable for the lifetime of the server process — it does not change on plugin reload or config changes. CLI commands (`status`, `audit`, `plugin reload`) and `opentabs-plugin build` read the secret from `auth.json` via their own helper functions. Secret rotation is done via `opentabs config rotate-secret`, which generates a new secret, writes it to `auth.json`, notifies the running server, and instructs the user to reload the extension from `chrome://extensions/`.

**Extension port configuration**: The MCP server port is configured in the Chrome extension's side panel footer, stored in `chrome.storage.local` under the `serverPort` key (number, default 9515). The side panel footer displays the current port on the right side and supports inline editing — click to edit, Enter to save, Escape to cancel. When the port changes, the side panel sends a `port-changed` message through the background script to the offscreen document, which closes the current WebSocket and reconnects to the new port. The port is not stored in `auth.json` — auth.json contains only the secret.

**Side panel empty states**: When the side panel has 0 plugins, it shows a simple "No Plugins Installed" card directing users to `opentabs plugin`. Connection state takes priority over plugin count. The side panel distinguishes two disconnect states: (1) **Connection refused** (server unreachable) — shows "Cannot Reach MCP Server" with `opentabs start --port <N>` where N is the configured port, and (2) **Authentication failed** (HTTP 401 from secret mismatch) — shows "Authentication Failed" with instructions to reload the extension from `chrome://extensions/`. The disconnect reason flows from the offscreen document through the background script to the side panel via `disconnectReason` fields on connection state messages.

**Lifecycle hooks**: Plugins can optionally implement lifecycle hooks on the `OpenTabsPlugin` base class. All hooks are wired automatically by the `opentabs-plugin build` command in the generated IIFE wrapper — plugin authors only need to implement the methods.

- `onActivate()` — called once after the adapter is registered on `globalThis.__openTabs.adapters`
- `onDeactivate()` — called when the adapter is being removed (before `teardown()`)
- `onNavigate(url)` — called on in-page URL changes (pushState, replaceState, popstate, hashchange)
- `onToolInvocationStart(toolName)` — called before each `tool.handle()` execution
- `onToolInvocationEnd(toolName, success, durationMs)` — called after each `tool.handle()` completes

All hooks run in the page context. Errors in hooks are caught and logged — they do not affect adapter registration or tool execution.

**Progress reporting**: Long-running tools can report incremental progress to MCP clients via an optional second argument to `handle()`. The `handle(params, context?)` signature provides a `ToolHandlerContext` with a `reportProgress({ progress, total, message? })` callback. Progress flows from the adapter (MAIN world `CustomEvent`) → ISOLATED world content script relay → `chrome.runtime.sendMessage` → extension background → WebSocket `tool.progress` JSON-RPC notification → MCP server → `notifications/progress` to MCP clients. The wire format from extension to server is `{ jsonrpc: '2.0', method: 'tool.progress', params: { dispatchId, progress, total, message? } }`. The `dispatchId` correlates progress back to the pending dispatch via the JSON-RPC request ID. Progress notifications are fire-and-forget — errors in the progress chain do not affect the tool result. The MCP server only emits `notifications/progress` if the MCP client included a `progressToken` in the tools/call request's `_meta`; otherwise progress is silently dropped.

**Resource and prompt dispatch**: Resources and prompts follow the same dispatch pipeline as tools: MCP server → WebSocket → Chrome extension → adapter IIFE → page context. The `resource.read` dispatch sends a URI to the adapter's `resource.read(uri)` function and returns `ResourceContent`. The `prompt.get` dispatch sends a prompt name and arguments to the adapter's `prompt.render(args)` function and returns `PromptMessage[]`. Unlike tool dispatch, resource reads and prompt gets do not support progress reporting or invocation lifecycle hooks. The `dist/tools.json` manifest file stores resource metadata (`{ uri, name, description, mimeType }`) and prompt metadata (`{ name, description, arguments }`) alongside tool schemas — the `read()` and `render()` runtime functions exist only in the adapter IIFE.

**Dispatch timeout and progress**: Tool dispatch uses a 30s timeout (`DISPATCH_TIMEOUT_MS`) by default. When a tool reports progress, the timeout resets to 30s from the last progress notification — so a tool that reports progress at least once every 30s will never time out. An absolute ceiling of 5 minutes (`MAX_DISPATCH_TIMEOUT_MS = 300_000`) applies regardless of progress, preventing indefinitely running tools. The extension has a matching `MAX_SCRIPT_TIMEOUT_MS` (295s, 5s less than the server max) to ensure the extension always responds before the server times out.

**Dev vs production mode**: The MCP server operates in two modes, controlled by the `--dev` CLI flag or `OPENTABS_DEV=1` environment variable. **Production mode** (default) performs static plugin discovery at startup with no file watchers and no config watching. **Dev mode** enables file watchers for local plugin `dist/` directories, config file watching, and is intended to run with `bun --hot` for hot reload. The `POST /reload` endpoint is available in both modes (behind bearer auth and rate limiting), allowing `opentabs-plugin build` to trigger rediscovery in either mode. The mode is determined once at startup in `dev-mode.ts` and accessible via `isDev()`.

**Hot reload** (dev mode): In dev mode, the MCP server runs under `bun --hot`. On file changes, Bun re-evaluates the module while preserving `globalThis`. The server uses a `globalThis`-based cleanup pattern to tear down the previous instance (close WebSocket, stop file watchers, free the port) and reinitialize cleanly. In production mode, the server starts once and serves until manually restarted. In both modes, the `POST /reload` endpoint triggers plugin rediscovery without restarting the process.

**Plugin logging**: The plugin SDK exports a `log` namespace (`log.debug`, `log.info`, `log.warn`, `log.error`) that routes structured log entries from plugin tool handlers and lifecycle hooks through the platform to MCP clients and the CLI. The transport chain is: adapter IIFE (page context) → `window.postMessage` → ISOLATED world relay script → `chrome.runtime.sendMessage` → background service worker → WebSocket `plugin.log` JSON-RPC → MCP server → `sendLoggingMessage` to MCP clients + `console.log` to `server.log`. The MCP server maintains a per-plugin circular buffer (1000 entries) for log entries, exposed via the `/health` endpoint's `pluginDetails[].logBufferSize` field. When running outside the adapter runtime (e.g., unit tests), the logger falls back to `console` methods. The adapter IIFE wrapper sets up the log transport via `_setLogTransport()` (accessed through `globalThis.__openTabs._setLogTransport` to avoid SDK version mismatches) and batches entries (flush every 100ms or 50 entries).

**Structured errors**: `ToolError` supports structured metadata that enables AI agents to distinguish retryable from permanent errors. The constructor accepts an optional third parameter: `ToolError(message, code, opts?)` where `opts` can include `category` (`'auth' | 'rate_limit' | 'not_found' | 'validation' | 'internal' | 'timeout'`), `retryable` (boolean, defaults to `false`), and `retryAfterMs` (number). Use the static factory methods instead of constructing directly: `ToolError.auth(msg)`, `ToolError.notFound(msg, code?)`, `ToolError.rateLimited(msg, retryAfterMs?)`, `ToolError.validation(msg)`, `ToolError.timeout(msg)`, `ToolError.internal(msg)`. The dispatch chain propagates these fields from the adapter IIFE through the extension to the MCP server, which formats error responses with both a human-readable prefix (`[ERROR code=X category=Y retryable=Z retryAfterMs=N] message`) and a machine-readable JSON block, enabling AI agents to parse and act on error metadata programmatically.

**Browser tools**: The MCP server registers built-in browser tools (`platform/mcp-server/src/browser-tools/`) that operate on Chrome tabs via the extension's WebSocket connection. These tools are always available regardless of installed plugins. They cover tab management (`browser_open_tab`, `browser_list_tabs`, `browser_close_tab`), page interaction (`browser_click_element`, `browser_type_text`, `browser_execute_script`), inspection (`browser_get_tab_content`, `browser_get_page_html`, `browser_screenshot_tab`, `browser_query_elements`), storage and cookies (`browser_get_storage`, `browser_get_cookies`), network capture (`browser_enable_network_capture`, `browser_get_network_requests`), and extension diagnostics (`extension_get_state`, `extension_get_logs`). Each browser tool is defined using `defineBrowserTool()` with a Zod schema and handler function.

**Site analysis tool** (`plugin_analyze_site`): A high-level browser tool that comprehensively analyzes a web page to produce actionable intelligence for building OpenTabs plugins. Use it when developing a new plugin for a website — it reveals how the site authenticates users, what APIs it calls, what framework it uses, and what data is available in the DOM and storage. The tool orchestrates multiple browser tool capabilities (tab management, network capture, script execution, cookie reading) and passes collected data through six detection modules in `platform/mcp-server/src/browser-tools/analyze-site/`:

- `detect-auth.ts` — detects cookie sessions, JWTs in localStorage/sessionStorage, Bearer/Basic auth headers, API key headers, CSRF tokens, custom auth headers, and auth data in window globals
- `detect-apis.ts` — classifies captured network requests by protocol (REST, GraphQL, gRPC-Web, JSON-RPC, tRPC, WebSocket, SSE, form submissions), groups by endpoint, filters noise, and identifies the primary API base URL
- `detect-framework.ts` — identifies frontend frameworks (React, Next.js, Vue, Nuxt, Angular, Svelte, jQuery, Ember, Backbone) with versions, and detects SPA vs MPA and SSR
- `detect-globals.ts` — scans non-standard window globals and flags those containing auth-related data
- `detect-dom.ts` — detects forms (action, method, fields), interactive elements, and data-\* attribute patterns
- `detect-storage.ts` — lists cookie, localStorage, and sessionStorage key names with auth-relevance flags (values are never read for security)

The tool returns a structured report including a `suggestions` array of concrete plugin tool ideas derived from the detected APIs, forms, and endpoints. Each suggestion includes a `toolName`, `description`, `approach` (with specific endpoint), and `complexity` rating. Input: `{ url: string, waitSeconds?: number }`. The detection modules are pure analysis functions — they receive pre-collected data and return structured results, keeping the analysis testable independently of the browser.

**SDK version compatibility**: The `opentabs-plugin build` command embeds the installed `@opentabs-dev/plugin-sdk` version as a top-level `sdkVersion` field in `dist/tools.json`. At discovery time, the MCP server compares the plugin's `sdkVersion` against its own SDK version using major.minor comparison: a plugin's major.minor must be less than or equal to the server's major.minor (patch differences are always fine). If the plugin was built with a newer SDK than the server, it is rejected as a `FailedPlugin` with a clear rebuild message. Plugins that predate this feature (no `sdkVersion` in `tools.json`) load normally with a warning logged — they are not rejected. The `sdkVersion` is surfaced in the `/health` endpoint (server-level and per-plugin), the `opentabs status` CLI command, and the side panel plugin cards (as a warning badge for missing or incompatible versions).

**SDK utilities**: The plugin SDK (`@opentabs-dev/plugin-sdk`) provides utility functions that run in the page context, reducing boilerplate for common plugin operations. All utilities are exported from the SDK's public API and organized into six categories:

_DOM utilities_ (`platform/plugin-sdk/src/dom.ts`):

- `waitForSelector(selector, opts?)` → `Promise<Element>` — waits for an element to appear using MutationObserver, configurable timeout (default 10s)
- `waitForSelectorRemoval(selector, opts?)` → `Promise<void>` — waits for an element to be removed from the DOM, configurable timeout (default 10s)
- `querySelectorAll<T>(selector)` → `T[]` — typed wrapper returning a real array instead of NodeList
- `getTextContent(selector)` → `string | null` — returns trimmed textContent of the first match, or null
- `observeDOM(selector, callback, options?)` → `() => void` — sets up a MutationObserver on the matching element, returns a cleanup function (defaults: childList+subtree true)

_Fetch utilities_ (`platform/plugin-sdk/src/fetch.ts`):

- `fetchFromPage(url, init?)` → `Promise<Response>` — fetch with credentials:'include' (page session cookies), configurable timeout via AbortSignal (default 30s), throws `ToolError` on non-ok status
- `fetchJSON<T>(url, init?)` → `Promise<T>` — calls fetchFromPage and parses JSON, throws on parse failure
- `postJSON<T>(url, body, init?)` → `Promise<T>` — POST with JSON body (sets Content-Type, stringifies), returns parsed JSON

_Storage utilities_ (`platform/plugin-sdk/src/storage.ts`):

- `getLocalStorage(key)` → `string | null` — wraps localStorage.getItem with try-catch (returns null on SecurityError)
- `setLocalStorage(key, value)` → `void` — wraps localStorage.setItem with try-catch (silently fails on SecurityError)
- `getSessionStorage(key)` → `string | null` — wraps sessionStorage.getItem with try-catch
- `getCookie(name)` → `string | null` — parses document.cookie, handles URI-encoded values

_Page state utilities_ (`platform/plugin-sdk/src/page-state.ts`):

- `getPageGlobal(path)` → `unknown` — safe deep property access on globalThis using dot-notation (e.g., `getPageGlobal('TS.boot_data.api_token') as string | undefined`), returns undefined if any segment is missing
- `getCurrentUrl()` → `string` — returns window.location.href
- `getPageTitle()` → `string` — returns document.title

_Timing utilities_ (`platform/plugin-sdk/src/timing.ts`):

- `retry<T>(fn, opts?)` → `Promise<T>` — retries on failure with configurable maxAttempts (default 3), delay (default 1s), optional exponential backoff, optional AbortSignal cancellation
- `sleep(ms)` → `Promise<void>` — promisified setTimeout
- `waitUntil(predicate, opts?)` → `Promise<void>` — polls predicate at interval (default 200ms) until true, rejects on timeout (default 10s)

_Logging utilities_ (`platform/plugin-sdk/src/log.ts`):

- `log.debug(message, ...args)` → `void` — logs at debug level
- `log.info(message, ...args)` → `void` — logs at info level
- `log.warn(message, ...args)` → `void` — logs at warning level (maps to MCP `warning`)
- `log.error(message, ...args)` → `void` — logs at error level

The `log` object is frozen. Args are safely serialized (handles circular refs, DOM nodes, functions, symbols, bigints, errors). When running inside the adapter runtime, entries flow to the MCP server; otherwise they fall back to `console` methods.

Usage in a tool handler:

```typescript
import { waitForSelector, fetchJSON, getLocalStorage, getPageGlobal, retry, log } from '@opentabs-dev/plugin-sdk';
import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';

// handle(params, context?) — context is optional and injected by the adapter runtime
async function handle(params: Input, context?: ToolHandlerContext): Promise<Output> {
  const el = await waitForSelector('.dashboard-loaded');
  const pages = await fetchPages(params.query);
  for (let i = 0; i < pages.length; i++) {
    context?.reportProgress({ progress: i + 1, total: pages.length, message: `Processing page ${i + 1}` });
    await processPage(pages[i]);
  }
  log.info('Processed all pages', { count: pages.length });
  return { processed: pages.length };
}
```

### Commands

```bash
bun install           # Install dependencies
bun run build         # Build all packages (tsc --build + side panel)
bun run type-check    # TypeScript check (tsc --noEmit)
bun run lint          # ESLint check
bun run lint:fix      # ESLint auto-fix
bun run format        # Prettier format
bun run format:check  # Prettier check
bun run knip          # Unused code detection
bun run test:e2e      # E2E tests (Playwright)
```

### Loading the Extension

1. `bun run build`
2. Open `chrome://extensions/`
3. Enable Developer mode
4. Load unpacked → select `~/.opentabs/extension` folder

### Reloading the Extension After Code Changes

The Chrome extension does NOT auto-reload. After building (`bun run build`), the extension must be manually reloaded for changes to take effect:

1. `bun run build` (builds TypeScript + side panel + copies to `~/.opentabs/extension/`)
2. Open `chrome://extensions/`
3. Find the "OpenTabs" extension card
4. Click the circular refresh/reload icon on the card
5. Close and reopen the side panel if it was open (it reconnects automatically via the offscreen document's WebSocket)

**Important**: In dev mode, the MCP server supports hot reload (`bun --hot`) so server-side changes take effect automatically after `bun run build`. But browser extension changes (background script, side panel, adapter injection logic) always require the manual reload step above. Plugin adapter changes are picked up via `POST /reload` (triggered by `opentabs-plugin build`) in both modes, and additionally via the file watcher in dev mode.

### Starting the MCP Server

**Production mode** (default) — static plugin discovery at startup, `POST /reload` for rediscovery:

```bash
opentabs start
# or directly: bun platform/mcp-server/dist/index.js
```

**Dev mode** — file watchers, config watching, hot reload:

```bash
bun --hot platform/mcp-server/dist/index.js --dev
```

Dev mode is enabled by the `--dev` CLI flag or `OPENTABS_DEV=1` environment variable. The dev mode state is exported from `platform/mcp-server/src/dev-mode.ts` as `isDev()`.

### Adding a New Plugin

Each plugin follows the same pattern:

1. **Create the plugin** (`plugins/<name>/`): Extend `OpenTabsPlugin` from `@opentabs-dev/plugin-sdk`
2. **Configure `package.json`**: Add an `opentabs` field with `displayName`, `description`, and `urlPatterns`; set `main` to `dist/adapter.iife.js`
3. **Define tools** (`plugins/<name>/src/tools/`): One file per tool using `defineTool()` with Zod schemas. The `handle(params, context?)` function receives an optional `ToolHandlerContext` as its second argument for reporting progress during long-running operations
4. **Optionally define resources and prompts**: Use `defineResource()` for data the plugin can expose (read via `resources/read`) and `definePrompt()` for prompt templates (rendered via `prompts/get`). Assign them to the `resources` and `prompts` properties on the plugin class
5. **Build**: `cd plugins/<name> && bun install && bun run build` (runs `tsc` then `opentabs-plugin build`, which produces `dist/adapter.iife.js` and `dist/tools.json`, auto-registers the plugin in `localPlugins`, and calls `POST /reload` to notify the MCP server)

### Plugin Isolation

Plugins in `plugins/` are **fully standalone projects** — exactly as if created by an external developer using `create-opentabs-plugin`. They:

- Have their own `package.json`, `tsconfig.json`, `.prettierrc`, and `.gitignore`
- Depend on published `@opentabs-dev/*` npm packages (not `file:` or `workspace:` links)
- Have their own `node_modules/` and `bun.lock`
- Are **excluded** from root `eslint`, `prettier`, `knip`, and `tsc --build`
- Must build and type-check independently: `cd plugins/<name> && bun run build`

The root tooling (`bun run build`, `bun run lint`, etc.) does NOT cover plugins. When changing platform packages that plugins depend on (`shared`, `plugin-sdk`, `plugin-tools`), publish new versions to npm and update plugin dependencies.

### Publishing Platform Packages

The platform packages `@opentabs-dev/shared`, `@opentabs-dev/mcp-server`, `@opentabs-dev/plugin-sdk`, `@opentabs-dev/plugin-tools`, `@opentabs-dev/cli`, and `@opentabs-dev/create-plugin` are published as private packages to the npm registry under the `@opentabs-dev` org. Publish order follows the dependency graph: shared → mcp-server → plugin-sdk → plugin-tools → cli → create-plugin.

**Authentication**: npm requires a single token in `~/.npmrc` with read+write access to `@opentabs-dev` packages.

**Setup (one-time)**:

```bash
# Create a granular access token at https://www.npmjs.com/settings/tokens/create
# Permissions: Read and Write, Packages: @opentabs-dev/*, Bypass 2FA enabled
echo '//registry.npmjs.org/:_authToken=<TOKEN>' > ~/.npmrc
```

**NEVER change npm package access levels** (public/private) without explicit user approval. All `@opentabs-dev` packages are private. Do not run `npm access set status=public` or equivalent commands.

**Publishing** (uses `scripts/publish.sh` which verifies auth via `npm whoami` before publishing):

```bash
./scripts/publish.sh 0.0.3
# Then update plugin deps and rebuild:
# cd plugins/<name> && bun install && bun run build
```

---

## Development Workflow

All development workflows below assume the MCP server is running in **dev mode** (`bun --hot platform/mcp-server/dist/index.js --dev`). In production mode, restart the server after any changes.

### MCP Server Changes (Hot Reload)

In dev mode, the MCP server runs as `bun --hot dist/index.js --dev`. When compiled files change, Bun re-evaluates all modules while keeping the process alive. The extension reconnects automatically.

```bash
# 1. Edit source files in platform/mcp-server/src/
# 2. Build
cd platform/mcp-server && bun run build
# 3. Done — bun --hot detects the change and reinitializes
```

**Known issue**: `bun --hot` file watchers can go stale on long-running processes (22+ hours). If `bun run build` does not trigger a hot reload (verify via the `/health` endpoint's `reloadCount`), restart the MCP server process manually. Note: `tsc` uses `writeFileSync` (in-place, preserves inodes), so this is not a kqueue inode invalidation issue — it is a bug in Bun's file watcher that surfaces on long-running processes (see oven-sh/bun#14568, oven-sh/bun#15200).

### Chrome Extension Changes

Extension changes require building and manually reloading from `chrome://extensions/`.

```bash
# 1. Edit source files in platform/browser-extension/src/
# 2. Build
bun run build
# 3. Reload extension from chrome://extensions/
```

### Plugin Changes

`opentabs-plugin build` auto-registers the plugin in `localPlugins` (first build only) and calls `POST /reload` to trigger server rediscovery. In dev mode, the file watcher also detects changes to `dist/tools.json` and `dist/adapter.iife.js`.

```bash
# 1. Edit plugin source
# 2. Build the plugin
cd plugins/<name> && bun run build
# 3. Done — build notifies the server via POST /reload
```

---

## Ralph — Parallel Task Daemon

Ralph (`.ralph/ralph.sh`) is a long-running daemon that processes PRD files in parallel using git worktrees. It dispatches up to N workers (default 3), each in an isolated worktree with its own branch, so agents never interfere with each other's builds, type-checks, or tests.

### Architecture

```
ralph.sh (daemon, polls .ralph/ for ready PRDs)
  ├── Worker 0 → git worktree .ralph/worktrees/<slug>/ → claude --print
  ├── Worker 1 → git worktree .ralph/worktrees/<slug>/ → claude --print
  └── Worker 2 → git worktree .ralph/worktrees/<slug>/ → claude --print
```

Each worker: creates worktree → `bun install` → copies PRD into worktree → launches claude → syncs PRD/progress back after each iteration → on completion: kills process group → merges branch into main → archives PRD.

### Usage

```bash
# Start daemon (continuous mode, 3 workers)
nohup bash .ralph/ralph.sh --workers 3 &

# Process current queue and exit
nohup bash .ralph/ralph.sh --workers 3 --once &

# Monitor
tail -f .ralph/ralph.log
```

### Key Design Decisions and Gotchas

- **Worktrees need `bun install`.** Each worktree gets its own `node_modules/`. Bun's global cache makes this fast (~1-2 seconds), but the install MUST happen before the agent starts.
- **Dev tooling must ignore worktrees.** ESLint, knip, and prettier will scan `.ralph/worktrees/` and `.claude/worktrees/` unless explicitly excluded. These exclusions are in `eslint.config.ts`, `knip.ts`, and `.prettierignore`. Forgetting this causes ESLint crashes (no tsconfig for worktree files) and knip reporting hundreds of false "unused files."
- **`set -e` is intentionally NOT used.** This is a long-running daemon — a single failed `mv`, `cp`, or `jq` command must not kill the entire process tree. Every failure is handled explicitly with `|| true` or `|| return 1`.
- **Process group isolation for e2e cleanup.** `set -m` gives each worker its own process group (PGID). On completion, ralph does a two-phase kill: `kill -- -PID` (PGID kill for most processes) then `kill_tree` (recursive walk via `pgrep -P` for processes that escaped via `setsid()`, like Chromium).
- **Merge conflicts leave breadcrumb files.** When a merge fails, ralph writes `.ralph/<slug>.merge-conflict.txt` with the branch name, conflicted files, and resolution instructions. The branch is preserved for manual merge.
- **Never merge a branch that has an active worktree.** Check `git worktree list` before manually merging any `ralph-*` branch — the worker may still be committing to it.
- **`--once` mode drains the full queue.** It doesn't exit after the first batch — it keeps dispatching as slots free up until both active workers AND ready PRDs are zero.
- **Recovery on restart.** Any `~running` PRDs from a crash are renamed back to ready and re-dispatched. Stale worktrees and branches from the previous run are cleaned up by `dispatch_prd`.
- **Two-phase quality checks.** RALPH.md instructs agents to iterate with fast checks (build, type-check, lint, knip, test) and only run `bun run test:e2e` once before committing. This saves 3-5 minutes per fix cycle.

### Log Format

Every line in `ralph.log` has: `HH:MM:SS [W<slot>:<objective>] <message>`. Worker output is interleaved but clearly distinguishable by tag. Timestamps are PST.

---

## Code Quality Rules

### Core Principles

You are the best frontend React engineer, the best UI/UX designer, and the best software architect. Hold yourself to the highest standard — no lazy work, no half-measures, no excuses. Every line of code you write should reflect that standard.

**Honesty over agreement. Always.** Never default to agreeing with the user. If the user's approach, assumption, or design is wrong, say so directly and explain why. Do not compliment ideas that are mediocre. Do not validate decisions that are incorrect. Provide the honest, technically accurate answer — even when it contradicts what the user believes or wants to hear. Correct mistakes clearly and respectfully. The only exception is when the user explicitly insists on their approach after being informed of the tradeoffs.

**Correctness over speed. Always.** Never be lazy. Never take the easy path when the correct path exists. Always use the correct method and best practice, even if it takes more time. Doing the right thing and keeping code clean is the highest priority — never compromise on this.

- **Think deeply before proposing solutions** - when facing a design problem, do not jump to the first working approach. Step back, understand the full architecture, identify all constraints (CSP, runtime context, injection model, etc.), and reason from first principles to find the _correct_ solution. A quick fix that works is not the same as the right design. If the platform already solves an analogous problem (e.g., file-based injection bypasses CSP), the new solution should use the same proven pattern — not invent a weaker workaround. Propose one well-thought-out design, not a sequence of increasingly less-bad ideas.
- **Never cut corners** - if the correct approach requires more code, more refactoring, or more time, that is the right approach. Shortcuts create debt that compounds.
- **Always use the right abstraction** - do not inline logic that belongs in a helper, do not duplicate code that should be shared, do not stuff unrelated concerns into the same function. Use the correct pattern for the problem.
- **Do the full job** - when fixing something, fix it completely. Update all call sites. Update all tests. Update all types. Update all documentation. Do not leave partial work.
- **Read before writing** - before changing any code, read and understand the surrounding context, existing patterns, and conventions. Match them. Do not introduce a new pattern when an established one exists.
- **Think before acting** - step back and consider the broader design before making changes. Ask: "Is this the right place for this code? Is this the right level of abstraction? Will this be clear to the next person reading it?"
- **Decide component boundaries before coding** - when building UI, determine which component owns which state and which DOM elements before writing any JSX. If controls must appear on the same row, they must live in the same component's render output. Do not split a visual unit across component boundaries and then try to patch it back together with props, slots, or wrappers. If the first attempt creates a layout problem, do not patch the symptom — redesign the boundary.
- **Never iterate in circles** - if a fix introduces a new problem, stop. Do not apply another incremental patch. Instead, re-examine the root cause and identify the correct architectural solution. Two failed attempts at the same problem means the approach is wrong, not that it needs more tweaking.
- **Search for existing solutions before inventing your own** - when facing an unfamiliar problem (runtime behavior, library quirk, platform limitation), search online for similar issues before guessing at a fix. Check official documentation, GitHub issues, and community forums (Stack Overflow, etc.) for known solutions and workarounds. The correct fix is often already documented — inventing a workaround without researching first wastes time and risks introducing a worse solution than the established one.
- **No TODO/FIXME/HACK comments** - if something needs to be done, do it now. Do not leave markers for future work as an excuse to ship incomplete code.
- **Naming matters** - spend time choosing precise, descriptive names for variables, functions, types, and files. A good name eliminates the need for a comment.
- **Delete fearlessly** - if code is unused, remove it. If a file is obsolete, delete it. Dead code is noise that obscures intent.
- **Own the codebase** - if tests, lint, or build are failing when you start a session, fix them. Do not treat pre-existing failures as someone else's problem. If the codebase is broken, it is your responsibility to make it whole before moving on. You are not a guest — you are the engineer on duty.
- **Break freely, refactor fully** - this is an internal, self-contained tool with no external consumers. Never let backwards compatibility concerns hold back the correct design. If a change introduces breaking changes, refactor all affected call sites, tests, and types in the same change. There is no excuse for keeping a worse API or pattern alive just to avoid updating callers you fully control.

### Engineering Standards

- **Write modular, clean code** - never write hacky code
- **Step back before fixing** - when fixing bugs, always consider if there's a cleaner architectural solution rather than patching symptoms
- **Prefer refactoring over quick fixes** - if a fix requires hacky code, that's a signal the underlying design needs improvement
- **Component design** - keep components focused, reusable, and well-separated
- **User experience first** - every UI decision should prioritize clarity and usability
- **Clean up unused code** - always remove dead code, unused imports, outdated comments, and obsolete files; keep the codebase lean with only what is needed

### React Best Practices

This project uses **React 19** (`^19.2.4`) with the automatic JSX runtime (`react-jsx`). Prefer modern React features and patterns, but **only when they fit the problem** — do not adopt a feature just because it is new. Every API choice should have a clear justification rooted in the current code, not in novelty.

- **Lift state to the right level** - if state needs to persist across component mount/unmount cycles, lift it to the parent rather than introducing complex patterns.
- **Minimize `useEffect`** - prefer derived state (inline computation) over effects that sync state. Effects are for external system synchronization (Chrome APIs, event listeners), not for state derivation.
- **`useRef` for non-rendering values** - timers, previous values, and DOM references belong in refs, not state.
- **`useMemo`/`useCallback` only when justified** - do not wrap trivial computations (array filters, string formatting) in `useMemo`. Reserve memoization for genuinely expensive calculations or when a stable reference is required (e.g., effect dependencies, context values).

### MCP Tools

When working on new or existing MCP tools (via plugins):

- **Tool descriptions must be accurate and informative** - descriptions are shown to AI agents, so clarity is critical for proper tool usage
- **Keep parameter descriptions clear** - explain what each parameter does and provide examples where helpful
- **Update descriptions when behavior changes** - if a tool's functionality changes, update its description immediately
- **Design for usefulness** - think about how AI agents and engineers will actually use the tool; make it intuitive and powerful
- **Design for composability** - consider how tools can work together; tools should complement each other to make this MCP server the most powerful toolset for engineers
- **Return actionable data** - tool responses should include IDs, references, and context that enable follow-up actions with other tools

### Zod Schemas and JSON Schema Serialization

Plugin tool schemas are serialized to JSON Schema (via `z.toJSONSchema()`) for the MCP protocol and plugin manifests. Keep schemas serialization-compatible:

- **Never use `.transform()` in tool input/output schemas** - Zod transforms cannot be represented in JSON Schema. If input needs normalization (e.g., stripping colons from emoji names), do it in the tool's `handle` function, not in the schema. The schema defines the wire format; the handler implements business logic.
- **Avoid Zod features that don't map to JSON Schema** - `.transform()`, `.pipe()`, `.preprocess()`, and effects produce runtime-only behavior that `z.toJSONSchema()` cannot serialize. If the serializer throws, the build breaks. Keep schemas declarative (primitives, objects, arrays, unions, literals, enums, refinements with standard validations).
- **Fix the source, not the serializer** - when a schema feature conflicts with JSON Schema serialization, the correct fix is always to simplify the schema and move logic to the handler. Do not work around serialization limitations with options like `io: 'input'` — that hides the problem and produces a schema that doesn't match the handler's actual behavior.
- **`.refine()` callbacks must never throw** - Zod 4 runs `.refine()` callbacks even when the preceding validator has already failed (e.g., `z.url().refine(fn)` calls `fn` even on non-URL strings). If the callback calls a function that can throw on invalid input (like `new URL()`), wrap it in try-catch and return `false`. Never assume the refine callback only receives values that passed the base validator.

### TypeScript Configuration

Every `.ts`/`.tsx` file in the repository must be covered by a tsconfig that `tsc --build` reaches. No file may exist in a type-checking blind spot.

- **Test files must be type-checked.** Each package has a `tsconfig.test.json` that includes `src/**/*.test.ts`. The production `tsconfig.json` excludes test files from compilation output (they don't need `.js` artifacts), but the test tsconfig ensures they are still type-checked with the same strict settings.
- **Build scripts must be type-checked.** Standalone scripts (e.g., `build-*.ts`) that live outside `src/` have their own tsconfig (e.g., `tsconfig.build-scripts.json`).
- **Root config files must be type-checked.** Files like `eslint.config.ts`, `knip.ts`, and `playwright.config.ts` are covered by `tsconfig.configs.json`.
- **Never exclude files from type-checking to avoid fixing type errors.** If a file has type errors, fix the errors. Adding the file to an `exclude` list or removing it from a tsconfig is not an acceptable workaround — it creates a blind spot where bugs accumulate silently.
- **When adding a new `.ts` file**, verify it is covered by an existing tsconfig. If `tsc --build` doesn't check it, add it to the appropriate tsconfig or create a new one and reference it from the root `tsconfig.json`.

### Verification

Once a task is complete, **always run every one of these checks** to verify the change:

```bash
bun run build         # Verify production build
bun run type-check    # TypeScript check (must pass from clean checkout)
bun run lint          # Check for lint errors
bun run knip          # Check for unused code
bun run test          # Unit tests
bun run test:e2e      # E2E tests (Playwright)
```

**Every command must exit 0.** A task is not done until all six pass. No exceptions.

- If a check fails, **fix it** — even if the failure looks pre-existing or unrelated to your change. You own the codebase.
- Do not rationalize failures ("that's a known issue", "the build is the real type-check", "this was broken before I started"). If it fails, it is your problem. Fix it or explain to the user why you cannot.
- Do not skip a check because a different check covers "the same thing". Each command tests something distinct. Run all of them.

**E2E test process cleanup:** E2E tests spawn Chromium browsers, MCP server processes, and test servers. You MUST clean up processes you create without killing processes created by other agents running in parallel. Rules:

- **Track PIDs you create.** Before running `bun run test:e2e`, note your own PID (`$$` in bash). After the test run completes (pass or fail), kill only the process tree rooted at the PID you spawned — never `pkill` or `killall` by process name, which would kill other agents' processes too.
- **Playwright handles its own cleanup** in the normal case. The concern is abnormal exits (timeout, crash, `kill -9`). If your test run is interrupted, orphaned Chromium and server processes may survive.
- **Port conflicts are already handled.** All test fixtures use `PORT=0` (ephemeral ports) and Playwright runs with `fullyParallel: true`. Multiple agents running E2E tests simultaneously will not collide on ports.
- **In ralph workers**, process isolation is automatic — ralph runs each worker in its own process group (`set -m`) and kills the entire group (`kill -- -PID`) when the worker finishes, catching any orphaned Chromium/server processes without affecting other workers.

### ESLint

- **NEVER use `eslint-disable` comments** in source code. Always fix the underlying issue.
- **NEVER add file-specific rule overrides in eslint.config.ts** to suppress lint errors. Always fix the source code instead. Time-consuming is not an excuse — we should never be lazy.
- If a rule violation occurs, investigate and fix the root cause.
- If a dependency uses deprecated APIs, update the code to use the recommended alternative.

### Code Style

- Follow all configured ESLint rules.

### Bun-First Convention

This project runs on Bun. Always prefer Bun-native APIs over Node.js equivalents unless Bun has no equivalent.

**Use Bun APIs for:**

- File reading: `Bun.file(path).text()` instead of `readFile(path, 'utf-8')` from `node:fs/promises`
- File writing: `Bun.write(path, content)` instead of `writeFile(path, content)` from `node:fs/promises`
- File deletion: `Bun.file(path).delete()` instead of `unlinkSync(path)` from `node:fs`
- File existence checks: `Bun.file(path).exists()` instead of `stat()`-based checks
- Environment variables: `Bun.env.VAR` instead of `process.env.VAR`
- CLI arguments: `Bun.argv` instead of `process.argv`
- HTTP server: `Bun.serve()` (already in use)
- Bundling: `Bun.build()` (already in use)
- Package execution: `bunx` instead of `npx`

**Keep Node.js APIs for (no Bun-native equivalent):**

- `node:path` (`join`, `resolve`, `relative`, `dirname`) — no Bun path API
- `node:os` (`homedir`, `tmpdir`) — no Bun equivalents
- `node:fs` `watch` / `FSWatcher` — no Bun file watching API
- `node:fs` directory operations (`mkdir`, `mkdirSync`, `readdir`, `stat` for directories, `existsSync` for directories) — no Bun equivalents
- `node:fs` `mkdtempSync`, `cpSync`, `rmSync` — no Bun equivalents
- `node:child_process` — in Playwright E2E tests (Playwright runs under Node.js, not Bun)

**E2E tests (`e2e/`)** run under Playwright's Node.js test runner, so Node.js APIs are correct there.

### Comments

Comments should describe **current behavior**, not historical context. Write comments that state facts about what the code does now.

**Avoid:**

- Comments explaining what code "used to do" or "was changed from"
- Negative phrasing like "we don't do X" or "don't touch Y"
- Historical markers like "previously", "legacy", "deprecated", "removed"
- Comments that only make sense if you know what the code looked like before

**Prefer:**

- Factual descriptions of current behavior
- Explanations of why current code works the way it does
- Technical rationale for design decisions

---

## Documentation Illustrations

The docs site (`docs/`) uses inline SVG illustrations as React components. All illustrations follow a unified neo-brutalist design system — every illustration must feel like part of the same family.

### Design Principles

- **One concept, one illustration.** If two pages show the same concept (e.g., the 3-component architecture), they must use the same SVG component. Never draw two separate SVGs for the same thing.
- **All illustrations live in `docs/components/illustrations.tsx`** and are registered in `docs/components/MDX.tsx` for use in `.mdx` files.
- **No ASCII art diagrams in docs.** Every diagram in documentation must be a proper SVG illustration component. Replace ASCII box-drawing with SVG.
- **Consistent visual style across all illustrations** — see the style rules below.

### Visual Style Rules

All SVG illustrations must follow the neo-brutalist style established by the existing components:

- **CSS variables for theming**: `var(--color-foreground)`, `var(--color-primary)`, `var(--color-background)` — enables light/dark mode and theme variants
- **Font**: `var(--font-mono), monospace` for all text
- **Borders**: 3px `strokeWidth` on main container borders
- **Shadows**: Hard drop shadows using an offset `<rect>` (4px right, 4px down) filled with `var(--color-foreground)` behind the main rect
- **Headers**: Box-with-header-bar pattern — header rect filled with `var(--color-foreground)`, header text in `var(--color-primary)` with `fontWeight="bold"`
- **No border-radius**: Matches `--radius: 0` from the design system
- **Arrow markers**: Triangular arrowheads filled with `var(--color-foreground)`
- **Muted labels**: `opacity="0.4"` to `0.5"` for secondary/subtitle text
- **Highlighted items**: Use `var(--color-primary)` with low opacity fill (`0.12`) and a `1.5px` stroke for emphasis
- **Dashed borders**: `strokeDasharray="4 3"` for "more items..." or optional/placeholder elements
- **Container width**: `className="w-full"` with optional `max-w-lg` or `max-w-3xl` for smaller diagrams; wrap in `<div className="my-8">`
- **Accessibility**: `aria-hidden="true"` on the `<svg>` element (illustrations are decorative; content is in the surrounding text)

### Documentation Tone

The docs follow a progressive audience path: **normal user** (Quick Start, Installation) → **plugin developer** (Guides, SDK Reference) → **platform contributor** (Contributing). The tone is:

- **Friendly and accessible** — no jargon without explanation, no assumptions about prior knowledge
- **Step-by-step and hand-holding** — explicit numbered steps, one action per step
- **Show before tell** — lead with a visual or code example, then explain
- **Concrete over abstract** — real commands, real output, real file paths

Illustrations should match this tone: clear, labeled, approachable. Prefer showing the "happy path" flow over comprehensive architecture diagrams. Use annotations and labels generously.

---

## Keeping CLAUDE.md Up to Date

**Important**: This file should remain **plugin-agnostic**. Do not enumerate individual plugins or tools by name. The codebase grows by adding new plugins — documentation should describe patterns and conventions, not inventories.

Guidelines for updates:

- Keep additions **high-level** — avoid excessive detail that wastes context
- Focus on **architecture, patterns, and conventions** — not per-plugin details
- **Never list individual plugins** (e.g. "Slack, Datadog, ...") — use generic terms like "plugins" and reference the code structure for discovery
- Remove outdated information that no longer applies
