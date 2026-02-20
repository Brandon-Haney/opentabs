---
name: opentabs-ralph
description: 'Plan work and generate ralph task files for autonomous execution. Use when the user wants to plan tasks, create a prd, run ralph, or fix a batch of issues. Triggers on: ralph, create tasks, plan this, run ralph, prd.'
---

# Ralph Task Planner

Plan work and generate PRD files in `.ralph/` for autonomous execution by the Ralph daemon.

Ralph is a bash script (`.ralph/ralph.sh`) that runs as a long-lived daemon, polling `.ralph/` for ready PRD files and processing them in timestamp order. Each PRD file drives a loop of AI coding iterations — one per user story. This skill creates the PRD file that the daemon picks up automatically.

---

## PRD Location: Always Root `.ralph/`

**PRD files MUST always be written to the root `.ralph/` directory** (the one containing `ralph.sh`). The ralph daemon only watches this single directory — it does not scan subdirectories or other `.ralph/` folders elsewhere in the repo.

Even when the task targets a standalone subproject (like `docs/`), the PRD goes in root `.ralph/`. The `qualityChecks` field in the PRD tells the ralph agent how to verify the work (see "Standalone Subprojects" below).

---

## Standalone Subprojects

Some directories in the repo are **standalone projects** with their own `package.json`, build system, and tooling — separate from the root monorepo. Currently:

- **`docs/`** — Next.js + Fumadocs static docs site. Has its own `package.json` with `build`, `type-check`, `lint`, `lint:fix`, `format`, `format:check`, and `knip` scripts. No test scripts.

When planning work for a standalone subproject:

1. **PRD goes in root `.ralph/`** (not in the subproject)
2. **Add a `"qualityChecks"` field** to the PRD with the subproject-specific verification command. This overrides the default `bun run build && bun run type-check && ...` suite. Example:
   ```json
   {
     "project": "OpenTabs Docs",
     "qualityChecks": "cd docs && bun run build",
     "userStories": [...]
   }
   ```
3. **Acceptance criteria** should reference the actual checks that apply, not the root monorepo's full suite. For example, for `docs/` stories use `"cd docs && bun run build passes (next build)"` instead of the default 6-command suite.
4. **Notes should use paths relative to the repo root** (e.g., `docs/mdx-components.tsx`, not `mdx-components.tsx`) since the ralph agent runs from the project root.

### How to detect a standalone subproject

Check if the target directory has its own `package.json` that is NOT listed in the root workspace configuration. If it does, it's standalone and needs a custom `qualityChecks` field. Read the subproject's `package.json` `scripts` to determine which verification commands are available.

---

## PRD File Name State Machine

```
prd-objective~draft.json                       — being written (this skill), ralph ignores
prd-YYYY-MM-DD-HHMMSS-objective.json           — ready for pickup by ralph daemon (timestamp added at publish time)
prd-YYYY-MM-DD-HHMMSS-objective~running.json   — currently being executed by ralph
prd-YYYY-MM-DD-HHMMSS-objective~done.json      — completed, pending archive
archived to .ralph/archive/                     — final resting place
```

This skill writes with `~draft` (no timestamp). At publish time, a **shell command** generates the real timestamp and renames the file. This ensures correct ordering — the timestamp reflects when the PRD was actually ready, not when writing started.

---

## The Job

1. Receive a feature description or task from the user
2. Ask 3-5 essential clarifying questions (with lettered options) if the request is ambiguous
3. Generate the PRD file with `~draft` suffix and NO timestamp (safe from premature pickup)
4. Publish: use a shell command to rename with the current timestamp (ensures accurate ordering)

**Important:** Do NOT start implementing. Do NOT launch ralph. Just create the PRD file. The ralph daemon (`ralph.sh`) must already be running and will pick up the file automatically.

---

## Step 1: Clarifying Questions

Ask only critical questions where the initial prompt is ambiguous. Skip this step entirely if the request is already specific enough (e.g., a concrete bug fix list). Focus on:

- **Scope:** What exactly should be done?
- **Boundaries:** What should it NOT do?
- **Story size:** Small focused stories vs medium batches?
- **Success criteria:** How do we know it's done?

### Format Questions Like This:

```
1. What is the primary goal?
   A. Option one
   B. Option two
   C. Option three

2. What scope of changes per story?
   A. Small and focused (1-3 files per story, higher success rate)
   B. Medium batches (group related fixes, fewer iterations)
```

This lets users respond with "1A, 2B" for quick iteration.

---

## Step 2: Generate PRD File

### File Naming

Use a short kebab-case objective slug with NO timestamp:

```
.ralph/prd-objective-slug~draft.json
```

Example: `.ralph/prd-improve-sdk-error-handling~draft.json`

**Do NOT put a timestamp in the draft filename.** The timestamp is added by a shell command at publish time (Step 3). This prevents timestamp inaccuracies from AI model clock drift.

Keep the objective slug to 3-5 words max.

### Writing Sequence

1. **Write** the PRD to `.ralph/prd-objective-slug~draft.json` (no timestamp)
2. **Verify** the JSON is valid: `python3 -c "import json; json.load(open('.ralph/prd-objective-slug~draft.json')); print('Valid')"`
3. **Publish** via shell command (see Step 3)

