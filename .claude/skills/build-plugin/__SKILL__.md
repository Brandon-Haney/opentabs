# Build Plugin Skill

Build a production-ready OpenTabs plugin for any web application. This skill guides the full workflow from reconnaissance through implementation to testing.

---

## Prerequisites

- The user has the target web app open in a browser tab
- The `opentabs` CLI is installed globally
- The MCP server is running (`opentabs start` or `npm run dev:mcp`)

### Browser Tool Permissions

Plugin development requires heavy use of browser tools (`browser_execute_script`, `browser_navigate_tab`, `browser_get_tab_content`, etc.) for exploring the target web app. By default, all tools have permission `'off'` (disabled). Tools set to `'ask'` require human approval in the Chrome extension side panel before executing.

**Before starting, ask the user if they want to enable `skipPermissions`** to bypass approval prompts during the development session. This converts `'ask'` tools to `'auto'` (execute immediately), dramatically speeding up exploration and testing. Tools set to `'off'` remain disabled.

Set the env var: `OPENTABS_DANGEROUSLY_SKIP_PERMISSIONS=1`

Alternatively, set specific plugins or tools to `'auto'` in `~/.opentabs/config.json`:
```json
{ "permissions": { "__browser__": { "permission": "auto" } } }
```

**Warn the user**: `skipPermissions` bypasses human approval for tool operations. It should only be used during active plugin development sessions and unset afterward.

If the user declines, set browser tools to `'ask'` permission and plan for manual approvals — use read-only tools like `opentabs_plugin_list_tabs` (no approval needed when set to `'auto'`) where possible, and batch browser tool calls to minimize the number of approvals needed.

---

## Core Principle: Use the Real APIs, Never the DOM

**Every tool must use the same APIs the web app's own frontend uses to communicate with its backend.** The adapter runs in the page's MAIN world — it is indistinguishable from the web app's own JavaScript. If the web app can fetch data from its backend, the plugin can too, using the exact same endpoints, headers, and auth mechanism.

