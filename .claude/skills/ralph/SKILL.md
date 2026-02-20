---
name: ralph
description: 'Plan work and generate ralph task files for autonomous execution. Use when the user wants to plan tasks, create a prd, run ralph, or fix a batch of issues. Triggers on: ralph, create tasks, plan this, run ralph, prd.'
---

# Ralph Task Planner

Plan work and generate PRD files in `.ralph/` for autonomous execution by the Ralph daemon.

Ralph is a bash script (`.ralph/ralph.sh`) that runs as a long-lived daemon, polling `.ralph/` for ready PRD files and processing them in timestamp order. Each PRD file drives a loop of AI coding iterations — one per user story. This skill creates the PRD file that the daemon picks up automatically.

---

## PRD Location: Always Root `.ralph/`

**PRD files MUST always be written to the root `.ralph/` directory** (the one containing `ralph.sh`). The ralph daemon only watches this single directory — it does not scan subdirectories or other `.ralph/` folders elsewhere in the repo.

Even when the task targets a standalone subproject (like `docs/`), the PRD goes in root `.ralph/`. The `workingDirectory` and `qualityChecks` fields in the PRD tell the ralph agent which project it's working on and how to verify the work.

---

## Multi-Project Repository

This repository contains multiple projects with different build systems and verification suites. **Every PRD must target exactly one project.** If work spans multiple projects, create separate PRDs for each.

### Identifying the Target Project

When the user describes a task, determine which project it targets:

1. **Check which files/directories the task affects**
2. **Check if that directory is a standalone subproject** — does it have its own `package.json` that is NOT in the root `workspaces` field? The root workspace only includes `platform/*`.
3. **If standalone**, read the subproject's `package.json` to discover its available scripts and construct the correct `qualityChecks` command
4. **If not standalone** (i.e., the work targets `platform/`, `e2e/`, or root configs), it targets the root monorepo — omit `workingDirectory` and `qualityChecks` to use defaults

### Setting PRD Fields for Each Project Type

**Root monorepo** (targets `platform/`, `e2e/`, root configs):

```json
{
  "project": "OpenTabs Platform",
  "userStories": [...]
}
```

No `workingDirectory` or `qualityChecks` — ralph uses the default suite.

**Docs site** (targets `docs/`):

```json
{
  "project": "OpenTabs Docs",
  "workingDirectory": "docs",
  "qualityChecks": "cd docs && bun run build && bun run type-check && bun run lint && bun run knip",
  "userStories": [...]
}
```

**Plugins** (targets `plugins/<name>/`):

```json
{
  "project": "OpenTabs Plugin — <name>",
  "workingDirectory": "plugins/<name>",
  "qualityChecks": "cd plugins/<name> && bun run build && bun run type-check && bun run lint",
  "userStories": [...]
}
```

**For any standalone subproject you haven't seen before:** read its `package.json` scripts to determine which checks are available. Only include checks that the subproject actually defines. Common scripts to look for: `build`, `type-check`, `lint`, `knip`, `test`.

### Acceptance Criteria Must Match the Target Project

Story acceptance criteria must reference the verification commands appropriate for the target project:

- **Root monorepo stories**: `bun run build passes`, `bun run type-check passes`, `bun run lint passes`, `bun run knip passes`, `bun run test passes`, `bun run test:e2e passes`
- **Docs stories**: `cd docs && bun run build passes`, `cd docs && bun run type-check passes`, `cd docs && bun run lint passes`, `cd docs && bun run knip passes`
- **Plugin stories**: `cd plugins/<name> && bun run build passes`, `cd plugins/<name> && bun run type-check passes`, `cd plugins/<name> && bun run lint passes`

Do NOT list checks that the target project doesn't have scripts for.

### Notes Must Use Repo-Root-Relative Paths

All file paths in story notes must be relative to the repo root (e.g., `docs/mdx-components.tsx`, not `mdx-components.tsx`), since the ralph agent always runs from the project root.

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
2. **Determine the target project** (see "Identifying the Target Project" above)
3. Ask 3-5 essential clarifying questions (with lettered options) if the request is ambiguous
4. Generate the PRD file with `~draft` suffix and NO timestamp (safe from premature pickup)
5. Publish: use a shell command to rename with the current timestamp (ensures accurate ordering)

