# Plugin SDK Instructions

## Overview

Provides the `OpenTabsPlugin` base class, `defineTool` factory function, and `ToolHandlerContext` interface for progress reporting. Plugins extend `OpenTabsPlugin` and define tools with Zod schemas.

## Key Files

```
platform/plugin-sdk/src/
├── index.ts        # OpenTabsPlugin, defineTool, log exports
├── errors.ts       # ToolError (structured error metadata, details, withDetails)
├── log.ts          # Structured logging API (sdk.log namespace)
├── dom.ts          # DOM utilities
├── fetch.ts        # Fetch utilities, httpStatusToToolError, TRANSIENT_HTTP_STATUSES
├── fetch-retry.ts  # fetchWithRetry — transient-failure retry wrapper with the fetch contract
├── storage.ts      # Storage utilities
├── page-state.ts   # Page state utilities
└── timing.ts       # Timing utilities
```

## Lifecycle Hooks

Plugins can optionally implement lifecycle hooks on the `OpenTabsPlugin` base class. All hooks are wired automatically by the `opentabs-plugin build` command in the generated IIFE wrapper — plugin authors only need to implement the methods.

- `onActivate()` — called once after the adapter is registered on `globalThis.__openTabs.adapters`
- `onDeactivate()` — called when the adapter is being removed (before `teardown()`)
- `onNavigate(url)` — called on in-page URL changes (pushState, replaceState, popstate, hashchange)
- `onToolInvocationStart(toolName)` — called before each `tool.handle()` execution
- `onToolInvocationEnd(toolName, success, durationMs)` — called after each `tool.handle()` completes

All hooks run in the page context. Errors in hooks are caught and logged — they do not affect adapter registration or tool execution.

## SDK Utilities

The plugin SDK provides utility functions that run in the page context, reducing boilerplate for common plugin operations. All utilities are exported from the SDK's public API.

### DOM Utilities (`dom.ts`)

- `waitForSelector(selector, opts?)` → `Promise<Element>` — waits for an element to appear using MutationObserver, configurable timeout (default 10s)
- `waitForSelectorRemoval(selector, opts?)` → `Promise<void>` — waits for an element to be removed from the DOM, configurable timeout (default 10s)
- `querySelectorAll<T>(selector)` → `T[]` — typed wrapper returning a real array instead of NodeList
- `getTextContent(selector)` → `string | null` — returns trimmed textContent of the first match, or null
- `getMetaContent(name)` → `string | null` — returns the `content` attribute of `<meta name="...">`, or null if absent
- `observeDOM(selector, callback, options?)` → `() => void` — sets up a MutationObserver on the matching element, returns a cleanup function (defaults: childList+subtree true)

### Fetch Utilities (`fetch.ts`)

