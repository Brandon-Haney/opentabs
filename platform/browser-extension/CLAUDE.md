# Browser Extension Instructions

## Overview

Chrome extension (Manifest V3) that connects the MCP server to web pages. Receives plugin definitions via WebSocket, injects adapter IIFEs into matching tabs, and dispatches tool calls. Includes a React side panel UI for plugin management.

## Key Directories

```
platform/browser-extension/
├── src/
│   ├── background.ts              # Service worker — WebSocket, adapter injection, tool dispatch
│   ├── offscreen/                  # Persistent WebSocket (MV3 workaround)
│   └── side-panel/                 # React side panel UI
│       ├── styles.css              # THE theme definition — single source of truth
│       ├── App.tsx                 # Root component
│       ├── components/
│       │   ├── retro/              # RetroUI primitives (Button, Badge, Switch, Accordion, etc.)
│       │   └── *.tsx               # App-specific components (PluginCard, ToolRow, etc.)
│       └── hooks/                  # React hooks
├── build-side-panel.ts             # esbuild script for side panel
├── build-extension.ts              # esbuild script for background + offscreen
└── manifest.json                   # Extension manifest
```

---

## The Theme Is the Design System

`src/side-panel/styles.css` defines the complete visual language — colors, radius, shadows, and fonts — as CSS custom properties. The `@theme` block bridges these to Tailwind utility classes. **The theme is not a suggestion. It is the specification.** Every component must reference theme tokens; nothing may be hardcoded or overridden by aesthetic preference.

### Respect the theme. Always.

- **Use theme-aware Tailwind classes for everything.** Colors (`bg-primary`, `text-foreground`, `border-border`), radius (`rounded`), shadows (`shadow-md`), fonts (`font-head`, `font-sans`, `font-mono`). These classes resolve to CSS variables defined in `styles.css`.
- **Never hardcode values that the theme provides.** No hex colors in className strings. No Tailwind default palette colors (`bg-yellow-400`, `text-gray-500`). No inline style color/radius overrides. No arbitrary values (`bg-[#ffdb33]`, `rounded-[8px]`). If a value exists as a theme variable, use the corresponding Tailwind class.
- **Never override the theme's aesthetic choices.** The theme defines `--radius: 0` — every bordered container uses `rounded`. The theme defines flat offset shadows — every card uses `shadow-md`. Do not substitute different values because they "look better" or "feel more appropriate for the style." The design system is intentional and internally consistent.
- **Never change theme variable values** in `:root` or `.dark` without explicit approval from the user. These values are the brand identity.

### The theme at a glance

The full definitions live in `styles.css`. Key tokens:

| Token          | Light     | Dark      | Tailwind class    |
| -------------- | --------- | --------- | ----------------- |
| `--radius`     | `0`       | (same)    | `rounded`         |
| `--background` | `#fff`    | `#111111` | `bg-background`   |
| `--foreground` | `#000`    | `#f5f5f5` | `text-foreground` |
| `--primary`    | `#ffdb33` | `#ffdb33` | `bg-primary`      |
| `--border`     | `#000`    | `#777777` | `border-border`   |
| `--card`       | `#fff`    | `#1c1c1c` | `bg-card`         |
| `--muted`      | `#cccccc` | `#333333` | `bg-muted`        |

Shadows are flat offsets using `var(--border)` — no blur, no spread. Fonts: `font-head` (Archivo Black), `font-sans` (Space Grotesk), `font-mono` (Space Mono).

### Component pattern

Every bordered container in this design system follows the same recipe:

```
rounded border-2 border-border bg-card shadow-md
```

Interactive containers add a press-down hover effect:

```
transition-all hover:translate-y-0.5 hover:shadow
```

If a component has `border-2`, it should also have `rounded`. If it has `shadow-md`, it should use the theme shadow (which already references `var(--border)`). There are no exceptions to this pattern.

### Shared theme with docs site

The side panel theme (`styles.css`) and the docs theme (`docs/app/global.css`) share the same design system. The core tokens (colors, radius, shadows, fonts) must stay in sync. If one changes, the other must be updated to match.

---

## Sizing Constraints

