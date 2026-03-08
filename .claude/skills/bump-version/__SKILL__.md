# Bump Version

Bump package versions across all platform packages and plugins in lockstep.

All platform packages and plugins share the same version number (e.g., `0.0.34`). This skill bumps every package to a new version in a single coordinated change.

---

## Versioning Model

- **All platform packages share one version** — bumped in lockstep.
- **All plugins share that same version** — plugins also reference platform packages via `^x.y.z` semver ranges, which must be updated to match.
- **The docs site (`docs/`) has its own independent version** — do NOT bump it unless explicitly requested.
- **The root `package.json` has no version field** — leave it alone.

---

## The Job

1. **Determine the target version** — discover the current version by reading any platform `package.json` (they are all in sync). For **patch bumps**, proceed immediately without asking the user (e.g., `0.0.34` → `0.0.35`). For **minor or major bumps**, confirm the target version with the user before proceeding.
2. **Discover the current version** by reading any platform `package.json` (they are all in sync)
3. **Update all version references** (see "Files to Update" below)
4. **Update root lock file** — run `npm install --package-lock-only` at the repo root
5. **Scan for hardcoded version strings** in source code (see "Hardcoded Version Scan")
6. **Verify** — run `npm run build` and `npm run type-check` to confirm nothing broke
7. **Commit** the version bump (do NOT push yet — see "Push Ordering" below)
8. **Publish all platform packages** to npm in dependency order (see "Publishing" below)
9. **Update plugin lock files and rebuild** — run `npm run build:plugins` (installs from registry + builds)
10. **Commit** the plugin lock file updates
11. **Push** all commits

### Push Ordering

**The pre-push hook runs `npm run build:plugins`, which calls `npm install` in each plugin.** Plugins reference `@opentabs-dev/*` packages via `^x.y.z` semver ranges that resolve from the npm registry. If you push BEFORE publishing, the pre-push hook fails with `ETARGET` ("No matching version found") because the new version does not exist on npm yet.

The correct order is: **commit → publish → build:plugins → commit plugin locks → push**. This ensures the packages exist on the registry before the pre-push hook tries to install them.

---

## Files to Update

### Platform Packages (version field in `package.json`)

These packages all have a `"version"` field that must be bumped:

| Package                           | Path                                      |
| --------------------------------- | ----------------------------------------- |
| `@opentabs-dev/shared`            | `platform/shared/package.json`            |
| `@opentabs-dev/plugin-sdk`        | `platform/plugin-sdk/package.json`        |
| `@opentabs-dev/browser-extension` | `platform/browser-extension/package.json` |
| `@opentabs-dev/mcp-server`        | `platform/mcp-server/package.json`        |
| `@opentabs-dev/plugin-tools`      | `platform/plugin-tools/package.json`      |
| `@opentabs-dev/cli`               | `platform/cli/package.json`               |
| `@opentabs-dev/create-plugin`     | `platform/create-plugin/package.json`     |

**Edit:** Change `"version": "<old>"` to `"version": "<new>"` in each file.

### Chrome Extension Manifest

The Chrome extension manifest version must match the platform version:

| File                                       | Field       |
| ------------------------------------------ | ----------- |
| `platform/browser-extension/manifest.json` | `"version"` |

**Edit:** Change `"version": "<old>"` to `"version": "<new>"`.

Chrome's `manifest.json` `version` field uses the same `x.y.z` format as `package.json`. This ensures the installed extension version stays in sync with the platform.

### Plugins (version field + dependency ranges in `package.json`)

Plugins are standalone (not in the npm workspace). They reference platform packages with `^x.y.z` semver ranges.

For each plugin in `plugins/*/package.json`, update:

1. `"version": "<old>"` → `"version": "<new>"`
2. `"@opentabs-dev/plugin-sdk": "^<old>"` → `"@opentabs-dev/plugin-sdk": "^<new>"` (in `dependencies`)
3. `"@opentabs-dev/plugin-tools": "^<old>"` → `"@opentabs-dev/plugin-tools": "^<new>"` (in `devDependencies`)

**After editing, verify no `file:` or `workspace:` references exist in any plugin:**

```bash
grep -r '"file:\|"workspace:' plugins/*/package.json
```

This must produce no output. Plugins must use `^x.y.z` semver ranges for `@opentabs-dev/*` dependencies — never local filesystem paths.