- `fetchFromPage(url, init?)` → `Promise<Response>` — fetch with credentials:'include' (page session cookies), configurable timeout via AbortSignal (default 30s), throws `ToolError` on non-ok status
- `fetchJSON<T>(url, init?, schema?)` → `Promise<T>` — calls fetchFromPage and parses JSON, throws on parse failure
- `fetchText(url, init?)` → `Promise<string>` — calls fetchFromPage and returns the response body as a string (for diffs, raw content, job logs)
- `postJSON<T>(url, body, init?, schema?)` → `Promise<T>` — POST with JSON body (sets Content-Type, stringifies), returns parsed JSON
- `putJSON<T>(url, body, init?, schema?)` → `Promise<T>` — PUT with JSON body, returns parsed JSON
- `patchJSON<T>(url, body, init?, schema?)` → `Promise<T>` — PATCH with JSON body, returns parsed JSON
- `deleteJSON<T>(url, init?, schema?)` → `Promise<T>` — DELETE request, returns parsed JSON
- `postForm<T>(url, body, init?, schema?)` → `Promise<T>` — POST with URL-encoded form body (sets Content-Type: application/x-www-form-urlencoded), returns parsed JSON
- `postFormData<T>(url, body: FormData, init?, schema?)` → `Promise<T>` — POST with multipart/form-data body, returns parsed JSON
- `httpStatusToToolError(response, message)` → `ToolError` — maps HTTP status codes to the appropriate `ToolError` category (auth, not_found, rate_limit, etc.); every returned error carries `details: { httpStatus }`; 5xx retryability follows `TRANSIENT_HTTP_STATUSES`
- `TRANSIENT_HTTP_STATUSES` → `ReadonlySet<number>` — `{408, 429, 500, 502, 503, 504}`; the single source of truth for what `fetchWithRetry` retries and what `httpStatusToToolError` marks retryable (501 and 505 are excluded)
- `parseRetryAfterMs(value)` → `number | undefined` — parses a `Retry-After` header value (seconds or HTTP-date) into milliseconds
- `parseRateLimitHeader(headers)` → `number | undefined` — checks Retry-After, x-rate-limit-reset, x-ratelimit-reset, and RateLimit-Reset headers in order and normalizes to milliseconds until reset; returns undefined if no header is found or value is invalid
- `buildQueryString(params)` → `string` — converts a record of `string | number | boolean | (string | number | boolean)[]` values to a URL query string (no leading `?`), filtering out undefined values; array values produce multiple entries for the same key
- `stripUndefined<T>(obj)` → `Partial<T>` — filters out keys with undefined values from an object, keeping null, 0, false, and empty string; useful for building request bodies without conditional assignment chains

### Fetch With Retry (`fetch-retry.ts`)

- `fetchWithRetry(url, init?, options?)` → `Promise<Response>` — keeps the `fetch` contract: resolves with the final `Response` for every outcome that is not retried (4xx, exhausted 5xx) so the caller classifies statuses itself; throws `ToolError` only for a network failure that exhausted its retries (code `network_error`, `category: 'internal'`, `retryable: true`) or a caller abort (code `aborted`). `init` is forwarded to `fetch` unchanged — it does not set `credentials`.
- **Retried**: a network `TypeError` or a status in `TRANSIENT_HTTP_STATUSES`, for GET/HEAD/OPTIONS by default; POST/PUT/PATCH/DELETE only with `retryNonIdempotent: true` (PUT is excluded from the default set because upload-session PUTs are stateful) or when `isTransient(response)` returns true for a non-ok response — the predicate vouches the request never executed at the origin, so it is honored regardless of method. Decision order: `byStatus = TRANSIENT_HTTP_STATUSES.has(status) && (idempotent || retryNonIdempotent)`, then `vouched = !byStatus && !response.ok && isTransient?.(response) === true`; `isTransient` is never called when `byStatus` is already true, nor on the final attempt (no retry is possible). 501/505 are never retried; every other status is returned untouched.
- **Non-replayable bodies**: a request whose `init.body` is a `ReadableStream` (checked with `typeof ReadableStream !== 'undefined'`) is never retried — the first request consumes the stream — so neither `retryNonIdempotent` nor `isTransient` applies and `isTransient` is not consulted; the response is returned (or the network error thrown) after a single attempt.
- **Delay**: `Retry-After` on 429/503 when present and `<= maxRetryAfterMs` (10s default; longer → return the response immediately so the caller surfaces `retryAfterMs`), else `baseDelayMs * 2^(attempt-1)` (400ms) capped at `maxDelayMs` (5s) with equal jitter `[d/2, d]`; every delay is bounded by `deadlineMs` (20s from the first attempt — a retry whose delay would overrun it is skipped, the last Response returned or network error thrown). The body of every retried response is cancelled; the returned Response is untouched.
- **Abort/timeout**: `options.signal` is combined with `init.signal` for the request, and the combined signal also interrupts every backoff sleep. An `options.signal` abort before, during or between attempts throws one normalized `ToolError('fetchWithRetry: request aborted for <host>', 'aborted')`. An `init.signal` abort surfaces its own reason: a `TimeoutError` DOMException from `AbortSignal.timeout` is rethrown untouched and never retried, whether it fires during a request or during a sleep — so a per-request timeout is reported the moment it elapses, not after the sleep ends.
- **Logging**: one `log.warn('transient upstream failure, retrying', { host, method, attempt, reason, delayMs })` per retry (`label` added when provided — a service name such as `'graph-mail'`, never a URL, so log lines stay host-only); `reason` is `'network'` or `'http <status>'`. Only the host is logged — never the full URL. Host derivation works in Node tests (no `location` global) and falls back to `<invalid-url>`.
- **`onRetry`**: `options.onRetry?: (event: FetchRetryEvent) => void` is invoked synchronously right before each backoff sleep with `{ attempt, reason, delayMs }` — `attempt` is the 1-based number of the attempt that just failed, `reason` and `delayMs` are exactly the values in the warn log. It is never invoked for the final attempt or for a response returned without a retry, so `1 + invocations` is the number of requests made; an exception thrown by the callback propagates and ends the operation. Callers use it to report an honest attempt count in their error messages instead of deriving one from the retry policy.
- Depends only on `sleep`, `parseRetryAfterMs`, `TRANSIENT_HTTP_STATUSES`, `ToolError` and `log`, so a plugin pinned to an older SDK can carry a byte-for-byte copy that imports those names from `@opentabs-dev/plugin-sdk` until the SDK that ships `fetchWithRetry` is published.