The side panel runs inside a Chrome extension popup with limited viewport width. Elements nested inside fixed-height containers (e.g., a button inside a header bar) must respect their parent's dimensions. Do not apply blanket sizing rules (like 44px touch targets) to elements inside constrained containers — this causes overflow.

---

## React Best Practices

This project uses **React 19** (`^19.2.4`) with the automatic JSX runtime (`react-jsx`). The side panel build uses **React Compiler** (`babel-plugin-react-compiler`), which automatically memoizes all components and hooks at build time. Prefer modern React features and patterns, but **only when they fit the problem** — do not adopt a feature just because it is new. Every API choice should have a clear justification rooted in the current code, not in novelty.

- **Lift state to the right level** — if state needs to persist across component mount/unmount cycles, lift it to the parent rather than introducing complex patterns.
- **Minimize `useEffect`** — prefer derived state (inline computation) over effects that sync state. Effects are for external system synchronization (Chrome APIs, event listeners), not for state derivation.
- **`useRef` for non-rendering values** — timers, previous values, and DOM references belong in refs, not state.
- **Do not use `useMemo`, `useCallback`, or `React.memo` for optimization** — React Compiler handles memoization automatically at build time. These can be used as escape hatches when precise control over a memoized value is needed (e.g., ensuring a value used as an effect dependency is stable), but this should be rare.

---

## UI Component Authoring

### Component preference hierarchy

When building UI for the side panel, follow this priority order:

1. **Use an existing retro component** (`src/side-panel/components/retro/`) if one fits the need. These are the project's design-system primitives — they already apply the correct theme tokens, border treatment, and shadow style. Check what exists before reaching for anything else.
2. **Use native HTML** for simple controls that retro doesn't cover. For inputs like number steppers, use native `<input type="number">` with `defaultValue` (uncontrolled) — the browser handles digit-only filtering, ArrowUp/Down stepping, and min/max clamping for free.
3. **Use Radix UI** for complex interaction patterns that native HTML cannot achieve. The project uses Radix for primitives requiring non-trivial accessibility and interaction logic (Accordion, Switch, Tooltip, DropdownMenu, Slot). Check Radix before hand-rolling complex behavior like modals, popovers, or multi-select.
4. **Hand-roll only as a last resort** — when no retro component, native element, or Radix primitive fits.

### Every element must match the retro theme

**This applies to all four levels above — no exceptions.** Retro components (level 1) already satisfy this. For levels 2, 3, and 4, you must style the element with retro theme tokens (`border-2`, `border-border`, `rounded`, `shadow-sm`, `font-mono`, theme colors like `bg-card`, `text-foreground`, `bg-primary`) so that it is visually indistinguishable from a retro component. No element in the side panel should look like it came from a different design system.

### Architectural layering

Keep styled primitives and business logic in separate layers. The retro component in `components/retro/` applies the design system. The app component (e.g., `PortEditor`) handles business logic (storage, messaging). If you create a new component at levels 2-4, create it as a retro primitive first, then consume it from the app component.

### Additional guidelines

- **Uncontrolled by default for commit-on-blur inputs.** When a value is only meaningful once committed (e.g., port number, URL), use `defaultValue` with an `onBlur`/`onKeyDown` commit handler. Controlled inputs (`value` + `onChange`) fight the user's typing by re-rendering on every keystroke. Only use controlled mode when the parent must dictate the displayed value in real time.
- **Every retro component gets a Storybook story** (`*.stories.tsx` alongside the component). Cover at minimum: default state, edge-case values, disabled state, and an "all states" composite story.

---

## Extension-Specific Concepts

### Tab State Machine

Each plugin has three tab states: `closed` (no matching tab), `unavailable` (tab exists but `isReady()` returns false), and `ready` (tab exists and authenticated). The aggregate state is derived from all matching tabs: `ready` if any tab is ready, `unavailable` if tabs exist but none are ready, `closed` if no tabs exist.

