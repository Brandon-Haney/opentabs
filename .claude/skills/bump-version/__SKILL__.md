# Bump Version

Bump package versions across all platform packages and plugins in lockstep.

All platform packages and plugins share the same version number (e.g., `0.0.34`). This skill bumps every package to a new version in a single coordinated change.

---

## How to Execute This Skill

**Always use a ralph PRD** to execute version bumps. Do NOT run the bump locally — offload it to a ralph worker on the remote PC. This avoids the slow local build+publish cycle.

The workflow is:

1. Determine the target version (see "Versioning Model")
2. Create and publish a ralph PRD using the template below (see "The Job")
3. A worker claims it, bumps versions, publishes to npm, rebuilds plugins, and pushes the branch
4. The consolidator merges the branch into `main`

---

## Versioning Model

- **All platform packages share one version** — bumped in lockstep.
- **All plugins share that same version** — plugins also reference platform packages via `^x.y.z` semver ranges, which must be updated to match.
- **The docs site (`docs/`) has its own independent version** — do NOT bump it unless explicitly requested.
- **The root `package.json` has no version field** — leave it alone.

---

## The Job

1. **Determine the target version** — discover the current version by reading any platform `package.json` (they are all in sync). For **patch bumps**, proceed immediately without asking the user (e.g., `0.0.34` → `0.0.35`). For **minor or major bumps**, confirm the target version with the user before proceeding.
2. **Load the `ralph` skill** — use the `skill` tool to load the `ralph` skill.
3. **Write the PRD** — use the template below, replacing `<OLD>` and `<NEW>` with the actual version numbers. Write it to the queue repo with `~draft` suffix.
4. **Publish** — run `producer.sh` to rename with timestamp, commit, and push to remote.