### PRD Format

```json
{
  "project": "[Project Name]",
  "description": "[What this batch of work accomplishes]",
  "qualityChecks": "[Optional — override for standalone subprojects, omit for root monorepo work]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        "Specific verifiable criterion",
        "Another criterion",
        "bun run build passes",
        "bun run type-check passes",
        "bun run lint passes",
        "bun run knip passes",
        "bun run test passes",
        "bun run test:e2e passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": "Context to help the agent implement this story"
    }
  ]
}
```

**Fields:**

- `qualityChecks` (optional): A shell command string that overrides the default verification suite. Use this for standalone subprojects (see "Standalone Subprojects" above). Omit this field for work targeting the root monorepo — the ralph agent defaults to `bun run build && bun run type-check && bun run lint && bun run knip && bun run test && bun run test:e2e`.
- `passes`: MUST be the boolean `false`, not `null` or omitted. Ralph checks `passes == false` to find incomplete stories.

---

## Step 3: Publish (Rename with Timestamp)

After writing and validating the PRD, publish it using this exact shell command:

```bash
mv .ralph/prd-SLUG~draft.json ".ralph/prd-$(date '+%Y-%m-%d-%H%M%S')-SLUG.json"
```

Replace `SLUG` with your objective slug. Example:

```bash
mv .ralph/prd-improve-sdk-error-handling~draft.json ".ralph/prd-$(date '+%Y-%m-%d-%H%M%S')-improve-sdk-error-handling.json"
```

**This is critical.** The `$(date ...)` shell expansion generates the real wall-clock timestamp at the moment of publishing. Ralph processes PRDs in filename-timestamp order, so accurate timestamps ensure correct sequencing.

**Never hardcode a timestamp in the filename.** Always use `$(date '+%Y-%m-%d-%H%M%S')` in the mv command.

---

## Story Rules

### Size: One Context Window

Each story must be completable in ONE iteration (one fresh AI session with no memory of previous work).

**Right-sized stories:**

- Fix a bug in a single module
- Add a new tool or endpoint
- Refactor one file or function
- Update types in one package and fix downstream compile errors
- Extract duplicated code into a shared helper

**Too big (split these):**

- "Refactor the entire module" -- split by file or concern
- "Add a new service" -- split into: scaffold, API client, individual endpoints, tests
- "Fix all lint errors" -- split by package or error category

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

### Ordering: Dependencies First

Stories execute in priority order (1 = first). Earlier stories must not depend on later ones.

**Correct order:**

1. Shared types / data model changes
2. Backend / server changes that consume shared types
3. Frontend / UI changes
4. Tests and documentation

### Acceptance Criteria: Must Be Verifiable

Each criterion must be something the agent can CHECK, not something vague.

**Good:** "saveConfig call includes secret field", "z.number() params have .min(1)", "Dropdown shows 3 options"
**Bad:** "Works correctly", "Handles edge cases", "Good UX"

**Always include the verification suite** as the final acceptance criteria for every story. For root monorepo work, use the full suite:

- `bun run build` passes
- `bun run type-check` passes
- `bun run lint` passes
- `bun run knip` passes
- `bun run test` passes
- `bun run test:e2e` passes

For standalone subprojects, use the commands from the `qualityChecks` field instead (e.g., `cd docs && bun run build passes` for the docs project). Do not list checks that don't exist in the subproject.

### Notes Field

Use the `notes` field to give the agent implementation hints:

- Which file and approximate line number to edit
- What the current code looks like
- What pattern to follow
- What gotchas to watch for

Good notes dramatically increase success rate per iteration.

---

## Step 4: Confirm and Monitor

After publishing the PRD file, tell the user:

1. **PRD file created:** the full path and story count
2. **Auto-pickup:** the ralph daemon will pick it up automatically (no manual launch needed)
3. **Monitoring commands:**
   - **Watch ralph daemon:** `tail -f .ralph/ralph.log`
   - **Check PRD state:** `ls -la .ralph/prd-*.json` (look for `~running` suffix)
   - **Check progress:** `cat .ralph/progress-*.txt`
   - **Start ralph daemon** (if not running): `nohup .ralph/ralph.sh &`

---

## Git Rules

PRD files and progress files in `.ralph/` are gitignored and must NEVER be committed. They are ephemeral working files that change on every ralph run. If they are accidentally tracked, remove them from the index with `git rm --cached` without deleting from disk.

Ralph commits code changes only — never ralph's own state files.

---

## Checklist Before Publishing

- [ ] PRD is in root `.ralph/` (not in a subdirectory)
- [ ] Each story completable in one iteration
- [ ] Stories ordered by dependency (no story depends on a later story)
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] Notes field has implementation hints for non-trivial stories
- [ ] Verification suite in acceptance criteria matches the project (full suite for root monorepo, `qualityChecks` for standalone subprojects)
- [ ] `qualityChecks` field set if targeting a standalone subproject
- [ ] `passes` field is boolean `false` for every story
- [ ] JSON is valid
- [ ] File written with `~draft` suffix and NO timestamp in filename
- [ ] Published via `mv` command with `$(date '+%Y-%m-%d-%H%M%S')` for accurate timestamp