The extension probes ALL matching tabs for readiness (not just the first ready one) and reports a `tabs: PluginTabInfo[]` array with per-tab `{ tabId, url, title, ready }` in both `tab.syncAll` and `tab.stateChanged` messages. The `lastKnownState` cache stores serialized `{ state, tabs }` JSON strings so that tab list changes (new tabs opened, tabs closed, URL/title changes, readiness changes) trigger notifications even when the aggregate state is unchanged.

Tabs Chrome cannot script — `discarded` (Memory Saver), `frozen` (Chrome 132+), or `status === 'unloaded'` (lazily restored session), per `isTabScriptable` in `tab-matching.ts` — are listed with `ready: false` without an `isReady()` probe and are skipped by adapter injection (`queryMatchingTabs` in `iife-injection.ts`); `executeScript` would reject or hang in them and no adapter can be running. Genuine probe failures (a rejected `executeScript`, an `isReady()` timeout) are warned once per (tab, error message) in `tab-state.ts`, with the message passed through `sanitizeErrorMessage` first because Chrome's "Cannot access contents of url" rejection quotes the tab's full URL; the memo for a tab resets when it navigates or finishes loading (`checkTabChanged` with `url` or `status === 'complete'`), is removed (`checkTabRemoved`), and on disconnect (`clearTabStateCache`). Tool dispatch does not consult this: `dispatchWithTabFallback` ranks `findAllMatchingTabs` directly, so a frozen tab is still tried and falls through on its "Cannot access" error.

### Tool Dispatch

When the MCP server dispatches a tool call, the extension receives the `tool.dispatch` message and routes to one of two paths based on whether a `tabId` is present in the params:

- **Targeted dispatch** (tabId present): Dispatches directly to the specified tab. Validates the tab exists via `chrome.tabs.get()` and that its URL matches the plugin's URL patterns (security check to prevent cross-origin abuse). Returns an error if the tab doesn't exist, the URL doesn't match, or the adapter isn't ready — no fallback to other tabs.
- **Auto-select dispatch** (tabId absent): Uses `dispatchWithTabFallback` — ranks matching tabs (active tab in focused window > active tab in any window > any tab in focused window > other tabs) and tries each in order until one succeeds.

**Result envelope** (`dispatch-helpers.ts`): the JSON-RPC response echoes the tab the tool ran in. Success is `result: { output, tabId }`; an error produced while executing in a tab carries `error.data.tabId` beside the adapter's structured fields (`code`, `category`, `retryable`, `retryAfterMs`, `details`). Pre-execution rejections (no matching tab, TOCTOU URL mismatch, tab closed before the URL re-check) carry no `tabId`; a tab that disappears while `executeScript` runs ("Tab closed during …") does. The MCP server strips `tabId` before the result reaches the MCP client and records it in the audit log.

**Error details**: when an adapter tool throws a ToolError with an object-valued `details`, the MAIN-world catch block in `tool-dispatch.ts` reads it duck-typed, JSON-round-trips it (a non-serializable object would otherwise void the whole `executeScript` result), drops it above 4096 serialized chars, and forwards it as `error.data.details`. At the wire, `sanitizeErrorDetails` (`sanitize-error.ts`) passes every key and string leaf through `sanitizeErrorMessage` (keys that collide after sanitization are kept apart with a `#<n>` suffix: `[URL]`, `[URL]#2`, ...), drops `__proto__`/`constructor`/`prototype` keys, keeps at most 64 keys per object, truncates containers below depth 2 to `'[TRUNCATED]'`, and drops the whole object with a `console.warn` when it exceeds 4096 chars.

### CSP Violation Relay