### Storage Utilities (`storage.ts`)

- `getLocalStorage(key)` → `string | null` — wraps localStorage.getItem with try-catch (returns null on SecurityError)
- `setLocalStorage(key, value)` → `void` — wraps localStorage.setItem with try-catch (silently fails on SecurityError)
- `removeLocalStorage(key)` → `void` — wraps localStorage.removeItem with try-catch
- `getSessionStorage(key)` → `string | null` — wraps sessionStorage.getItem with try-catch
- `setSessionStorage(key, value)` → `void` — wraps sessionStorage.setItem with try-catch
- `removeSessionStorage(key)` → `void` — wraps sessionStorage.removeItem with try-catch
- `getCookie(name)` → `string | null` — parses document.cookie, handles URI-encoded values
- `getAuthCache<T>(namespace)` → `T | null` — reads a typed value from `globalThis.__openTabs.tokenCache[namespace]`
- `setAuthCache<T>(namespace, value)` → `void` — writes a typed value to `globalThis.__openTabs.tokenCache[namespace]`, initializing the cache objects if absent
- `clearAuthCache(namespace)` → `void` — sets `globalThis.__openTabs.tokenCache[namespace]` to undefined
- `findLocalStorageEntry(predicate)` → `{ key: string; value: string } | null` — iterates localStorage keys and returns the first entry where the predicate returns true

### Page State Utilities (`page-state.ts`)

- `getPageGlobal(path)` → `unknown` — safe deep property access on globalThis using dot-notation (e.g., `getPageGlobal('TS.boot_data.api_token') as string | undefined`), returns undefined if any segment is missing
- `getCurrentUrl()` → `string` — returns window.location.href
- `getPageTitle()` → `string` — returns document.title

### Timing Utilities (`timing.ts`)

- `retry<T>(fn, opts?)` → `Promise<T>` — retries on failure with configurable maxAttempts (default 3), delay (default 1s), optional exponential backoff, optional AbortSignal cancellation
- `sleep(ms)` → `Promise<void>` — promisified setTimeout
- `waitUntil(predicate, opts?)` → `Promise<void>` — polls predicate at interval (default 200ms) until true, rejects on timeout (default 10s)

### Logging Utilities (`log.ts`)

- `log.debug(message, ...args)` → `void` — logs at debug level
- `log.info(message, ...args)` → `void` — logs at info level
- `log.warn(message, ...args)` → `void` — logs at warning level (maps to MCP `warning`)
- `log.error(message, ...args)` → `void` — logs at error level

The `log` object is frozen. Args are safely serialized (handles circular refs, DOM nodes, functions, symbols, bigints, errors). When running inside the adapter runtime, entries flow to the MCP server; otherwise they fall back to `console` methods.