### Dependency Graph (for reference)

Platform packages use `"*"` for intra-workspace dependencies (resolved by npm workspaces), so those do NOT need version updates. Only plugin `^x.y.z` references need updating.

```
shared (leaf — no monorepo deps)
  ← plugin-sdk
  ← browser-extension
  ← mcp-server
  ← plugin-tools (also depends on plugin-sdk)
  ← cli (depends on all 5 above)
       ← create-plugin
```

### Lock Files

- **Root `package-lock.json`**: Run `npm install --package-lock-only` at the repo root after all `package.json` edits.
- **Plugin `package-lock.json`**: These reference published versions (`^x.y.z`). They can only be updated after the platform packages are published to npm. Note this to the user — the plugin lock files will be updated when `npm install` is run after publishing.

---

## Hardcoded Version Scan

After updating `package.json` files, scan for any hardcoded version strings in source code:

```bash
grep -r '"<old-version>"' platform/ --include='*.ts' --include='*.tsx'
grep -r "'<old-version>'" platform/ --include='*.ts' --include='*.tsx'
```

If any are found, evaluate whether they should be replaced with a dynamic import (e.g., from `version.ts`) or updated to the new version. Prefer dynamic references over hardcoded strings — the MCP server already has a `version` module (`platform/mcp-server/src/version.ts`) that reads the version from `package.json` at runtime.

---

## Verification

After all edits:

```bash
npm run build        # Verify production build
npm run type-check   # TypeScript check
```

Both must exit 0. If they fail, fix the issue before considering the bump complete.

---

## Publishing

After the version bump is committed (but NOT yet pushed), publish all platform packages to npm. Publishing must happen before pushing — see "Push Ordering" above.

### Prerequisites

Verify npm authentication before publishing:

```bash
npm whoami   # Must return an account with write access to @opentabs-dev
```

### Publish Order

Publish in strict dependency order — each package must be available on the registry before its dependents are published:

```
1. shared
2. browser-extension
3. mcp-server
4. plugin-sdk
5. plugin-tools
6. cli
7. create-plugin
```

### Publish Command

For each package, run from its directory:

```bash
cd platform/<package> && npm publish
```

### Post-Publish: Update Plugins

After all platform packages are published:

1. **Install and rebuild all plugins**: `npm run build:plugins` (installs from registry + builds each plugin)
2. **Commit** the updated lock files
3. **Push** all commits (version bump + plugin lock updates) — the pre-push hook will now succeed because packages are on the registry

### npm Registry Propagation Delay

The npm registry does not guarantee immediate availability after `npm publish`. The new version may take seconds to a few minutes to propagate across all registry endpoints. If `npm install` in a plugin fails with `ETARGET` ("No matching version found for @opentabs-dev/...@^x.y.z"), this is a propagation delay — not a real error.

**Retry strategy:**

1. Wait 10 seconds, then retry `npm install`
2. If it still fails, wait 30 seconds and retry again
3. If it fails a third time, wait 60 seconds — by this point the registry has always caught up
4. Verify with `npm view @opentabs-dev/shared@<new-version> version` to confirm the version is visible on the registry before retrying

Do not skip the plugin lock file update or commit stale lock files. The retry is worth the wait.

**NEVER change npm package access levels** (public/private) without explicit user approval. All `@opentabs-dev` packages are private (`publishConfig.access: restricted`).

---

## Remote Execution via Ralph PRD

Version bumps can be offloaded to a ralph worker on the remote PC instead of running locally. This avoids the slow local build+publish cycle. Use the `ralph` skill to create and publish the PRD.

### PRD Template