**DOM scraping is never acceptable as a tool implementation.** Reading from DOM elements, parsing rendered HTML, clicking UI buttons, or filling form fields are hacks — they are fragile (break on any UI change), limited (only see what's on screen), and slow (require rendering and waiting). A tool that reads data from the DOM instead of calling the API the web app uses to fetch that data is a failed implementation.

**This applies to all operations:**
- **Reading data** — call the same API endpoints the web app calls, not `document.querySelector`
- **Writing data** — call the same mutation/action APIs, not `button.click()` or `input.value = ...`
- **Navigation/state** — acceptable to use URL hash changes for SPA routing, but data must come from APIs

**When the API is hard to discover or authenticate:**
- **Do not give up and fall back to DOM.** Spend the time in Phase 3 to fully reverse-engineer the web app's API communication. Install XHR/fetch interceptors, capture request/response pairs, study headers and auth tokens.
- **Monkey-patch `XMLHttpRequest` and `fetch`** at adapter load time to capture auth tokens (XSRF tokens, action tokens, session identifiers) from the web app's own requests as they happen.
- **Study the web app's internal state** — page globals (`window.GLOBALS`, `window.__INITIAL_STATE__`), `gapi`, inline script data, etc. — to extract API endpoints, keys, and configuration.
- **Replay the exact same requests** the web app makes, with the same headers, same body format, same auth. If the web app uses protobuf-like JSON, binary encoding, or custom RPC, replicate that format.
- **If a public REST API exists but requires OAuth2** and the page doesn't expose an access token, look for internal/first-party API endpoints on the same origin that accept cookie auth. Most web apps have internal APIs that bypass OAuth — the public REST API is for third-party integrations.

The only acceptable uses of the DOM in a plugin are:
1. **`isReady()` authentication detection** — checking page globals, meta tags, or DOM signals to determine if the user is logged in
2. **URL hash navigation** — using `window.location.hash` for SPA routing (which triggers the app's own data fetching)
3. **Last-resort compose/send flows** — only if the web app genuinely has no API for the operation (extremely rare)

---

## Phase 1: Research the Codebase

Before writing any code, study the existing plugin infrastructure. Use the Task tool with `explore` agent for each of these:

1. **Study the Plugin SDK** — read `platform/plugin-sdk/CLAUDE.md` and key source files (`src/index.ts`, `src/plugin.ts`, `src/tool.ts`). Understand:
   - `OpenTabsPlugin` abstract base class (name, displayName, description, urlPatterns, tools, isReady)
   - `defineTool({ name, displayName, description, icon, input, output, handle })` factory
   - `ToolError` static factories: `.auth()`, `.notFound()`, `.rateLimited()`, `.timeout()`, `.validation()`, `.internal()`
   - SDK utilities: `fetchJSON`, `postJSON`, `getLocalStorage`, `waitForSelector`, `retry`, `sleep`, `log`
   - All plugin code runs in the **browser page context** (not server-side)

2. **Study the Slack plugin** (`plugins/slack/`) — this is the canonical reference:
   - `src/index.ts` — plugin class, imports all tools
   - `src/slack-api.ts` — API wrapper with auth extraction + error classification
   - `src/tools/` — one file per tool, shared schemas in `channel-schema.ts`
   - `package.json` — the opentabs field, dependency versions, scripts

3. **Study `plugins/CLAUDE.md`** — plugin isolation rules and conventions

---

## Phase 2: Scaffold the Plugin

```bash
cd plugins/
opentabs plugin create <name> --domain <domain> --display <DisplayName> --description "OpenTabs plugin for <DisplayName>"
```

### Post-Scaffold Adjustments

The scaffolded `package.json` needs adjustments to match the established pattern. Compare with `plugins/slack/package.json` and align:

- **Package name**: Change to `@opentabs-dev/opentabs-plugin-<name>` for official plugins
- **Version**: Match the current platform version (check `plugins/slack/package.json` for the right version)
- **Add fields**: `publishConfig`, top-level `description`, `check` script
- **Dependency versions**: Match `@opentabs-dev/plugin-sdk` and `@opentabs-dev/plugin-tools` versions to what Slack uses
- **Dev script**: Use `tsc --watch --preserveWatchOutput & opentabs-plugin build --watch` (shell background, no concurrently)
- **Remove**: `concurrently` from devDependencies if present
- **Dev dependencies**: Match versions of @biomejs/biome, typescript, zod to what Slack uses

---

## Phase 3: Explore the Target Web App

This is the most critical phase. Use browser tools to understand how the web app works.

### Step 1: Find the Tab

```
opentabs_browser_list_tabs  →  find the target tab ID
```

### Step 2: Enable Network Capture

```
opentabs_browser_enable_network_capture(tabId, urlFilter: "/api")
```

Then navigate around in the app to trigger API calls, and read them:

```
opentabs_browser_get_network_requests(tabId)
```

Study the captured traffic to understand:

- API base URL (e.g., `https://app.example.com/api/v2`)
- **Whether the API is same-origin or cross-origin** (critical for CORS planning)
- Request format (JSON body vs form-encoded)
- Required headers (content-type, custom headers like `X-Workspace-Id`)
- Response shapes for each endpoint
- Error response format

**Note**: Authorization headers are redacted by the capture tool. You must discover the auth token format through other means.

### Step 2b: Check CORS Policy (for Cross-Origin APIs)

If the API is on a different subdomain (e.g., `api.example.com` when the page is on `app.example.com`), verify CORS behavior before writing any API code:

```bash
curl -sI -X OPTIONS https://api.example.com/endpoint \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Authorization,Content-Type" \
  | grep -i "access-control"
```

What to look for:

- `access-control-allow-origin: *` — CORS allowed, but **`credentials: 'include'` will NOT work** (browser rejects cookies with wildcard origin). Only token-based auth works.
- `access-control-allow-origin: https://app.example.com` + `access-control-allow-credentials: true` — Full cookie auth works with `credentials: 'include'`.
- No CORS headers — Cross-origin requests are fully blocked; must use same-origin endpoints.

**Same-origin API fallback**: Many apps expose same-origin API proxies or internal endpoints. Look for:

- `/api/...` paths on the same domain
- `/_graphql` internal GraphQL endpoint
- JSON responses from standard page URLs with `Accept: application/json`

### Step 3: Discover Auth Token

**First, always check cookies with `opentabs_browser_get_cookies`** to understand the auth model:

- Look for `httpOnly: true` cookies — these are session tokens the browser sends automatically but JS cannot read
- If auth is HttpOnly cookie-based, skip trying to extract the token; instead detect auth from the DOM (meta tags, page globals) and let `credentials: 'include'` send the cookies automatically
- Look for non-HttpOnly tokens that can be read with `getCookie()`

Use `opentabs_browser_execute_script` to probe the page for auth tokens. The tool bypasses page CSP via file-based injection and works on all pages regardless of Content Security Policy. Try these strategies in order:

**Strategy A: localStorage** (most common)

```javascript
// Try direct access first
const token =
  localStorage.getItem("token") || localStorage.getItem("access_token");

// If localStorage is undefined (some SPAs delete it), use iframe fallback
if (typeof window.localStorage === "undefined") {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  document.body.appendChild(iframe);
  const token = iframe.contentWindow.localStorage.getItem("token");
  document.body.removeChild(iframe);
}
```

**Strategy B: Page globals**

```javascript
// Check common globals
window.__APP_STATE__;
window.boot_data;
window.__NEXT_DATA__;
window.__INITIAL_STATE__;
```

**Strategy C: Webpack module stores** (for React/webpack SPAs)

```javascript
let wreq = null;
window.webpackChunkapp_name.push([
  [Symbol()],
  {},
  (r) => {
    wreq = r;
  },
]);
window.webpackChunkapp_name.pop();
// Then search wreq.c (cached modules) for store objects with getToken methods
```

**Strategy D: Cookies**

```javascript
document.cookie; // Look for session tokens, JWT cookies
```

**Strategy E: Script tag scanning**

```javascript
// Search inline <script> tags for embedded tokens/config
document.querySelectorAll("script:not([src])").forEach((s) => {
  if (s.textContent.includes("token"))
    console.log(s.textContent.substring(0, 500));
});
```

### Step 4: Test the API

Once you have the token, make a test API call:

```javascript
const resp = await fetch("https://example.com/api/v2/me", {
  headers: { Authorization: "Bearer " + token },
  credentials: "include",
});
const data = await resp.json();
```

Verify the response shape and that auth works.

### Step 5: Intercept Internal API Traffic (for apps without clean REST APIs)

Some web apps (e.g., Gmail, Google Docs) don't expose clean REST APIs from the page context. They communicate with their backend through internal RPC endpoints, protobuf-encoded JSON, or proprietary batch APIs. The public REST API may require OAuth2 tokens that the page doesn't expose.

**When standard auth extraction fails, use XHR/fetch interception to capture the app's own API calls:**

```javascript
// Install XHR interceptor in browser_execute_script to capture all requests
const requests = [];
const origOpen = XMLHttpRequest.prototype.open;
const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url) {
  this.__url = url; this.__method = method; this.__headers = {};
  return origOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
  if (this.__headers) this.__headers[name] = value;
  return origSetHeader.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function(body) {
  requests.push({
    method: this.__method, url: String(this.__url).substring(0, 300),
    headers: this.__headers, bodyLen: body ? String(body).length : 0
  });
  return origSend.apply(this, arguments);
};
window.__capturedRequests = requests;
```

Then trigger actions in the web app (click emails, navigate, search) and examine `window.__capturedRequests` to discover:
- The actual API endpoints the app uses (may be internal RPC, not the public REST API)
- Auth headers (XSRF tokens, action tokens, SAPISIDHASH, session identifiers)
- Request body format (JSON, protobuf-JSON, form-encoded)
- Required custom headers

**In the adapter IIFE, install the same XHR interception at load time** to capture auth tokens from the web app's own requests as they happen. The adapter runs before the page finishes loading, so it catches early boot requests that set up sessions and auth.

Also install response interceptors to capture response formats:

```javascript
// Add to the send interceptor to capture responses
xhr.addEventListener('load', function() {
  if (String(xhr.__url).includes('/api/') || String(xhr.__url).includes('/sync/')) {
    responses.push({
      url: xhr.__url, status: xhr.status,
      contentType: xhr.getResponseHeader('content-type'),
      body: xhr.responseText?.substring(0, 2000)
    });
  }
});
```

### Step 6: Map the API Surface

Make test calls to discover the key API endpoints. For a typical web app, look for:

- User/profile endpoint
- List resources (channels, projects, items, etc.)
- Get single resource
- Create/update/delete resources
- Search
- Messaging/comments
- Reactions/likes

---

## Phase 4: Design the Tool Set

**Maximize API coverage.** Add as many tools as the web service's API supports. The goal is a comprehensive, production-ready plugin that exposes the full power of the service to MCP clients. Do not stop at a minimal set — if the API has an endpoint, the plugin should have a tool for it.

Model the tool set after the Slack plugin. A typical production plugin has 15-25+ tools across these categories:

**Messaging/Content:**

- `send_message` — create new content
- `edit_message` — modify existing content
- `delete_message` — remove content
- `read_messages` — list/paginate content
- `search_messages` — search with filters

**Resources/Containers:**

- `list_<resources>` — list containers (channels, projects, boards)
- `get_<resource>_info` — get details for one container
- `create_<resource>` — create a new container

**Users/Members:**

- `list_members` — list users in a container
- `get_user_profile` — get user details

**Interactions:**

- `add_reaction` / `remove_reaction`
- `pin_message` / `unpin_message`

**Platform-specific:**

- Add tools unique to the platform (threads, DMs, file uploads, etc.)

**Coverage checklist** — for each API resource the service exposes, ask: can the user list it, get one, create one, update one, delete one, and search/filter it? If yes and the API supports it, add the tool. Every endpoint that an MCP client might reasonably want to call should be covered.

---

## Phase 5: Implement

### File Structure

```
src/
  index.ts              # Plugin class — imports all tools, implements isReady()
  <name>-api.ts         # API wrapper — auth extraction + error classification
  tools/
    schemas.ts          # Shared Zod schemas + defensive mappers
    send-message.ts     # One file per tool
    edit-message.ts
    ...
```

### API Wrapper Pattern (`<name>-api.ts`)

This is the most critical file. Follow this pattern:

```typescript
import { ToolError } from "@opentabs-dev/plugin-sdk";

interface AppAuth {
  token: string;
  // Add other auth fields as needed (workspace URL, team ID, etc.)
}

// --- Auth extraction ---
const getAuth = (): AppAuth | null => {
  // Try localStorage (with iframe fallback if needed)
  // Try page globals
  // Try cookies
  // Return null if not authenticated
};

export const isAuthenticated = (): boolean => getAuth() !== null;

// SPA hydration: poll for auth to become available after page load
export const waitForAuth = (): Promise<boolean> =>
  new Promise((resolve) => {
    let elapsed = 0;
    const interval = 500;
    const maxWait = 5000;
    const timer = setInterval(() => {
      elapsed += interval;
      if (isAuthenticated()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (elapsed >= maxWait) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });

// --- API caller ---
export const api = async <T extends Record<string, unknown>>(
  endpoint: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth("Not authenticated — please log in.");

  // Build URL with query params
  let url = `https://example.com/api/v2${endpoint}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  // Set headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
  };
  let fetchBody: string | undefined;
  if (options.body) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(options.body);
  }

  // Make request with 30-second timeout
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: fetchBody,
      credentials: "include",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError")
      throw ToolError.timeout(`API request timed out: ${endpoint}`);
    if (err instanceof DOMException && err.name === "AbortError")
      throw new ToolError("Request was aborted", "aborted");
    throw new ToolError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
      "network_error",
      {
        category: "internal",
        retryable: true,
      },
    );
  }

  // Classify HTTP errors
  if (!response.ok) {
    const errorBody = (await response.text().catch(() => "")).substring(0, 512);
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const retryMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      throw ToolError.rateLimited(
        `Rate limited: ${endpoint} — ${errorBody}`,
        retryMs,
      );
    }
    if (response.status === 401 || response.status === 403)
      throw ToolError.auth(`Auth error (${response.status}): ${errorBody}`);
    if (response.status === 404)
      throw ToolError.notFound(`Not found: ${endpoint} — ${errorBody}`);
    throw ToolError.internal(
      `API error (${response.status}): ${endpoint} — ${errorBody}`,
    );
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};
```

### Tool Pattern (one file per tool)

```typescript
import { defineTool } from "@opentabs-dev/plugin-sdk";
import { z } from "zod";
import { api } from "../<name>-api.js";
import { mapMessage, messageSchema } from "./schemas.js";

