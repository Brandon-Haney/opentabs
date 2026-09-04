# Plugins Instructions

## Overview

Plugins in `plugins/` are **fully standalone projects** — exactly as if created by an external developer using `npx @opentabs-dev/create-plugin`. They are NOT part of the root npm workspace.

## Plugin Isolation

Each plugin:

- Has its own `package.json`, `tsconfig.json`, `biome.json`, and `.gitignore`
- Depends on published `@opentabs-dev/*` npm packages (not `file:` or `workspace:` links)
- Has its own `node_modules/` and `package-lock.json`
- Is **excluded** from root `biome`, `knip`, and `tsc --build`
- Must build and type-check independently: `cd plugins/<name> && npm run build`

The root tooling (`npm run build`, `npm run lint`, etc.) does NOT cover plugins. Inside this repository, the scripted plugin build links each plugin to the working-tree `plugin-sdk` (see [Building Plugins](#building-plugins)), so SDK changes reach plugins immediately. External plugin developers only receive those changes once a new `@opentabs-dev/plugin-sdk` is published and their dependency range picks it up, so publish platform packages (`shared`, `plugin-sdk`, `plugin-tools`) after changing them.

**All plugins must use `^x.y.z` semver ranges for `@opentabs-dev/*` dependencies — never `file:` or `workspace:` links.** During version bumps, verify that no plugin `package.json` contains `file:` references. Plugins depend on published npm packages, not local filesystem paths.

## Adding a New Plugin

Each plugin follows the same pattern:

1. **Create the plugin** (`plugins/<name>/`): Extend `OpenTabsPlugin` from `@opentabs-dev/plugin-sdk`
2. **Configure `package.json`**: Add an `opentabs` field with `displayName`, `description`, and `urlPatterns`; set `main` to `dist/adapter.iife.js`
3. **Define tools** (`plugins/<name>/src/tools/`): One file per tool using `defineTool()` with Zod schemas. The `handle(params, context?)` function receives an optional `ToolHandlerContext` as its second argument for reporting progress during long-running operations
4. **Build**: `npm run build:plugins -- --filter=<name>` from the repo root (installs dependencies, links the working-tree SDK, then runs the plugin's `npm run build`: `tsc` followed by `opentabs-plugin build`, which produces `dist/adapter.iife.js` and `dist/tools.json`, auto-registers the plugin in `localPlugins`, and calls `POST /reload` to notify the MCP server)

## Plugin Icons

Place an `icon.svg` file in the plugin root directory. The build tool auto-generates inactive, dark, and dark-inactive variants. Follow these rules:

- **No explicit `width`/`height` attributes on `<svg>`.** The side panel renders icons in a small container (19x19px) with `overflow: hidden`. An SVG with hardcoded dimensions (e.g., `width="74" height="74"`) renders at that fixed size and gets clipped — the icon appears blank because the visible content is outside the tiny viewport. Use `viewBox` only — the SVG scales to fit the container automatically.
- **Use hardcoded colors, not `currentColor`.** The build tool's dark/inactive variant generator skips `currentColor` (it's a passthrough value). Use `fill="black"` for monochrome icons — the generator detects low contrast against the dark background (`#1c1c1c`) and auto-inverts to white. Plugins like GitHub and Notion use this pattern.
- **The `viewBox` must be square.** The build tool validates this. If the source logo has a non-square aspect ratio (e.g., `0 0 74 64`), pad the viewBox to square and center the path coordinates.

Example of a correct monochrome icon:

```svg
<svg viewBox="0 0 74 74" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M37 5L74 69H0L37 5Z" fill="black"/>
</svg>
```

For multi-color icons or when automatic dark generation produces poor results, provide an explicit `icon-dark.svg` alongside `icon.svg`.

## Building Plugins

Build plugins through the repo script, not a bare `npm run build` inside the plugin:

```bash
npm run build:plugins -- --filter=<name>          # one plugin
npm run build:plugins -- --filter=<name>,<other>  # several
npm run build:plugins                             # all plugins
```

For each plugin the script runs `npm install`, then replaces `node_modules/@opentabs-dev/plugin-sdk` with a link (a junction on Windows, a symlink elsewhere) to the working-tree SDK at `platform/plugin-sdk`, then runs the plugin's `npm run build`. Plugins therefore build and type-check against the SDK in this checkout and may import every export the local SDK provides, while `package.json` and `package-lock.json` keep the published `^x.y.z` range. The SDK must already be built (`npm run build` or `npm run type-check` at the root) for the link to resolve.

A manual `npm install` inside a plugin reverts the link to the registry copy of the SDK until the next scripted build. If a plugin suddenly fails to type-check against an SDK export that exists in `platform/plugin-sdk/src`, that is the cause — rebuild it through the script.

`opentabs-plugin build` auto-registers the plugin in `localPlugins` (first build only) and calls `POST /reload` to trigger server rediscovery. In dev mode, the file watcher also detects changes to `dist/tools.json` and `dist/adapter.iife.js`.

## Shared Modules Across Plugins

Plugins cannot import from each other, so a helper needed by several plugins exists either as an SDK export or as byte-identical copies. Generic helpers (retrying fetches, error classification, timing) belong in `@opentabs-dev/plugin-sdk` — never keep a plugin-local copy of something the SDK exports. Copies are reserved for site-specific code that would not make sense in the SDK.

The Microsoft plugins share such site-specific modules. `plugins/outlook/src` holds the canonical copy of each one; the other Microsoft plugins carry byte-identical copies, and their unit tests exist only in `plugins/outlook`:

| Canonical file (`plugins/outlook/src/`)      | Plugins carrying a byte-identical copy                             |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `microsoft-upstream.ts`, `diagnostics.ts`    | `teams`, `excel-online`, `microsoft-word`, `powerpoint`, `onenote` |
| `reload-marker.ts`, `reload-marker-parse.ts` | `excel-online`, `microsoft-word`, `powerpoint`                     |
| `token-fingerprint.ts`                       | `teams`, `excel-online`, `microsoft-word`, `powerpoint`, `onenote` |

To change a shared module, edit it in `plugins/outlook/src`, update its test there, and copy the file unchanged into every plugin in its row. `scripts/check-shared-plugin-modules.ts` (run by `npm run check:plugins` and `npm run check`) fails when a copy is missing or differs by a single byte, when a shared module's test appears outside `plugins/outlook`, or when any plugin ships `src/fetch-with-retry.ts` or its test — `fetchWithRetry` is an SDK export, so no plugin-local copy may exist. The manifest in that script is the source of truth for which plugins carry which files; extend it when a new plugin adopts a shared module.

## Plugin Settings (configSchema)

Plugins can declare a `configSchema` to let users provide instance-specific configuration (e.g., the URL of their self-hosted instance). Declare it on the plugin class and in `package.json`:

```typescript
// src/index.ts
import type { ConfigSchema } from '@opentabs-dev/plugin-sdk';

class MyPlugin extends OpenTabsPlugin {
  configSchema: ConfigSchema = {
    instanceUrl: {
      type: 'url',
      label: 'Instance URL',
      description: 'The URL of your instance',
      required: true,
    },
  };
}
```

```json
// package.json opentabs field
{
  "opentabs": {
    "displayName": "My Plugin",
    "urlPatterns": [],
    "configSchema": {
      "instanceUrl": {
        "type": "url",
        "label": "Instance URL",
        "required": true
      }
    }
  }
}
```

When `configSchema` has at least one `required` field of type `'url'`, `urlPatterns` may be an empty array — the platform derives match patterns at runtime from the configured URL. Read configured values in tool handlers with `getConfig('instanceUrl')` from `@opentabs-dev/plugin-sdk`.

Users configure settings via `opentabs plugin configure <name>` (interactive), `opentabs config set setting.<plugin>.<key> <value>` (scripted), or the side panel ConfigDialog.

## Quality Checks

Each plugin has a `check` script that runs all quality checks:

```bash
cd plugins/<name>
npm run check   # build + type-check + lint + format:check
```

From the repo root, you can build or check all plugins at once:

```bash
npm run build:plugins   # Build all plugins (install + link working-tree SDK + build each)
npm run check:plugins   # Type-check + lint + format:check + test all plugins, then the tool-description and shared-module checks
```
