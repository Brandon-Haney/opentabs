# Plugins

Plugins in this directory are **fully standalone projects** — identical to what an external developer would get from `create-opentabs-plugin`. They depend on published `@opentabs-dev/*` npm packages and have their own toolchain.

## Excluded from root tooling

These plugins are **not** covered by the root `bun run build`, `bun run lint`, `bun run type-check`, `bun run format:check`, or `bun run knip`. Each plugin must be built and checked independently:

```bash
cd plugins/<name>
bun install
bun run build         # tsc + opentabs build
bun run type-check    # tsc --noEmit
bun run lint          # eslint
bun run format:check  # prettier
```

## Adding a new plugin

```bash
bunx create-opentabs-plugin <name> --domain <domain>
```

Or manually: create a directory here following the same structure as the existing plugins.