export const sendMessage = defineTool({
  name: "send_message", // snake_case, auto-prefixed with plugin name
  displayName: "Send Message", // Title Case
  description:
    "Send a message to a Slack channel or thread. " +
    "Supports Slack mrkdwn formatting.", // detailed for MCP AI clients — this is what Claude sees
  summary: "Send a message to a channel or thread", // short, human-readable — shown in the side panel UI
  icon: "send", // valid Lucide icon name
  input: z.object({
    channel: z.string().describe("Channel ID to send the message to"), // .describe() on EVERY field
    content: z.string().describe("Message text content"),
  }),
  output: z.object({
    message: messageSchema.describe("The sent message"),
  }),
  handle: async (params) => {
    const data = await api<Record<string, unknown>>(
      "/channels/" + params.channel + "/messages",
      {
        method: "POST",
        body: { content: params.content },
      },
    );
    return { message: mapMessage(data) }; // defensive mapping with fallback defaults
  },
});
```

### Shared Schemas Pattern (`tools/schemas.ts`)

```typescript
import { z } from "zod";

export const messageSchema = z.object({
  id: z.string().describe("Message ID"),
  channel_id: z.string().describe("Channel ID"),
  content: z.string().describe("Message text content"),
  timestamp: z.string().describe("ISO 8601 timestamp"),
});

