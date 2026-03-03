# Plugin Tools Instructions

## Overview

Plugin developer CLI (`opentabs-plugin`), installed via `npm install -g @opentabs-dev/plugin-tools` or as a dev dependency. Runs on Node.js 22+. Uses esbuild for IIFE bundling. The `opentabs-plugin build` command bundles the plugin adapter into an IIFE, generates `dist/tools.json` (containing tool schemas), auto-registers the plugin in `~/.opentabs/config.json` (under `localPlugins`), and calls `POST /reload` to notify the running MCP server. Supports `--watch` mode for development.

## Key Files

```
platform/plugin-tools/src/
├── cli.ts             # Entry point — `opentabs-plugin` binary
└── commands/build.ts  # `opentabs-plugin build` command
```

## SDK Version Compatibility

The `opentabs-plugin build` command embeds the installed `@opentabs-dev/plugin-sdk` version as a top-level `sdkVersion` field in `dist/tools.json`. At discovery time, the MCP server compares the plugin's `sdkVersion` against its own SDK version using major.minor comparison: a plugin's major.minor must be less than or equal to the server's major.minor (patch differences are always fine). If the plugin was built with a newer SDK than the server, it is rejected as a `FailedPlugin` with a clear rebuild message. Plugins that predate this feature (no `sdkVersion` in `tools.json`) load normally with a warning logged — they are not rejected. The `sdkVersion` is surfaced in the `/health` endpoint (server-level and per-plugin), the `opentabs status` CLI command, and the side panel plugin cards (as a warning badge for missing or incompatible versions).

## Build Artifacts

The build command produces two files in `dist/`:

- `adapter.iife.js` — the plugin adapter bundle (IIFE format, injected into matching tabs)
- `tools.json` — tool schemas and `sdkVersion`

The build also auto-registers the plugin in `~/.opentabs/config.json` under `localPlugins` (first build only) and calls `POST /reload` to trigger MCP server rediscovery.