**Important:** Do NOT start implementing. Do NOT launch ralph. Just create the PRD file. The ralph daemon (`ralph.sh`) must already be running and will pick up the file automatically.

---

## Step 1: Determine Target Project

Before asking questions or writing the PRD:

1. Identify which directories the task affects
2. Check if the target directory has its own `package.json` outside the root workspace
3. If standalone: read its `package.json` scripts to build the `qualityChecks` command
4. If root monorepo: no special fields needed

This step is mandatory. Getting the target project wrong means ralph will run the wrong verification suite.

---

## Step 2: Clarifying Questions

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

## Step 3: Generate PRD File

### File Naming

Use a short kebab-case objective slug with NO timestamp:

```
.ralph/prd-objective-slug~draft.json
```

Example: `.ralph/prd-improve-sdk-error-handling~draft.json`

**Do NOT put a timestamp in the draft filename.** The timestamp is added by a shell command at publish time (Step 4). This prevents timestamp inaccuracies from AI model clock drift.

Keep the objective slug to 3-5 words max.

### Writing Sequence

1. **Write** the PRD to `.ralph/prd-objective-slug~draft.json` (no timestamp)
2. **Verify** the JSON is valid: `python3 -c "import json; json.load(open('.ralph/prd-objective-slug~draft.json')); print('Valid')"`
3. **Publish** via shell command (see Step 4)

### PRD Format

```json
{
  "project": "[Project Name]",
  "description": "[What this batch of work accomplishes]",
  "workingDirectory": "[Optional — subdirectory for standalone subprojects, e.g. 'docs' or 'plugins/slack'. Omit for root monorepo.]",
  "qualityChecks": "[Optional — shell command for verification. Omit for root monorepo to use default suite.]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        "Specific verifiable criterion",
        "Another criterion",
        "[verification commands matching the target project]"
      ],
      "priority": 1,
      "passes": false,
      "notes": "Context to help the agent implement this story"
    }
  ]
}
```

**Fields:**

- `workingDirectory` (optional): The subdirectory containing the target project, relative to the repo root (e.g., `"docs"`, `"plugins/slack"`). Omit for root monorepo work. The ralph agent uses this to know which project's conventions and CLAUDE.md to read.
- `qualityChecks` (optional): A shell command string that overrides the default verification suite. Must match the target project's available scripts. Omit for root monorepo work — the ralph agent defaults to `bun run build && bun run type-check && bun run lint && bun run knip && bun run test && bun run test:e2e`.
- `passes`: MUST be the boolean `false`, not `null` or omitted. Ralph checks `passes == false` to find incomplete stories.

---

## Step 4: Publish (Rename with Timestamp)

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

**Always include the verification suite** as the final acceptance criteria for every story, using commands that match the target project (see "Acceptance Criteria Must Match the Target Project" above).

### Notes Field

Use the `notes` field to give the agent implementation hints:

- Which file and approximate line number to edit
- What the current code looks like
- What pattern to follow
- What gotchas to watch for

Good notes dramatically increase success rate per iteration.

---

## Step 5: Confirm and Monitor

After publishing the PRD file, tell the user:

1. **PRD file created:** the full path and story count
2. **Target project:** which project the PRD targets and what verification commands will be used
3. **Auto-pickup:** the ralph daemon will pick it up automatically (no manual launch needed)
4. **Monitoring commands:**
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

- [ ] **Target project identified** — determined whether this is root monorepo, docs, or a plugin
- [ ] PRD is in root `.ralph/` (not in a subdirectory)
- [ ] **`workingDirectory` set** if targeting a standalone subproject (omitted for root monorepo)
- [ ] **`qualityChecks` set** if targeting a standalone subproject (omitted for root monorepo)
- [ ] **`qualityChecks` matches the subproject's actual available scripts** (verified by reading its `package.json`)
- [ ] **Acceptance criteria use the correct project's verification commands** (not the root monorepo's commands for a subproject, or vice versa)
- [ ] Each story completable in one iteration
- [ ] Stories ordered by dependency (no story depends on a later story)
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] Notes field has implementation hints for non-trivial stories
- [ ] Notes use repo-root-relative file paths
- [ ] `passes` field is boolean `false` for every story
- [ ] JSON is valid
- [ ] File written with `~draft` suffix and NO timestamp in filename
- [ ] Published via `mv` command with `$(date '+%Y-%m-%d-%H%M%S')` for accurate timestamp