// Defensive mapper with fallback defaults
export const mapMessage = (m: Record<string, unknown> | undefined) => ({
  id: (m?.id as string) ?? "",
  channel_id: (m?.channel_id as string) ?? "",
  content: (m?.content as string) ?? "",
  timestamp: (m?.timestamp as string) ?? "",
});
```

### Plugin Class Pattern (`index.ts`)

```typescript
import { OpenTabsPlugin } from "@opentabs-dev/plugin-sdk";
import type { ToolDefinition } from "@opentabs-dev/plugin-sdk";
import { isAuthenticated, waitForAuth } from "./<name>-api.js";
import { sendMessage } from "./tools/send-message.js";
// ... import all tools

class MyPlugin extends OpenTabsPlugin {
  readonly name = "<name>";
  readonly description = "OpenTabs plugin for <DisplayName>";
  override readonly displayName = "<DisplayName>";
  readonly urlPatterns = ["*://*.example.com/*"];
  readonly tools: ToolDefinition[] = [sendMessage /* ... all tools */];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth(); // poll for SPA hydration
  }
}

// IMPORTANT: isReady() must be robust. It determines whether the plugin
// shows as "ready" or "unavailable" in the side panel. A fragile isReady()
// that returns false on valid authenticated pages makes the entire plugin
// unusable. Use multiple detection strategies with fallbacks:
//
// 1. Primary: check page globals (window.__initialData.isAuthenticated)
// 2. Secondary: check non-HttpOnly indicator cookies (document.cookie)
// 3. Tertiary: check DOM signals (sidebar elements, user menus)
// 4. Fallback: if on the app's domain and NOT on a login page, assume authed
//
// The polling pattern (500ms interval, 5s max) handles SPA hydration delays.
// Always test isReady() by reloading the page and verifying the plugin
// transitions to "ready" within a few seconds.

