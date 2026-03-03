# Plugins Instructions

## Overview

Plugins in `plugins/` are **fully standalone projects** — exactly as if created by an external developer using `create-opentabs-plugin`. They are NOT part of the root npm workspace.

## Plugin Isolation

Each plugin:

- Has its own `package.json`, `tsconfig.json`, `.prettierrc`, and `.gitignore`
- Depends on published `@opentabs-dev/*` npm packages (not `file:` or `workspace:` links)
- Has its own `node_modules/` and `package-lock.json`
- Is **excluded** from root `eslint`, `prettier`, `knip`, and `tsc --build`
- Must build and type-check independently: `cd plugins/<name> && npm run build`

The root tooling (`npm run build`, `npm run lint`, etc.) does NOT cover plugins. When changing platform packages that plugins depend on (`shared`, `plugin-sdk`, `plugin-tools`), publish new versions to npm and update plugin dependencies.

**All plugins must use `^x.y.z` semver ranges for `@opentabs-dev/*` dependencies — never `file:` or `workspace:` links.** During version bumps, verify that no plugin `package.json` contains `file:` references. Plugins depend on published npm packages, not local filesystem paths.

## Adding a New Plugin

Each plugin follows the same pattern:

1. **Create the plugin** (`plugins/<name>/`): Extend `OpenTabsPlugin` from `@opentabs-dev/plugin-sdk`
2. **Configure `package.json`**: Add an `opentabs` field with `displayName`, `description`, and `urlPatterns`; set `main` to `dist/adapter.iife.js`
3. **Define tools** (`plugins/<name>/src/tools/`): One file per tool using `defineTool()` with Zod schemas. The `handle(params, context?)` function receives an optional `ToolHandlerContext` as its second argument for reporting progress during long-running operations
4. **Build**: `cd plugins/<name> && npm install && npm run build` (runs `tsc` then `opentabs-plugin build`, which produces `dist/adapter.iife.js` and `dist/tools.json`, auto-registers the plugin in `localPlugins`, and calls `POST /reload` to notify the MCP server)

## Building Plugins

```bash
cd plugins/<name> && npm install && npm run build
```

`opentabs-plugin build` auto-registers the plugin in `localPlugins` (first build only) and calls `POST /reload` to trigger server rediscovery. In dev mode, the file watcher also detects changes to `dist/tools.json` and `dist/adapter.iife.js`.

## Quality Checks

Each plugin has a `check` script that runs all quality checks:

```bash
cd plugins/<name>
npm run check   # build + type-check + lint + format:check
```

From the repo root, you can build or check all plugins at once:

```bash
npm run build:plugins   # Build all plugins (install + build each)
npm run check:plugins   # Type-check + lint + format:check all plugins
```