```json
{
  "project": "OpenTabs Platform",
  "description": "Bump all platform packages and plugins from <OLD> to <NEW>, publish to npm, and rebuild plugins with updated lock files.",
  "qualityChecks": "npm run build && npm run type-check && npm run lint && npm run knip && npm run test",
  "userStories": [
    {
      "id": "US-001",
      "title": "Bump version from <OLD> to <NEW> and publish to npm",
      "description": "Load the bump-version skill and execute every step: bump all version references, build, publish all 7 platform packages to npm in dependency order, rebuild all plugins to update lock files, and commit everything.",
      "acceptanceCriteria": [
        "All 7 platform package.json files have version <NEW>",
        "Chrome extension manifest.json has version <NEW>",
        "All plugin package.json files have version <NEW> with SDK/tools dep ranges ^<NEW>",
        "All 7 platform packages are published to npm at <NEW> (verify with npm view)",
        "All plugin package-lock.json files reference the published <NEW> versions",
        "npm run build exits 0",
        "npm run type-check exits 0",
        "No hardcoded <OLD> version strings remain in platform/ TypeScript source"
      ],
      "priority": 1,
      "passes": false,
      "e2eCheckpoint": false,
      "model": "opus",
      "notes": "Use the `skill` tool to load the `bump-version` skill, then follow every step exactly.\n\nThe skill is at `.claude/skills/bump-version/__SKILL__.md` — read it first.\n\nKey steps in order:\n1. Update version in all 7 platform package.json files: shared, plugin-sdk, browser-extension, mcp-server, plugin-tools, cli, create-plugin\n2. Update version in platform/browser-extension/manifest.json\n3. Update version AND dependency ranges in all plugin package.json files (plugins/*/package.json)\n4. Run `npm install --package-lock-only` at repo root to update root lock file\n5. Scan for hardcoded '<OLD>' strings in platform/**/*.ts\n6. Run `npm run build` and `npm run type-check`\n7. Commit the version bump (message: 'bump version to <NEW>')\n8. Verify npm auth: `npm whoami` must return 'opentabs-dev-admin'\n9. Publish in this exact order:\n   - cd platform/shared && npm publish\n   - cd platform/browser-extension && npm publish\n   - cd platform/mcp-server && npm publish\n   - cd platform/plugin-sdk && npm publish\n   - cd platform/plugin-tools && npm publish\n   - cd platform/cli && npm publish\n   - cd platform/create-plugin && npm publish\n10. After all 7 are published, verify: `npm view @opentabs-dev/shared@<NEW> version`\n11. Run `npm run build:plugins` to install published versions and rebuild all plugins\n12. Commit plugin lock file updates (message: 'update plugin lock files for <NEW>')\n\nConstraints:\n- Do NOT change any publishConfig.access values — all packages are restricted\n- Do NOT bump the docs/ version — it is independent\n- Do NOT modify the root package.json — it has no version field\n- Do NOT change any code logic — this is a version-only change\n- Plugin packages use `^<NEW>` semver ranges, NOT exact versions\n- The publish MUST happen before build:plugins, because plugins install from the npm registry\n- If npm publish fails for a package, retry after 10 seconds (registry propagation delay)"
    }
  ]
}
```

### Why `qualityChecks` Is Set

The PRD sets a custom `qualityChecks` that **excludes `npm run test:e2e`**. E2E tests require a real Chrome browser with the extension loaded — ralph workers run in Docker containers without a display or Chrome extension, so E2E tests always fail. The version bump only changes `package.json` files and does not affect browser behavior, so skipping E2E is safe.

Without custom `qualityChecks`, the ralph safety net runs the default verification suite (including E2E) after the final story, causing the worker to waste time investigating pre-existing E2E failures unrelated to the version bump.

### Workflow

1. Load the `ralph` skill
2. Replace `<OLD>` and `<NEW>` in the template above with the actual version numbers
3. Write the PRD to the queue repo and publish via `producer.sh`
4. A worker claims it, bumps versions, publishes to npm, rebuilds plugins, and pushes the branch
5. The consolidator merges the branch into `main`

---

## Checklist

### Version Bump

- [ ] Target version confirmed with user
- [ ] All 7 platform `package.json` version fields updated
- [ ] Chrome extension `manifest.json` version updated
- [ ] All plugin `package.json` version fields updated
- [ ] All plugin `@opentabs-dev/plugin-sdk` dependency ranges updated
- [ ] All plugin `@opentabs-dev/plugin-tools` devDependency ranges updated
- [ ] Root `package-lock.json` updated (`npm install --package-lock-only`)
- [ ] Hardcoded version scan completed — no stale version strings in source code
- [ ] `npm run build` passes
- [ ] `npm run type-check` passes
- [ ] Version bump committed (NOT pushed yet)

### Publish

- [ ] `npm whoami` confirms authenticated with write access
- [ ] All 7 platform packages published in dependency order
- [ ] Plugins installed and rebuilt (`npm run build:plugins`)
- [ ] Plugin lock file updates committed
- [ ] All commits pushed (pre-push hook succeeds because packages are on npm)