export default new MyPlugin();
```

---

## Phase 6: Build and Test

### Build

```bash
cd plugins/<name>
npm install
npm run build        # tsc + opentabs-plugin build
```

Build produces:

- `dist/adapter.iife.js` — the browser-injectable adapter
- `dist/tools.json` — manifest with JSON schemas
- Auto-registers in `~/.opentabs/config.json`
- Notifies MCP server via `POST /reload`

### Fix Lint/Format Issues

```bash
npm run lint:fix     # auto-fix Biome lint issues
npm run format       # format all files with Biome
```

### Full Check Suite

```bash
npm run check        # build + type-check + lint + format:check
```

**Every command must exit 0.** Fix any failures before proceeding.

### Test with Real Browser Tab

1. Verify the plugin loaded:

   ```
   opentabs_plugin_list_tabs(plugin: "<name>")
   ```

   Must show `state: "ready"` and `ready: true` for the matching tab.

2. Call each tool and verify it returns expected data. Start with read-only tools (list, get) before write tools (send, create, delete).

3. Test error cases: invalid IDs, missing permissions, etc.

---

## Phase 7: Document Friction and Feed Back

This phase is **mandatory**. Every plugin build surfaces friction in the platform and new learnings about how to develop plugins well. Capturing them closes the loop.

### 1. Document Friction Encountered

While building and testing, keep a running mental note of anything that slowed you down, required workarounds, or was confusing. After the plugin is working, think across **three dimensions of friction**:

**Platform bugs and rough edges** — things that were broken or wrong:
- Scaffolder generated wrong versions, missing fields, or unhelpful defaults
- A platform API returned an unexpected shape or error
- A build/lint/type-check failure caused by a platform issue (not a plugin bug)
- A browser tool limitation that required a workaround

**Missing SDK capabilities** — things you had to hand-roll that the SDK should provide:
- Ask: *"If the SDK had a helper for X, would virtually every plugin developer hit this same need?"*
- Examples of things that clear the bar: retry logic, cookie parsing, request timeout wiring, token persistence boilerplate — these are universal to all plugins regardless of what app they target
- Examples of things that do NOT clear the bar: resolving a Notion workspace ID, normalizing a Discord message shape, handling Slack's rate limit headers — these are app-specific, not platform-level concerns
- **The test is universality, not frequency.** Something that every plugin needs once beats something a few plugins need repeatedly. If the need is tied to a specific app's quirks, it belongs in that plugin — not in the SDK.

**Missing documentation or guidance** — things that required trial and error to discover:
- Auth patterns not covered in the scaffold comments or skill
- API behaviors that weren't obvious and required `browser_execute_script` experimentation
- Conventions that exist in the codebase but aren't written down anywhere

For each friction point, ask: **is this something the platform team can fix or add?** If yes, it belongs in a PRD.

### 2. Create PRDs for Friction Fixes

Use the `ralph` skill to create a PRD for any actionable friction. Run it at the end once all friction is identified — batch related fixes into one PRD where they touch the same files:

```
/ralph  create PRD for <brief description of friction>
```

Each PRD story must:
- Target exactly one file or closely related set of files
- Have a concrete acceptance criterion (not "works better")
- Be completable by a fresh AI agent in one iteration

### 3. Write Learnings Back to This Skill

After building the plugin, update this file (`__SKILL__.md`) with any new patterns or gotchas discovered. Follow these rules:

**Before adding anything:**
- Read the existing Common Gotchas list and all named sections
- Check whether the insight is already covered — if it is, skip or merge rather than add
- Ask: *does this save meaningful time for the next agent, or is it obvious from context?*

**What belongs here:**
- Auth patterns specific to a new class of web app (not already covered)
- API quirks that are non-obvious and will recur (e.g., response shape varies by endpoint)
- Platform constraints that bite developers repeatedly
- Concrete workarounds for known gotchas

**What does NOT belong here:**
- App-specific details that won't recur (e.g., "Notion uses space IDs")
- Learnings already captured in an existing gotcha
- Notes that belong in the plugin's own README

**Deduplication is required:** After adding anything, scan the full gotcha list for overlap with existing items. Merge if two gotchas teach the same lesson. The list should always be the shortest version that conveys maximum value.

---

## Key Conventions

- **One file per tool** in `src/tools/`
- **Every Zod field gets `.describe()`** — this is what AI agents see in the tool schema. Descriptions must be specific and informative (e.g., `"Channel ID to send the message to (e.g., C01234567)"` not just `"The channel"`). The MCP client relies entirely on these descriptions to understand how to call the tool correctly.
- **`description` is for MCP AI clients** — write a detailed, informative description that helps Claude (or other AI agents) understand when and how to use the tool. Include parameter semantics, supported formats, and behavioral notes. This is what appears in the MCP `tools/list` response.
- **`summary` is for humans in the side panel** — write a short (under 80 chars), plain-English sentence. The side panel tooltip and inline description show `summary` when available, falling back to `description`. Every tool must have both fields.
- **Every tool must be production-ready** — proper input validation via Zod schemas, correct output typing, comprehensive error handling, and tested against the live API. No stubs, no placeholder implementations, no "TODO" tools.
- **Every tool must work** — every tool must be verified against the live browser before the plugin is considered complete. A tool that returns wrong data or errors on valid input is worse than no tool at all.
- **Defensive mapping** with fallback defaults (`data.field ?? ''`) — never trust API response shapes
- **`context` parameter is optional**: `handle: async (params, context?) => { ... }`
- **Tools return objects**, never raw primitives
- **Error classification is critical** — use `ToolError` factories, never throw raw errors
- **`credentials: 'include'`** on all fetch calls — required for cookie-based auth
- **30-second timeout** via `AbortSignal.timeout(30_000)` on all fetch calls
- **`.js` extension** on all imports (ESM requirement): `import { api } from '../<name>-api.js'`
- **Zod schemas must be declarative** — no `.transform()`, `.pipe()`, `.preprocess()` (breaks JSON Schema serialization)

---

## Token Persistence Pattern

The adapter IIFE is re-executed when the Chrome extension reloads (e.g., during development, updates, or hot reload). Module-level variables like `let cachedAuth = null` are reset to their initial values on re-injection. If the host app has already deleted the token from localStorage by this point, the plugin becomes unavailable.

**Solution**: Persist auth tokens to `globalThis.__openTabs.tokenCache.<pluginName>` which survives adapter re-injection (the page itself isn't reloaded, only the IIFE is re-executed).

```typescript
// Persist token to globalThis (survives adapter re-injection)
const getPersistedToken = (): string | null => {
  try {
    const ns = (globalThis as Record<string, unknown>).__openTabs as
      | Record<string, unknown>
      | undefined;
    const cache = ns?.tokenCache as
      | Record<string, string | undefined>
      | undefined;
    return cache?.myPlugin ?? null;
  } catch {
    return null;
  }
};

const setPersistedToken = (token: string): void => {
  try {
    const g = globalThis as Record<string, unknown>;
    if (!g.__openTabs) g.__openTabs = {};
    const ns = g.__openTabs as Record<string, unknown>;
    if (!ns.tokenCache) ns.tokenCache = {};
    const cache = ns.tokenCache as Record<string, string | undefined>;
    cache.myPlugin = token;
  } catch {}
};

const clearPersistedToken = (): void => {
  try {
    const ns = (globalThis as Record<string, unknown>).__openTabs as
      | Record<string, unknown>
      | undefined;
    const cache = ns?.tokenCache as
      | Record<string, string | undefined>
      | undefined;
    if (cache) cache.myPlugin = undefined;
  } catch {}
};