### Usage Example

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

## Structured Errors

`ToolError` supports structured metadata that enables AI agents to distinguish retryable from permanent errors. The constructor accepts an optional third parameter: `ToolError(message, code, opts?)` where `opts` can include `category` (`'auth' | 'rate_limit' | 'not_found' | 'validation' | 'internal' | 'timeout'`), `retryable` (boolean, defaults to `false`), `retryAfterMs` (number), and `details` (`ToolErrorDetails = Record<string, string | number | boolean>`, re-exported from `@opentabs-dev/shared`). Use the static factory methods instead of constructing directly: `ToolError.auth(msg)`, `ToolError.notFound(msg, code?)`, `ToolError.rateLimited(msg, retryAfterMs?)`, `ToolError.validation(msg)`, `ToolError.timeout(msg)`, `ToolError.internal(msg)`. The factories take no `details`; attach metadata with `err.withDetails(details)`, which returns a new `ToolError` with the merged details (later keys win) and every other field — message, code, category, retryable, retryAfterMs, stack — preserved, leaving the original untouched. `httpStatusToToolError` uses this to attach `{ httpStatus }`. The dispatch chain propagates these fields from the adapter IIFE through the extension to the MCP server, which formats error responses with both a human-readable prefix (`[ERROR code=X category=Y retryable=Z retryAfterMs=N] message`) and a machine-readable JSON block built from a fixed allow-list of `code`, `category`, `retryable` and `retryAfterMs`. `details` appears in neither — it is recorded only in the audit log, for a human reading the trail afterwards, and a test pins that it never reaches the agent. Detail values are flat primitives meant for triage (upstream HTTP status, request id, proxy error label); they must never contain full URLs with item identifiers — hosts or origins only.

## Zod Schemas and JSON Schema Serialization

Plugin tool schemas are serialized to JSON Schema (via `z.toJSONSchema()`) for the MCP protocol and plugin manifests. Keep schemas serialization-compatible:

- **Never use `.transform()` in tool input/output schemas** — Zod transforms cannot be represented in JSON Schema. If input needs normalization (e.g., stripping colons from emoji names), do it in the tool's `handle` function, not in the schema. The schema defines the wire format; the handler implements business logic.
- **Avoid Zod features that don't map to JSON Schema** — `.transform()`, `.pipe()`, `.preprocess()`, and effects produce runtime-only behavior that `z.toJSONSchema()` cannot serialize. If the serializer throws, the build breaks. Keep schemas declarative (primitives, objects, arrays, unions, literals, enums, refinements with standard validations).
- **Fix the source, not the serializer** — when a schema feature conflicts with JSON Schema serialization, the correct fix is always to simplify the schema and move logic to the handler. Do not work around serialization limitations with options like `io: 'input'` — that hides the problem and produces a schema that doesn't match the handler's actual behavior.
- **`.refine()` callbacks must never throw** — Zod 4 runs `.refine()` callbacks even when the preceding validator has already failed (e.g., `z.url().refine(fn)` calls `fn` even on non-URL strings). If the callback calls a function that can throw on invalid input (like `new URL()`), wrap it in try-catch and return `false`. Never assume the refine callback only receives values that passed the base validator.

## Plugin Settings

Plugins can declare a `configSchema` property on the `OpenTabsPlugin` subclass and in `package.json`'s `opentabs` field. At runtime the platform injects resolved settings into the page's MAIN world (as `globalThis.__openTabs.pluginConfig`) before the adapter IIFE runs.

**`getConfig(key)`** (`config.ts`) — reads a resolved setting value from `globalThis.__openTabs.pluginConfig`. Returns the value as `string | number | boolean | undefined`. Use it inside tool handlers to access user-configured settings:

```typescript
import { getConfig } from '@opentabs-dev/plugin-sdk';

const instanceUrl = getConfig('instanceUrl') as string | undefined;
```