`injectAdapterFile` installs three ISOLATED-world relays before the adapter IIFE: plugin logs, readiness changes, and CSP violations. The CSP relay (`cspViolationRelayScript` in `iife-injection.ts`) listens for the browser-dispatched `securitypolicyviolation` event and sends a `csp:violation` message with a `CspViolationReport` (`extension-messages.ts`) for violations whose `effectiveDirective` is in `CSP_RELAY_DIRECTIVES` (`csp-violation.ts`): `connect-src` (an adapter's fetch/XHR/WebSocket), the trusted-types directives (so a TrustedScript/TrustedHTML violation is attributed to its `sourceFile`), `script-src`, `script-src-elem`, and `worker-src`. Everything else is page-native noise and is dropped in the page.

**Privacy rule for relayed data**: `blockedURI` and `documentOrigin` are reduced to origins. `sourceFile` is kept in full only when its scheme is `chrome-extension:` — that names the adapter or pre-script file that tripped the policy and distinguishes this extension from another one — otherwise it is reduced to its origin too. Reports are deduplicated per document by (directive, blocked origin, sourceFile, disposition) and capped at `MAX_CSP_VIOLATIONS_PER_DOCUMENT` (20); repeats never consume the budget. No nonce is used: the event is browser-dispatched (`isTrusted` rejects page-constructed events), the payload is diagnostic and cannot trigger any action, and the background sanitizes it again.

The background handler (`handleCspViolation` in `background-message-handlers.ts`) normalizes the report (`normalizeCspViolationReport` re-reduces URIs, truncates strings, rejects directives outside the allow-list), logs one warn line (`formatCspViolationLogLine`, visible in `extension_get_logs`), and — when connected — forwards a `plugin.log` entry at level `warning` for every plugin whose URL patterns match `sender.tab.url`, with the report and `tabId` as `data`. The plugin-log path carries this cleanly because its contract is per-plugin and the background attributes the tab itself; no pseudo-plugin is invented when nothing matches. `MessageHandler` takes an optional third `sender: chrome.runtime.MessageSender` parameter for this: content-script-originated handlers read `sender.tab` (Chrome-provided) rather than any page-supplied tab field. `csp:violation` is not in `EXTENSION_ONLY_TYPES` because it originates from content scripts, like `plugin:logs`. The relay covers the top frame only; frames reached through `preScriptFrameMatches` are not covered.

### Frame Bridge

Some web apps host their real API inside a **cross-origin embedded frame** — Office Web Apps is the reference case: the document lives in an `officeapps.live.com` frame whose JSON-RPC endpoint sends no CORS headers, so an adapter running in the host page cannot call it. The frame bridge (`browser-commands/frame-bridge-rpc.ts`) closes that gap.

A plugin tool does not perform the call. Its handler returns a `__bridge` directive, and `tool-dispatch.ts` intercepts that directive and runs the engine, replacing it with the parsed response. **A tool handler therefore never sees the response it asked for** — this is the single most surprising thing about the subsystem, and it shapes everything else: anything that must react to a response (resolving a name to an id, echoing a version counter, reshaping a payload) has to be declared to the engine rather than written as code in the handler.

The engine:

1. Reads the freshest **donor** request that a `document_start` pre-script interceptor stashed in a frame global. The donor supplies the live session `context` and auth headers, so no debugger and no tab reload are needed.
2. Optionally replays a **prep** call, then the **commit**, back to back against one context.
3. Replays inside the frame via `fetchInFrame`, so the request is same-origin and carries the frame's cookies and tokens.

Capabilities worth knowing before hand-rolling around them:

| Field | Use |
| --- | --- |
| `contextPatch` | Merge fields into the reused context (e.g. a selection a stateful method requires but a poll-sourced donor lacks) |
| `optionsFromPrep` | Resolve a **name** to an id by searching the prep response; ambiguity fails the call rather than guessing |
| `optionsFromPrepPaths` | Lift a **scalar** from a fixed path in the prep response into a nested commit option — the answer for optimistic-concurrency counters, which cannot be read in an earlier call without racing |
| `optionsFromFrameGlobals` | Take an option value from a frame global, for credentials only the embedded app can mint. The value never crosses into the host page, the adapter, or the tool result |
| `projection` | Reshape the response **inside the page**, before it crosses the boundary, so a large payload is trimmed rather than truncated |
| `contextKeys` | Restrict the context, required for GET where it travels in the URL |

**Adding a field to the directive means editing three places.** The engine's `FrameBridgeRpcParams`, the allow-list parser in `tool-dispatch.ts` (`extractBridgeDirective`), and the Zod schema for the `browser_frame_bridge_rpc` MCP tool. The parser is an allow-list: **a field it does not know is dropped silently**, and the call then runs with that behavior simply absent. This has cost real debugging time more than once — the symptom is a request that looks correct at the tool layer and reaches the service missing a field, with no error anywhere.

**A refused RPC answers HTTP 200** with the refusal in the payload, so success is judged on the parsed `errors` array, not the status. `describeBridgeFailure` raises that to a dispatch error, and it is evaluated against the full envelope *before* a projection replaces it — which is why a projection cannot hide a failure.

Plugin-side knowledge about a specific service (method names, argument shapes, error codes) belongs in that plugin's `docs/`, not here.

### Port Configuration

The MCP server port is configured in the side panel footer, stored in `chrome.storage.local` under the `serverPort` key (number, default 9515). The side panel footer displays the current port on the right side and supports inline editing — click to edit, Enter to save, Escape to cancel. When the port changes, the side panel sends a `port-changed` message through the background script to the offscreen document, which closes the current WebSocket and reconnects to the new port. The port is not stored in `auth.json` — auth.json contains only the secret.

### Side Panel Empty States

The browser tools card renders immediately on mount from `BROWSER_TOOLS_CATALOG` (a static catalog generated at build time from `@opentabs-dev/shared/browser-tools-catalog`). This means the side panel always has content when connected — there is no "No Plugins Installed" empty state. Connection state takes priority: the side panel distinguishes two disconnect states: (1) **Connection refused** (server unreachable) — shows "Cannot Reach MCP Server" with `opentabs start --port <N>` where N is the configured port, and (2) **Authentication failed** (HTTP 401 from secret mismatch) — shows "Authentication Failed" with instructions to reload the extension from `chrome://extensions/`. The disconnect reason flows from the offscreen document through the background script to the side panel via `disconnectReason` fields on connection state messages.

### Side Panel Import Constraints (CSP)

The side panel runs inside a Chrome extension context with strict Content Security Policy. **Node.js built-in modules (`node:fs`, `node:os`, `node:path`, etc.) are blocked by CSP and will crash the side panel silently (blank page).**

When importing from shared packages (e.g., `@opentabs-dev/shared`), **never use the barrel import** if the barrel re-exports modules that use Node.js APIs. esbuild bundles the entire barrel, including transitive Node.js dependencies, even if you only import a pure-data export. Use **subpath imports** to target the specific module:

```ts
// WRONG — pulls in cross-platform.js which uses node:fs/promises, node:os, node:path
import { BROWSER_TOOLS_CATALOG } from '@opentabs-dev/shared';

// CORRECT — imports only the pure-data catalog module
import { BROWSER_TOOLS_CATALOG } from '@opentabs-dev/shared/browser-tools-catalog';

// SAFE — type-only imports are erased at compile time and never reach the bundler
import type { TabState } from '@opentabs-dev/shared';
```

### Debugger Permission

The `debugger` permission in the manifest is required for network capture via the Chrome DevTools Protocol (`chrome.debugger.attach`, `Network.enable`, `Runtime.enable`) in `network-capture.ts`.

### Plugin Settings UI

**`ConfigDialog`** (`src/side-panel/components/ConfigDialog.tsx`): A modal dialog that renders a plugin's `configSchema` as a dynamic form. Supported field types: `url` (text input with URL validation), `string` (text input), `number` (number input), `boolean` (Switch), `select` (Radix Select with options). The form uses an uncontrolled pattern (`defaultValue` + `formRef`) so values are only committed on save. On save, settings are sent via `setPluginSettings` in `bridge.ts`. The `needsSetup(plugin)` helper (exported from `ConfigDialog.tsx`) returns true when the plugin has a `configSchema` with at least one `required` field that has no resolved value.

**Unconfigured state**: When `needsSetup(plugin)` is true, the plugin card is forced open (expanded by default, cannot be collapsed). The accordion trigger and chevron are disabled, and the content area shows a "Configure" button instead of the tool list. This makes the setup CTA immediately visible without requiring user interaction.

**Settings menu item**: `PluginMenu` includes a "Settings" menu item (Cog icon) when `plugin.configSchema` is defined. Clicking it calls the `onConfigOpen` callback, which `PluginCard` passes to trigger the `ConfigDialog`.

**`bg:setPluginSettings`** message (`extension-messages.ts`): Sent from the side panel via `bridge.setPluginSettings` when the user saves plugin settings. The background handler (`background-message-handlers.ts`) relays it to the MCP server via `sendServerRequest('config.setPluginSettings', ...)`. This message type is in `EXTENSION_ONLY_TYPES` — content scripts cannot send it.

### Plugin Review UI

**Unreviewed icon**: Plugin cards display a `ShieldQuestion` icon (from lucide-react) next to the plugin name when the plugin's current version has not been reviewed (`reviewed: false` in the sync payload). The icon has a tooltip ("This plugin version has not been reviewed") and uses `text-muted-foreground` color. Browser tools never show this icon. The `reviewed` boolean is computed server-side by comparing `reviewedVersion` against the installed version and included in `ConfigStatePlugin`.

**Unreviewed plugin confirmation dialog**: When a user changes an unreviewed plugin's permission from `'off'` to `'ask'` or `'auto'`, a Dialog modal intercepts the change. The dialog explains the plugin hasn't been reviewed, suggests asking the AI agent to review the adapter code, and offers "Cancel" (no change) and "Enable Anyway" (sets permission + marks as user-accepted by writing `reviewedVersion`). The dialog does not appear for reviewed plugins, browser tools, changes to `'off'`, or changes between `'ask'`/`'auto'`. The dialog is implemented inline in `PluginCard.tsx` using the retro Dialog primitive with `pendingPermission` state.

### Pre-Script Registration

`src/pre-script-registration.ts` manages `chrome.scripting.registerContentScripts` for plugins that declare a pre-script.

**Exported functions**:
- `syncPreScripts(metas: PluginMeta[]): Promise<void>` — reconciles the full set of registered pre-scripts to match the given plugin list. Unregisters stale `opentabs-pre-*` IDs not in the expected set, then upserts each plugin's pre-script in parallel. Called from `background.ts` after `reinjectStoredPlugins` on `onInstalled`, `onStartup`, and the top-level startup chain.
- `upsertPreScript(meta: PluginMeta): Promise<void>` — registers or re-registers one plugin's pre-script. Returns early (no-op) if `meta.preScriptFile` is undefined. Validates the filename against `SAFE_PRE_SCRIPT_FILENAME` before registering.
- `removePreScript(pluginName: string): Promise<void>` — unregisters the pre-script for a plugin. Safe to call when no registration exists (swallows the Chrome error). Called from `handlePluginUninstall` in `message-router.ts`.

**Filename validation**: `upsertPreScript` validates `meta.preScriptFile` against the regex `/^adapters\/[a-z0-9][a-z0-9-]*-prescript-[0-9a-f]{8}\.js$/` before calling `chrome.scripting.registerContentScripts`. Any value that doesn't match this pattern is rejected with `console.warn` and no registration is made. This is the trust boundary against a compromised MCP server sending a path-traversal payload.

**Registration ID**: Each plugin's pre-script is registered as `opentabs-pre-<pluginName>` (e.g., `opentabs-pre-prescript-test`). This prefix is the only scanner key used in `getRegisteredPreScriptIds` — unrelated content script registrations are never touched.

**Re-sync on startup**: `background.ts` calls `syncPreScripts` after `reinjectStoredPlugins` on both `chrome.runtime.onInstalled` and `chrome.runtime.onStartup`. This compensates for `persistAcrossSessions: true` being unreliable — Chrome may drop registrations across browser restarts, so re-syncing on every startup ensures pre-scripts are always registered.

**Auto-reload on hash change**: In `handlePluginUpdate` (`message-router.ts`), the previous `PluginMeta` is read before the update is stored. After `upsertPreScript` completes, if `meta.preScriptHash` differs from the previous value AND both the new and previous metas have a `preScriptFile`, all tabs matching the plugin's URL patterns are reloaded via `queryMatchingTabIds` + `chrome.tabs.reload`. This ensures already-open tabs pick up the new pre-script without requiring manual reload. Tabs are NOT reloaded on the first install (when the plugin gains a pre-script for the first time) — only on subsequent hash changes.