// In getAuth():
const getAuth = (): Auth | null => {
  const persisted = getPersistedToken();
  if (persisted) return { token: persisted };

  const raw = readLocalStorage("token");
  if (!raw) return null;
  // ... parse token ...
  setPersistedToken(token);
  return { token };
};
```

Always clear the persisted token on 401 responses to handle token rotation.

---

## Adapter Injection Timing

Adapters are injected at **two points** during page load:

1. **`status: 'loading'`** — before page JavaScript runs. The adapter IIFE registers on `globalThis.__openTabs` and can read localStorage/cookies before the host app modifies them.
2. **`status: 'complete'`** — after page is fully loaded. The adapter is re-injected (idempotent) and `isReady()` is probed to determine tab state.

This means:

- `isReady()` may be called twice — once at loading time (when page globals don't exist yet) and once at complete time (when everything is ready). The polling pattern handles this naturally.
- Auth tokens read from localStorage at loading time are available before the host app can delete them. Cache them immediately.

---

## Error Classification Best Practices

**Parse the API response body for error codes before classifying by HTTP status.** Many web apps reuse HTTP status codes for different error types:

```typescript
// BAD: classify by HTTP status only
if (response.status === 403) throw ToolError.auth("..."); // Wrong for permission errors!

// GOOD: parse body first, fall back to HTTP status
const errorBody = await response.text();
let apiCode: number | undefined;
try {
  apiCode = (JSON.parse(errorBody) as { code?: number }).code;
} catch {}

if (apiCode !== undefined) {
  if (VALIDATION_ERRORS.has(apiCode)) throw ToolError.validation("...");
  if (NOT_FOUND_ERRORS.has(apiCode)) throw ToolError.notFound("...");
  if (AUTH_ERRORS.has(apiCode)) throw ToolError.auth("...");
}
// Fall back to HTTP status
if (response.status === 401 || response.status === 403)
  throw ToolError.auth("...");