That's it. Do NOT implement the version bump locally. The ralph worker handles everything: editing files, building, publishing to npm, rebuilding plugins, and committing.

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
        "No hardcoded <OLD> version strings remain in platform/ TypeScript source"
      ],
      "priority": 1,
      "passes": false,
      "e2eCheckpoint": false,
      "model": "opus",
      "notes": "Use the `skill` tool to load the `bump-version` skill, then follow every step in the 'Reference: What the Worker Does' section exactly.\n\nThe skill is at `.claude/skills/bump-version/__SKILL__.md` — read it first.\n\nKey steps in order:\n1. Update version in all 7 platform package.json files: shared, plugin-sdk, browser-extension, mcp-server, plugin-tools, cli, create-plugin\n2. Update version in platform/browser-extension/manifest.json\n3. Update version AND dependency ranges in all plugin package.json files (plugins/*/package.json)\n4. Run `npm install --package-lock-only` at repo root to update root lock file\n5. Scan for hardcoded '<OLD>' strings in platform/**/*.ts\n6. Run `npm run build` and `npm run type-check`\n7. Commit the version bump (message: 'bump version to <NEW>')\n8. Verify npm auth: `npm whoami` must return 'opentabs-dev-admin'\n9. Publish in this exact order:\n   - cd platform/shared && npm publish\n   - cd platform/browser-extension && npm publish\n   - cd platform/mcp-server && npm publish\n   - cd platform/plugin-sdk && npm publish\n   - cd platform/plugin-tools && npm publish\n   - cd platform/cli && npm publish\n   - cd platform/create-plugin && npm publish\n10. After all 7 are published, verify: `npm view @opentabs-dev/shared@<NEW> version`\n11. Run `npm run build:plugins` to install published versions and rebuild all plugins\n12. Commit plugin lock file updates (message: 'update plugin lock files for <NEW>')\n\nConstraints:\n- Do NOT change any publishConfig.access values — all packages are restricted\n- Do NOT bump the docs/ version — it is independent\n- Do NOT modify the root package.json — it has no version field\n- Do NOT change any code logic — this is a version-only change\n- Plugin packages use `^<NEW>` semver ranges, NOT exact versions\n- The publish MUST happen before build:plugins, because plugins install from the npm registry\n- If npm publish fails for a package, retry after 10 seconds (registry propagation delay)"
    }
  ]
}
```

### Why `qualityChecks` Is Set

The PRD sets a custom `qualityChecks` that **excludes `npm run test:e2e`**. E2E tests require a real Chrome browser with the extension loaded — ralph workers run in Docker containers without a display or Chrome extension, so E2E tests always fail. The version bump only changes `package.json` files and does not affect browser behavior, so skipping E2E is safe.

---

## Reference: What the Worker Does

The sections below describe the detailed steps the ralph worker executes. They are included here so the worker can load this skill and follow them. You (the planner) do NOT need to execute these steps — the worker does.

### Step 1: Update All Version References

#### Platform Packages (version field in `package.json`)

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

#### Chrome Extension Manifest

The Chrome extension manifest version must match the platform version:

| File                                       | Field       |
| ------------------------------------------ | ----------- |
| `platform/browser-extension/manifest.json` | `"version"` |

**Edit:** Change `"version": "<old>"` to `"version": "<new>"`.

#### Plugins (version field + dependency ranges in `package.json`)

Plugins are standalone (not in the npm workspace). They reference platform packages with `^x.y.z` semver ranges.

For each plugin in `plugins/*/package.json`, update:

1. `"version": "<old>"` → `"version": "<new>"`
2. `"@opentabs-dev/plugin-sdk": "^<old>"` → `"@opentabs-dev/plugin-sdk": "^<new>"` (in `dependencies`)
3. `"@opentabs-dev/plugin-tools": "^<old>"` → `"@opentabs-dev/plugin-tools": "^<new>"` (in `devDependencies`)

**After editing, verify no `file:` or `workspace:` references exist in any plugin:**

```bash
grep -r '"file:\|"workspace:' plugins/*/package.json
```

This must produce no output.

### Step 2: Update Root Lock File

Run `npm install --package-lock-only` at the repo root after all `package.json` edits.

### Step 3: Hardcoded Version Scan

Scan for any hardcoded version strings in source code:

```bash
grep -r '"<old-version>"' platform/ --include='*.ts' --include='*.tsx'
grep -r "'<old-version>'" platform/ --include='*.ts' --include='*.tsx'
```

If any are found, evaluate whether they should be replaced with a dynamic import (e.g., from `version.ts`) or updated to the new version. The MCP server already has a `version` module (`platform/mcp-server/src/version.ts`) that reads the version from `package.json` at runtime.

### Step 4: Verify

```bash
npm run build        # Verify production build
npm run type-check   # TypeScript check
```

Both must exit 0.

### Step 5: Commit Version Bump

Commit all changes with message: `bump version to <new>`. Do NOT push yet.

### Step 6: Publish to npm

Verify npm authentication:

```bash
npm whoami   # Must return an account with write access to @opentabs-dev
```

Publish in strict dependency order — each package must be available on the registry before its dependents are published:

```
1. cd platform/shared && npm publish
2. cd platform/browser-extension && npm publish
3. cd platform/mcp-server && npm publish
4. cd platform/plugin-sdk && npm publish
5. cd platform/plugin-tools && npm publish
6. cd platform/cli && npm publish
7. cd platform/create-plugin && npm publish
```

**NEVER change npm package access levels** (public/private) without explicit user approval. All `@opentabs-dev` packages are private (`publishConfig.access: restricted`).

#### npm Registry Propagation Delay

The npm registry does not guarantee immediate availability after `npm publish`. If `npm install` in a plugin fails with `ETARGET` ("No matching version found"), this is a propagation delay — not a real error.

**Retry strategy:**

1. Wait 10 seconds, then retry
2. If it still fails, wait 30 seconds and retry
3. If it fails a third time, wait 60 seconds
4. Verify with `npm view @opentabs-dev/shared@<new-version> version` to confirm visibility

### Step 7: Rebuild Plugins

After all platform packages are published:

1. Run `npm run build:plugins` (installs from registry + builds each plugin)
2. Commit the updated lock files with message: `update plugin lock files for <new>`

### Step 8: Push

Push all commits. The pre-push hook will succeed because packages are already on the registry.

#### Push Ordering (why publish must happen before push)

**The pre-push hook runs `npm run build:plugins`, which calls `npm install` in each plugin.** Plugins reference `@opentabs-dev/*` packages via `^x.y.z` semver ranges that resolve from the npm registry. If you push BEFORE publishing, the pre-push hook fails with `ETARGET` because the new version does not exist on npm yet.

The correct order is: **commit → publish → build:plugins → commit plugin locks → push**.

---

## Dependency Graph (for reference)

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