**Types** — `ConfigSchema`, `ConfigSettingDefinition`, and `ConfigSettingType` are re-exported from `@opentabs-dev/shared` for convenience. Import them when declaring `configSchema` on the plugin class:

```typescript
import type { ConfigSchema } from '@opentabs-dev/plugin-sdk';

class MyPlugin extends OpenTabsPlugin {
  configSchema: ConfigSchema = {
    instanceUrl: { type: 'url', label: 'Instance URL', required: true },
  };
}
```

## Pre-Script

A pre-script runs at `document_start` in MAIN world via `chrome.scripting.registerContentScripts`, strictly before any page script. It lets plugins observe or patch page runtime state — auth tokens in outbound fetch/XHR, CSRF nonces, early globals — that the page would otherwise hide before ordinary adapters load.

### Authoring a pre-script

Import `definePreScript` from the **subpath export only** — never from the main SDK barrel:

```typescript
import { definePreScript } from '@opentabs-dev/plugin-sdk/pre-script';

export default definePreScript(({ set, log }) => {
  const real = window.fetch;
  window.fetch = async (input, init) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth) set('authToken', auth);
    return real(input, init);
  };
});
```

**`definePreScript(fn: (ctx: PreScriptContext) => void): void`** — registers the callback with the IIFE wrapper. Calling it outside the wrapper (e.g., in tests) is a safe no-op.

**`PreScriptContext`**:
- `set(key: string, value: PreScriptValue): void` — stashes a JSON-serializable value in the plugin's pre-script namespace (`globalThis.__openTabs.preScript[<pluginName>][key]`). The plugin name is injected at build time; plugins cannot write to each other's namespaces.
- `log` — console logger with `debug`, `info`, `warn`, `error`. Logs go to the browser console only (the extension log relay is not yet installed at `document_start`).

**Constraints**: Pre-scripts have no access to `chrome.*` APIs and no access to the main SDK (no DOM helpers, no fetch utilities, no tool infrastructure). The only surface is `definePreScript`.

The subpath export exists so bundlers do not pull the full SDK into the pre-script IIFE. `definePreScript` is intentionally absent from the main barrel.

### Reading pre-script values in the adapter

**`getPreScriptValue<T>(key: string): T | undefined`** — reads a value stashed by the plugin's pre-script. Exported from the main SDK barrel:

```typescript
import { getPreScriptValue } from '@opentabs-dev/plugin-sdk';

const token = getPreScriptValue<string>('authToken');
```

**`undefined` is a normal branch, not an error.** It occurs when:
- The plugin has no pre-script declared.
- The adapter was injected into a tab that was already open when the plugin registered (pre-scripts only fire on future navigations).
- The pre-script ran but did not call `set(key, ...)` for this key.

### Build integration

When `package.json` declares `opentabs.preScript` pointing to a source file (e.g., `"src/pre-script.ts"`), `opentabs-plugin build` bundles it as a separate IIFE (`dist/pre-script.iife.js`) using esbuild's `inject` option to run setup code synchronously before the entry point. The build also computes a SHA-256 hash of the output (first 8 hex digits) and records it in `dist/tools.json` as `preScriptFile` and `preScriptHash`.

## Why Resources and Prompts Are Not Supported

The MCP spec defines resources (read-only data sources) and prompts (parameterized message templates) alongside tools. OpenTabs intentionally does not support these primitives:

1. **Tools are strictly more capable** — a tool can do everything a resource can do, with the addition of input validation, progress reporting, lifecycle hooks, and output schemas. There is no plugin use case where a resource is the right choice over a tool.

2. **Prompts have no practical use case in browser-session plugins** — generating prompt templates does not require an authenticated browser session. If prompts are static, they don't need a browser. If they're dynamic based on page state, a tool should read that state.

3. **Every real-world plugin is fundamentally about actions** — send message, create ticket, query metrics. The read operations that come along are naturally tools with parameters.

4. **Fewer primitives, simpler platform** — removing resources and prompts reduces the SDK surface area, simplifies the build pipeline, dispatch chain, and server internals.