```

---

## Testing Checklist

After implementing all tools, test these scenarios:

1. **Fresh page load** — verify `isReady()` returns true and all tools work
2. **Wait for host app initialization** — verify tools still work after the host app finishes its boot process (some apps delete localStorage, modify globals, etc.)
3. **Extension reload** — reload the Chrome extension (`opentabs_extension_reload`), then verify the plugin stays ready and tools still work (tests globalThis token persistence)
4. **Multiple extension reloads** — verify consistency across repeated re-injections
5. **Full page reload** — verify the clean path works (fresh token from localStorage)
6. **Error cases** — test with invalid IDs, missing permissions, rate limiting

### Browser Tool Confirmations

When using browser tools during testing (like `browser_navigate_tab`, `browser_execute_script`), tools with `'ask'` permission require **human approval** in the Chrome extension side panel before executing.

- Use `opentabs_plugin_list_tabs` (set to `'auto'` by default with `skipPermissions`) to check plugin state
- Ask the user to watch the side panel when you need to call tools set to `'ask'`
- If a tool returns a "denied by the user" error, ask the user to approve and retry

---

## Common Gotchas

1. **All plugin code runs in the browser** — no Node.js APIs, no filesystem, no server-side logic
2. **SPAs hydrate asynchronously — `isReady()` must be robust** — `isReady()` must poll, not just check once (500ms interval, 5s max wait). Use multiple detection strategies with fallbacks (page globals → cookies → DOM → URL-based heuristic). A single fragile check (e.g., only looking for a specific CSS class) will break when the app updates its UI. Always test `isReady()` by reloading the Sentry/target page and verifying the plugin reaches "ready" state within seconds.
3. **Some apps delete browser APIs** — Discord deletes `window.localStorage`; use iframe fallback when `typeof window.localStorage === 'undefined'`
4. **Tokens must persist on globalThis** — module-level variables are reset when the extension reloads and re-injects the adapter. Use `globalThis.__openTabs.tokenCache.<pluginName>` instead.
5. **API responses may return arrays** — when the generic type expects `Record<string, unknown>` but the endpoint returns an array, use `Array.isArray(data) ? (data as T[]).map(...) : []`
6. **Parse error response bodies before HTTP status** — web apps reuse 403 for both auth and permission errors. The error code in the body distinguishes them.
7. **Icons must be valid Lucide names** — TypeScript catches invalid ones at build time
8. **Biome formatting** — always run `npm run format` after writing code; the project's config may differ from your defaults
9. **The `opentabs` field in `package.json`** is how the platform discovers plugin metadata — `displayName`, `description`, and `urlPatterns` must be there
10. **Browser tools require approval when set to 'ask'** — `browser_navigate_tab`, `browser_execute_script`, etc. show a confirmation dialog when their permission is `'ask'`. Use `skipPermissions` or set tools to `'auto'` during development.
11. **`browser_execute_script` bypasses page CSP** — The tool injects code via a file URL (`chrome.scripting.executeScript({ files: [...] })`), which runs as extension-origin code and is not subject to the page's Content Security Policy. This means `browser_execute_script` works on all pages, including strict-CSP sites like GitHub. The adapter IIFE uses the same file-based injection mechanism — plugin code also bypasses CSP on strict pages.
12. **HttpOnly cookies are invisible to plugin code** — `getCookie()` uses `document.cookie`, which cannot read HttpOnly cookies. Most session cookies are HttpOnly. Always check the cookie `httpOnly` property when exploring auth (use `browser_get_cookies`). For HttpOnly cookie auth, detect auth indirectly: from `<meta>` tags the server embeds in HTML (e.g., `<meta name="user-login">`), from non-HttpOnly indicator cookies (e.g., Notion's `notion_user_id`), from page globals (`window.__APP_STATE__`), or from localStorage. The API calls still work with `credentials: 'include'` because the browser sends HttpOnly cookies automatically — you just can't read them in JS. Auth persistence still matters — persist the *user context* (user ID, workspace ID) on globalThis even when the auth token itself is in HttpOnly cookies. See the "Cookie-Based Auth Pattern" section below.
13. **Cross-origin API + cookies: check CORS before choosing fetch strategy** — When the API is on a different subdomain (e.g., `client-api.example.com` for an `example.com` plugin), verify CORS with `curl -sI -X OPTIONS <api-url> -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST"`. Three outcomes: (a) `allow-origin: https://example.com` + `allow-credentials: true` — direct `fetch()` with `credentials: 'include'` works perfectly; the browser sends HttpOnly cookies and sets correct Origin/Referer headers; this is the ideal path and works for cross-subdomain APIs (same registrable domain); (b) `allow-origin: *` — `credentials: 'include'` is rejected by the browser; use token-based auth extracted from the page instead; (c) no CORS headers — cross-origin requests are blocked; find same-origin internal endpoints. **Always use direct in-page `fetch()` for cookie-based auth** — the adapter runs in the page's MAIN world, so from the browser's perspective it is page JavaScript; `credentials: 'include'` sends cookies just like the web app's own code does.
14. **Scaffolder uses double quotes; Biome wants single quotes** — The `opentabs plugin create` scaffold generates TypeScript with double quotes, but the Biome config uses `quoteStyle: 'single'`. Always run `npm run format` immediately after scaffolding.
15. **Internal API format may differ between endpoints** — The same app may wrap API responses differently across endpoints. Example: Notion's `getRecordValues` returns `block[id].value` (direct), while `queryCollection` returns `block[id].value.value` (extra wrapper with `role` field). Always verify the response shape of each endpoint individually by inspecting the actual response in `browser_execute_script` rather than assuming consistency. Build defensive accessor functions or check both nesting levels.
16. **CRDT-enabled workspaces may reject write operations** — Modern web apps are migrating to CRDTs for real-time collaboration. The older `submitTransaction` API may fail with "User does not have edit access" even on pages the user owns. This is because the CRDT system requires operations in a different format. When write operations fail unexpectedly, check if the app has a CRDT migration flag or a different write endpoint.
17. **`setPersistedToken` must avoid `??=` assignment-in-expression** — The Biome lint rule `noAssignInExpressions` forbids `(obj.prop ??= value)`. Use explicit if-checks instead: `if (!obj.prop) obj.prop = value`.
18. **Scaffolder `package.json` needs manual adjustments** — The scaffold creates a minimal `package.json` that is missing fields that official plugins need: scoped `@opentabs-dev/` package name, matching version with platform, `publishConfig`, `jiti` dev dependency, correct `zod` version matching other plugins. Always compare with an existing plugin's `package.json` and align.
19. **GraphQL APIs may differ between query types** — The same logical field may not exist on all connection types. Example: Linear's `searchIssues` supports `totalCount` but `issues` (the filter-based query) does not. Similarly, `orderBy` enum values vary between connections. Always verify each GraphQL query independently against the live API rather than assuming consistency across query types.
20. **Test every tool against the live browser** — The `opentabs_plugin_list_tabs` tool is the first thing to verify (no confirmation needed). Then systematically test read-only tools (search, list, get) before write tools (create, update, delete). This catches auth issues, API format mismatches, and schema mapping errors early.
21. **Cookie-based auth APIs may require CSRF tokens for writes** — Many web apps (especially Django-based ones like Sentry) use HttpOnly session cookies for auth but require a CSRF token in a header for non-GET requests. The CSRF token is typically stored in a non-HttpOnly cookie (e.g., `sentry-sc`, `csrftoken`). Check `window.__initialData.csrfCookieName` or similar bootstrap globals to discover the cookie name. Read the token with `document.cookie` and pass it as `X-CSRFToken` (or `X-CSRF-Token`) on PUT/POST/DELETE requests. GET requests work without it. Always test a write operation during Phase 3 exploration to catch this early.
22. **Check `window.__initialData` or similar bootstrap globals for auth signals** — Many SPAs embed authentication state, user info, and configuration in a global variable set by server-rendered HTML (e.g., `window.__initialData`, `window.__INITIAL_STATE__`, `window.boot_data`). These are far more reliable than DOM-based detection (which breaks when the UI changes). Use `browser_execute_script` to check `typeof window.__initialData` and inspect its keys early in Phase 3. Look for `isAuthenticated`, `user`, `csrfCookieName`, and organization/workspace context.
23. **Never use DOM scraping as a tool implementation** — DOM-based data reading (`document.querySelector`, `element.textContent`, `element.getAttribute`) and DOM-based actions (`button.click()`, `input.value = ...`) are hacks that break on any UI update and only see what's rendered on screen. Every tool must call the same API endpoints the web app itself uses. If the API is hard to discover (internal RPC, protobuf, proprietary batch format), spend the time in Phase 3 to reverse-engineer it using XHR/fetch interception — do not take the shortcut of reading from the DOM. The only acceptable DOM use in tools is URL hash navigation for SPA routing. `isReady()` may use DOM signals for auth detection since that is a one-time readiness check, not a data-fetching operation.
24. **Some apps use internal APIs instead of their public REST API** — Apps like Gmail expose a public REST API (e.g., `gmail.googleapis.com`) that requires OAuth2 tokens, but the web client communicates via internal same-origin endpoints (e.g., `/sync/u/N/i/s`, `?ui=2&act=...`) using cookie auth + XSRF tokens. When the public API rejects cookie/SAPISIDHASH auth, look for the internal endpoints the web app actually uses. Install XHR interceptors to capture them. These internal APIs accept cookie auth via `credentials: 'include'` and custom headers (XSRF tokens, action tokens) that can be captured by monkey-patching XHR at adapter load time.
25. **Intercepted headers must survive adapter re-injection** — When the adapter IIFE is re-executed (extension reload, `POST /reload`), module-level variables reset but `globalThis` persists. Store captured auth tokens (XSRF, BTAI, action tokens) on a dedicated `globalThis.__<pluginName>CapturedTokens` object from within the `setRequestHeader` interceptor. On adapter load, read them back from `globalThis` before any tool calls. Additionally, store the original (unpatched) XHR methods on `globalThis` (e.g., `globalThis.__origOpen`) on first install, and always re-patch `XMLHttpRequest.prototype` on subsequent adapter loads to ensure the new adapter's closures receive captured values — the guard `if (installed) return` causes stale closures to capture tokens that never reach the new adapter.
26. **Trusted Types CSP blocks `innerHTML`** — Some apps (e.g., Gmail) enforce Trusted Types via CSP, which rejects `element.innerHTML = untrustedString`. Use regex-based HTML-to-text conversion instead: strip tags with `html.replace(/<[^>]+>/g, '')`, convert `<br>` to newlines, and decode HTML entities. Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML` in plugin code — they will fail on strict CSP pages even though the adapter bypasses inline script CSP.
27. **Internal APIs may require opaque auth headers that can only be captured, not generated** — Some web apps include cryptographic tokens or signatures in API request headers that are computed by obfuscated client-side JavaScript (e.g., Gmail's `X-Gmail-BTAI` header). These cannot be reverse-engineered or generated by the plugin. The only viable approach is to capture them from the web app's own XHR requests via the interceptor and replay them. This means tools that require these headers will fail until the web app has made at least one request after the adapter loads. Implement a polling wait (e.g., `waitForBtai()`) that checks the captured value every 300ms with an 8-second timeout, and return a clear error message telling the user to interact with the app if the timeout expires.
28. **When one API path is blocked, find another** — If a write operation requires an undocumented cryptographic payload that can't be replicated (e.g., Gmail's sync API send token), don't give up. Explore the web app's internal extension APIs (e.g., Gmail's `window.gmonkey`), JavaScript-exposed compose/send infrastructure, or other internal endpoints. Web apps that are complex enough to have obfuscated crypto tokens usually also expose higher-level programmatic interfaces for extensions, accessibility, or testing. Use `browser_execute_script` to enumerate page globals, check for extension APIs (`gmonkey`, `__NEXT_DATA__`, `webpackChunk`), and test them interactively. The gmonkey compose API (`GmailDraftMessage.send()`) generates the cryptographic token internally, bypassing the need to replicate it.
29. **Web apps expose programmatic extension APIs on the page** — Complex web apps often expose internal extension/scripting APIs on `window` that provide higher-level operations than their raw XHR endpoints. Gmail exposes `window.gmonkey.get('2.0')` which provides `GmailMainWindow` (with `createNewCompose()`, `getOpenDraftMessages()`) and `GmailDraftMessage` (with `setToEmails()`, `setSubject()`, `setBody()`, `send()`). These APIs use the app's own send infrastructure internally, bypassing undocumented crypto tokens. Discovery approach: use `browser_execute_script` to check `Object.keys(window).filter(k => ...)` for non-standard globals, then explore their methods with `.toString()` to understand calling conventions. Other apps may have similar internal APIs — always check before assuming you need to reverse-engineer the raw protocol.
30. **gmonkey compose requires visible compose with polling waits** — Gmail's gmonkey `GmailDraftMessage.send()` only works when the compose window is visible and the internal send button state (`draft.ha.Pk.isEnabled()`) is true. A minimized or hidden compose has `Pk.isEnabled() === false` and `send()` silently no-ops. The implementation must: (1) snapshot existing drafts with `WeakSet` before calling `createNewCompose()`, (2) poll `getOpenDraftMessages()` until a new draft appears (by object identity, not index), (3) poll `Pk.isEnabled()` with a 3s timeout to wait for compose initialization, (4) set fields with `setToEmails()`/`setSubject()`/`setBody()`, (5) wait 500ms for Gmail to process field updates, (6) verify recipients were set (Gmail resolves addresses asynchronously), and (7) call `send()`. After sending, poll for the draft to disappear to confirm delivery.
31. **Internal API endpoints can be deprecated without warning** — Gmail's old action API (`?ui=2&view=up&act=...`) returns 404 ("Temporary Error") on some accounts while the sync API (`/sync/u/N/i/s`) continues to work. When building plugins for web apps with multiple API generations, test each endpoint independently. If an endpoint returns 404 or 403, it may be deprecated for that account or region — remove the tools that depend on it rather than shipping broken tools. Internal API paths like `/i/s`, `/i/fd`, `/i/bv` are compiled/minified route names (not randomly generated per-build) and are stable over months to years, but higher-level action endpoints (`?ui=2&act=...`) are more likely to be deprecated.

---

## Cookie-Based Auth Pattern

For apps where auth is entirely via HttpOnly cookies (no extractable token):

```typescript
// Auth is implicit via credentials: 'include'.
// Detect *authentication status* from observable signals:

const getAuth = (): Auth | null => {
  const persisted = getPersistedAuth();
  if (persisted) return persisted;

  // Check non-HttpOnly cookies for user context
  const userId = getCookie('user_id');
  if (!userId) return null;

  // Resolve workspace/space/org context from localStorage or API
  const contextId = getContextFromLocalStorage();
  const auth: Auth = { userId, contextId: contextId ?? '' };
  setPersistedAuth(auth);
  return auth;
};

// API calls use credentials: 'include' — the browser sends HttpOnly cookies automatically
const api = async <T>(endpoint: string, body: Record<string, unknown>): Promise<T> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated');

  const response = await fetch(`https://app.example.com/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-active-user': auth.userId,  // Some apps need explicit user headers
    },
    body: JSON.stringify(body),
    credentials: 'include',  // HttpOnly cookies sent automatically
    signal: AbortSignal.timeout(30_000),
  });
  // ... error handling ...
};
```
