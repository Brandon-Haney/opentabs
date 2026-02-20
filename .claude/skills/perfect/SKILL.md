---
name: perfect
description: 'Systematically improve one aspect of the OpenTabs platform to production-grade quality. Use when the user wants to perfect, harden, polish, or improve a specific area. Triggers on: perfect, improve, harden, polish, make robust, review and improve.'
---

# Perfect -- Convergent Platform Refinement

Systematically audit and improve one aspect of the OpenTabs platform to the highest standard of quality, making targeted fixes that move code toward perfection without disrupting what is already perfect.

OpenTabs is an open-source, plugin-based, community-driven platform that bridges MCP clients to the user's web browser through an MCP server and Chrome extension, utilizing existing web app login sessions. Every improvement must serve these goals: **security**, **user-friendliness**, **developer-friendliness**, **robustness**, and **extensibility**.

---

## The Convergence Principle

**This skill is designed to converge.** If run in a loop against the same aspect, the sequence of sessions must reach a fixed point — a state where the skill reports "this area is at the standard, nothing to change" and exits without modifications. Every session must move strictly closer to that fixed point. No session may move laterally or away from it.

This means:

- **Every fix must be the objectively best solution** — not just a fix, but the fix that no reasonable future session would undo, criticize, or replace. If you are not confident that your change is the settled, final answer, do not make it. Think longer. Research the codebase patterns more deeply. Find the solution that is obviously correct, not merely defensible.
- **Every fix must reduce the total number of issues** — a fix that resolves one problem but introduces another is not progress, it is churn. Before committing any change, evaluate: "Does this create any new surface for criticism?" If yes, find a better approach.
- **The session must be idempotent in spirit** — running this skill twice with no intervening changes must produce the same result the second time: "nothing to fix." If a second run would find new issues in code the first run wrote, the first run failed.
- **Silence is the success state** — the goal is not to produce a long list of fixes. The goal is to reach a codebase state where this skill, run by any AI session with any disposition, finds nothing to criticize. A session that reports "already perfect" after thorough review is the ideal outcome.

### The Convergence Test

Before making any change, apply this test:

> If a fresh AI session runs this same skill against this same aspect tomorrow, will it:
> (a) Confirm my change as correct and move on? → **Make the change.**
> (b) Undo my change or replace it with something else? → **Do not make the change. Find a better solution or leave the code alone.**
> (c) Find new issues that my change introduced? → **Do not make the change. It is net-negative.**

If you cannot confidently answer (a), the change is not ready.

---

## The Solid Fix Mandate

Every fix you apply must be **solid** — not just correct, but _uncriticizable_. A solid fix is one that any competent engineer or AI session, reviewing the code with fresh eyes and a critical disposition, would confirm as the right answer and move on. If a fix can be second-guessed, it is not solid. Do not apply it.

### What Makes a Fix Solid

A solid fix satisfies **all** of these criteria simultaneously:

1. **It is the canonical solution for this codebase.** It follows the patterns, conventions, naming style, and abstractions already established in the surrounding code. It does not introduce a new way of doing something when an established way already exists.
2. **It is the canonical solution in the broader ecosystem.** It follows well-known best practices for TypeScript, React, Chrome Extensions, or whatever domain applies. It is not clever or novel — it is textbook-correct.
3. **It is minimal.** It changes exactly what needs to change and nothing more. No opportunistic cleanup, no "while I'm here" additions, no stylistic tweaks bundled with a bug fix.
4. **It handles all edge cases within its scope.** It does not fix the happy path and leave edge cases for a future session. If the fix is worth making, it covers the full surface.
5. **It introduces zero new surfaces for criticism.** After applying the fix, there is nothing a critical reviewer could point to and say "but what about..." or "this should be..." or "why didn't you...". If the fix leaves any such opening, it is not finished.
6. **It is self-evidently correct.** Reading the fix, the reaction is "yes, obviously" — not "hmm, interesting approach." Obvious code does not get rewritten. Clever code does.

### The Adversarial Review Gate

Before applying any fix, you must simulate a hostile review. Imagine the most critical, pedantic AI session reviewing your change. This reviewer:

- Has full context of the codebase and its patterns
- Is looking for any reason to call the change suboptimal
- Will flag anything that deviates from established patterns
- Will flag anything that could be done more simply
- Will flag any new edge case your change creates
- Will flag any naming, typing, or structural choice that is not the obvious best

**Ask yourself these questions and answer each one honestly:**

1. "Can this reviewer find a simpler way to achieve the same result?" → If yes, use that simpler way.
2. "Can this reviewer point to an existing codebase pattern that my fix deviates from?" → If yes, follow the existing pattern.
3. "Can this reviewer identify an edge case my fix does not handle?" → If yes, handle it.
4. "Can this reviewer argue a different approach is objectively better (not just different)?" → If yes, use that approach.
5. "Would this reviewer leave my code untouched and move on?" → If not, the fix is not ready.

Only when you can honestly answer "no, no, no, no, yes" to these five questions is the fix solid enough to apply.

### When In Doubt, Do Not Change

The default posture is **do nothing**. Code that exists and works has survived at least one session's scrutiny. Changing it requires meeting a higher bar than "I think this is better." You must be able to articulate a concrete, objective defect — and your fix must be so obviously correct that no reasonable session would disagree.

If you find yourself deliberating between two approaches and cannot definitively prove one is better, **leave the code as-is**. The existing code wins ties. Always.

---

## The Standard: Perfection

The target is not "works." The target is **perfect** -- the best possible design, the cleanest implementation, the most robust error handling, the most precise types, the most helpful error messages. Code that merely functions but is poorly structured, hard to follow, fragile, or sloppy is a defect.

### What to fix

- Code that is **broken**: bugs, race conditions, unhandled errors, security holes
- Code that is **poor quality**: tangled logic, unclear names, god functions, duplication, missing abstractions, fragile patterns, sloppy error handling, imprecise types, untestable structure
- Code that is **incomplete**: missing edge case handling, missing validation, missing cleanup, missing unit tests, missing E2E coverage for critical paths, missing features the architecture clearly supports

### What to leave alone

AI sessions are ephemeral. Each session sees the codebase fresh and may be tempted to redesign things that are already well-crafted. This is the critical restraint:

- If the current design is already the right design, **do not propose an alternative** just to have something to do.
- If the current code is already clean, robust, and precise, **leave it alone** -- even if you would have written it slightly differently.
- If a previous session brought code to a high standard, **do not rearchitect it** unless you can demonstrate it falls short of perfection.
- "Different" is not "better." Only change code when you can articulate a concrete defect -- a bug, a quality gap, a missing capability, a fragile pattern, a poor abstraction.

A session that finds nothing to improve and reports "this area is already at the standard we want" is a **successful** session — arguably the most successful kind.

---

## The Job

This skill has two phases: **Review** (audit and triage) and **Delegation** (hand off to ralph via the `ralph` skill).

### Phase 1: Review

1. Receive an aspect to improve (e.g., "hot reload", "plugin discovery", "WebSocket reconnection", "error handling", "side panel UX")
2. **Deep-read the relevant code** -- every file, every function, every edge case
3. **Audit against the quality dimensions** (see below) -- produce a findings list
4. **Triage findings** -- separate genuine defects and quality gaps from lateral moves and hypothetical concerns
5. **Apply the convergence test to every proposed fix** -- only proceed with changes that pass
6. **Report findings** -- present the audit results (see "Reporting Results" below)

### Phase 2: Delegate to Ralph

7. **Load the `ralph` skill** and use it to generate a timestamped PRD file from the triaged findings
8. Each finding that passed triage becomes a user story in the PRD
9. The ralph daemon (`ralph.sh`) automatically picks up the ready PRD file — no manual launch needed

**Critical:** Do NOT implement fixes directly. This skill is a review and planning skill. After completing the audit and triage (Phase 1), always hand off to `ralph` (Phase 2) to create the PRD file. The ralph daemon handles execution autonomously.

**Important:** Do NOT redesign or rearchitect what is already well-designed. Do identify everything that falls short of the highest standard -- whether that is a bug, poor code quality, a fragile pattern, or a missing abstraction. But every finding must represent a **genuine defect** -- the kind of issue that ends the conversation, not the kind that starts a new one.

---

## Step 1: Understand the Scope

When the user says "improve X" or "perfect X", first determine exactly which files and modules constitute X.

1. **Identify the target project**: Does the area being audited belong to the root monorepo (`platform/`, `e2e/`), a standalone subproject (`docs/`), or a plugin (`plugins/<name>/`)? A directory is standalone if it has its own `package.json` that is NOT in the root `workspaces` field (`platform/*`).
2. **If targeting a standalone subproject**: Read its `package.json` to determine available scripts. The PRD you generate must include `workingDirectory` and `qualityChecks` fields matching this subproject's tooling.
3. **Map the area**: identify every file that participates in the feature
4. **Read all of them**: do not skim -- read every line of every relevant file
5. **Trace the data flow**: understand how data enters, transforms, and exits the feature
6. **Identify the boundaries**: what does this feature depend on? What depends on it?

Do not skip this step. Do not start making changes after reading one file. The audit requires complete understanding.

---

## Step 2: Audit Against Quality Dimensions

Evaluate the code against each dimension. For each, ask the specific questions listed. Record concrete findings -- not vague impressions.

### Correctness

- Are there logic errors, off-by-one bugs, or race conditions?
- Are error paths handled, or do they silently swallow failures?
- Are edge cases covered (empty inputs, concurrent calls, disconnections, timeouts)?
- Do types accurately represent the runtime values, or are there `as` casts hiding type mismatches?
- Are promises always awaited, or can unhandled rejections occur?

### Robustness

- What happens when external systems fail (WebSocket drops, Chrome API throws, disk is full)?
- Are there retry mechanisms where appropriate?
- Is cleanup always performed (event listeners removed, timers cleared, file handles closed)?
- Can the system recover gracefully from partial failures?
- Are there single points of failure that could be hardened?

### Security

- Is user data (session tokens, cookies) ever logged or exposed?
- Are WebSocket/HTTP endpoints validating input?
- Could a malicious plugin or adapter compromise the extension or other tabs?
- Are permissions scoped correctly (Chrome manifest permissions, CSP)?
- Is the plugin sandbox effective -- can adapter code escape its intended scope?

### Developer Experience (Plugin Authors)

- Is the Plugin SDK API intuitive and well-typed?
- Are error messages helpful when a plugin author makes a mistake?
- Is the build pipeline (`opentabs build`) reliable and fast?
- Is plugin discovery predictable -- does it behave as documented?
- Are the Zod schemas and type exports sufficient for good IDE support?

### User Experience (End Users)

- Does the side panel clearly communicate connection status and errors?
- Are error states recoverable without manual intervention?
- Is the extension responsive and lightweight?
- Do tab state transitions (closed/unavailable/ready) feel snappy and accurate?

### Code Quality

- Is the code modular with clear separation of concerns?
- Are there functions doing too many things?
- Is there duplication that should be extracted?
- Are names precise and descriptive?
- Are there dead code paths, unused exports, or stale comments?

### Testability

- Is the code structured so that core logic can be unit tested in isolation (pure functions, separated I/O)?
- Are critical paths covered by unit tests? Are edge cases tested, not just the happy path?
- Are integration points (MCP server, WebSocket relay, Chrome extension messaging, plugin lifecycle) covered by E2E tests?
- If a function mixes business logic with side effects (network calls, Chrome APIs, file I/O), can it be refactored so the logic is testable independently?
- Are existing tests meaningful, or do they just assert trivially obvious behavior?

### Completeness

- Are there missing features that the architecture clearly supports but nobody implemented?
- Are there documented behaviors that the code does not actually implement?
- Are there test gaps for critical paths?

---

## Step 3: Triage Findings

After auditing, categorize every finding:

### Fix (genuine defects and quality gaps)

Bugs, security issues, unhandled errors, race conditions, data loss risks -- but also poor abstractions, tangled logic, imprecise types, fragile patterns, missing cleanup, bad naming, and duplication. "It works" is not the bar. "It is excellent" is the bar.

**Examples of things to fix:**

- A WebSocket reconnection that silently drops messages
- An error handler that catches but does not report or recover
- A timer that is never cleaned up on component unmount
- A type assertion (`as`) hiding a real type mismatch
- A plugin manifest validation that accepts invalid data
- A 100-line function that mixes three concerns and is hard to follow
- Vague or misleading variable/function names
- Duplicated logic that belongs in a shared helper
- An error message that says "something went wrong" instead of describing the actual problem
- A fragile pattern that works today but would break under a reasonable future change
- A function that mixes business logic with I/O, making the logic impossible to unit test
- A critical code path with no unit test or E2E coverage

### Skip (already at the right standard, or lateral moves)

Code that is already clean, well-structured, and robust. Also: changes that would produce equivalently good code in a different style -- these are lateral moves, not improvements.

**Examples of things to skip:**

- "I would have used a Map instead of an object" (both are clean and correct here)
- "I prefer early returns" (the current structure is equally clear)
- "This could theoretically fail if X and Y happen simultaneously" (if X and Y cannot actually co-occur in this system)
- "This pattern is unusual" (unusual but well-implemented and well-reasoned is fine)

### The Triage Test

For each finding, answer: **"Does this code fall short of the highest standard? Is there a concrete defect, quality gap, fragility, or missing capability?"**

If the answer is yes, include it as a finding. If the code is already excellent and you are just proposing a lateral alternative, skip it.

---

## Step 4: Generate Ralph Tasks

After triaging findings, **do not implement fixes directly**. Instead, load the `ralph` skill and convert each triaged finding into a ralph user story.

For each triaged defect, the user story should include:

1. **Title**: a clear, concise description of the fix
2. **Description**: what is wrong, what harm it causes, what triggers it
3. **Acceptance criteria**: specific, verifiable conditions that confirm the fix is correct (include the convergence test — "a future session auditing this code would confirm the fix and move on")
4. **Notes**: implementation hints — which file(s), what the current code looks like, what the fix should look like, what patterns to follow from surrounding code

### Story Quality Standard: Definitive Solutions

Every story's notes must guide the agent toward **the solution** — not **a solution**. The difference:

- **A solution** works, addresses the symptom, might be done differently by someone else. It invites second-guessing. It creates churn across sessions.
- **The solution** is obviously correct, follows the established codebase patterns, handles edge cases, is precisely typed, is well-named, and leaves no room for "but what about..." questions. It settles the matter.

For each story's notes, include:

- What is the **canonical way** to solve this in this codebase? (Reference surrounding code patterns.)
- What is the **canonical way** to solve this in the broader ecosystem? (Reference well-known best practices.)
- What approach is so clean it is self-evidently correct?

If a finding involves a judgment call between two valid approaches and you cannot clearly articulate why one is better, **do not include it as a story**. Ambiguous improvements are lateral moves in disguise.

### Story Rules

- **Scope to the target area**: create stories for everything wrong within the area being audited, but do not drift into unrelated modules
- **One concern per story**: each story should be independently implementable. Do not bundle a bug fix with a refactor in the same story.
- **Match existing patterns**: if the codebase has an established pattern and it is well-designed, the story notes should direct the agent to follow it
- **No speculative additions**: do not create stories for code "in case" something might be needed later. Only create stories for things that genuinely fall short now.
- **No half-measures**: if a fix is worth making, the story must cover it completely. Do not create stories for partial improvements that require follow-up stories.

After generating the PRD via the `ralph` skill, the ralph daemon picks it up automatically.

---

## Step 5: Verification

Verification happens in two stages:

### During Review (this skill)

Verify the audit is thorough and the ralph task file is well-formed:

- Every file in the target area was read (not skimmed)
- Every finding is triaged against the convergence test
- The PRD stories are right-sized (one iteration each) and ordered by dependency
- **The PRD targets the correct project** — `workingDirectory` and `qualityChecks` are set for standalone subprojects, omitted for root monorepo work
- **Acceptance criteria reference the correct verification commands** — not root monorepo commands for a subproject, or vice versa

### During Execution (ralph daemon)

Each ralph iteration runs the verification suite specified in the PRD. The commands depend on the target project:

- **Root monorepo**: `bun run build && bun run type-check && bun run lint && bun run knip && bun run test && bun run test:e2e`
- **Standalone subprojects**: The command from the PRD's `qualityChecks` field (e.g., `cd docs && bun run build && bun run type-check && bun run lint && bun run knip` for docs)

Every command must exit 0. Ralph handles this automatically via the acceptance criteria in each story and the PRD's `qualityChecks` field.

---

## Reporting Results

After completing the audit (Phase 1), present findings in this format before handing off to ralph (Phase 2):

### Summary

One paragraph: what area was audited, how many files were reviewed, what was found.

### Findings (To Be Fixed via Ralph)

For each finding that passed triage:

- **File**: path and line range
- **Defect**: what is wrong
- **Proposed Fix**: what should be changed
- **Impact**: what improves

These findings become user stories in the ralph PRD.

### Already at Standard (No Changes Needed)

Briefly list areas that were reviewed and are already at the quality standard. This is important -- it tells the user (and future sessions) that these areas have been audited and confirmed excellent. This prevents the next session from re-examining the same code and making unnecessary lateral changes.

### Remaining Concerns

Issues found but not suitable for ralph stories in this session (too large, needs user input, requires design discussion). Be specific about what and why.

### Next Step

After presenting the report, load the `ralph` skill and generate the timestamped PRD file from the findings. The ralph daemon picks it up automatically — no manual launch needed.

---

## Cross-Session Continuity and Convergence

This skill is designed to be invoked repeatedly across sessions. Each session must move the platform **monotonically closer** to perfection. The sequence must converge — never oscillate, never diverge.

### The Termination Guarantee

**This skill must terminate.** If placed in an infinite loop against the same aspect, it must — not should, _must_ — reach a session that reports "this area is at the standard, nothing to change" and makes zero modifications. Every subsequent session must produce the same result: zero modifications. This is not aspirational. It is a hard requirement.

The termination guarantee means:

- **The number of issues found must strictly decrease across sessions** (or stay at zero). If Session N finds K issues and Session N+1 finds K or more issues in the same code, Session N failed — it either created new issues or made lateral changes that the next session treats as issues.
- **Every fix must be a terminal fix** — one that no future session will touch. If you are not certain your fix is terminal, do not apply it. A fix that gets rewritten by the next session was not a fix; it was churn.
- **The "already perfect" exit is the primary success path.** The skill's purpose is not to produce fixes — it is to reach a state where no fixes are needed. A session that thoroughly reviews code and reports "nothing to change" has achieved the skill's objective more completely than a session that applies ten fixes.

### The Fixed-Point Property

Imagine this skill running in an infinite loop:

```
Session 1: Audits area X, finds 5 issues, fixes 5 issues.
Session 2: Audits area X, finds 1 issue the previous session missed, fixes it.
Session 3: Audits area X, finds 0 issues. Reports "already at standard." No changes.
Session 4: Audits area X, finds 0 issues. Reports "already at standard." No changes.
... (forever)
```

This is convergence. Session 3+ is the fixed point. The sequence **must** reach this state within a small number of sessions (typically 2-3). If instead the loop looks like:

```
Session 1: Audits area X, fixes 5 issues.
Session 2: Audits area X, dislikes Session 1's approach, rewrites 3 fixes differently.
Session 3: Audits area X, dislikes Session 2's approach, rewrites 2 fixes differently.
... (forever)
```

That is divergence. It means every session is producing work that is merely "a solution" rather than "the solution." This is the failure mode this skill exists to prevent.

### Why Divergence Happens and How to Prevent It

Divergence has one root cause: **a session applies a fix that is not the objectively best solution.** When a fix is merely _good_ rather than _obviously correct_, the next session — with different aesthetic preferences, different training emphasis, or a different internal reasoning path — sees room for improvement and rewrites it. That rewrite is also merely good, so the next session rewrites it again. The loop never terminates.

Prevention is simple in principle and hard in practice: **only apply fixes that are so obviously correct they leave no room for a different opinion.** This means:

- If the fix involves a judgment call between two valid approaches, **do not make the fix**. Leave the existing code. The existing code is the tie-breaker.
- If the fix is "better" but requires an argument to explain why, **do not make the fix**. Solid fixes do not require arguments. They are self-evident.
- If you can imagine a reasonable engineer saying "I would have done this differently," **do not make the fix**. That engineer is the next session, and they will undo your work.

The only fixes that survive across sessions are fixes to **objective defects**: bugs, type errors, unhandled exceptions, security vulnerabilities, missing cleanup, violations of the codebase's own documented patterns. These are facts, not opinions. Facts converge. Opinions diverge.

### Rules for Convergence

- **Never undo a previous session's work** unless it is objectively defective — a bug, a security hole, a type error, a logic flaw. "I would have done it differently" is not a defect. "I prefer a different pattern" is not a defect. "Modern best practice suggests..." is not a defect unless the current code has a concrete, demonstrable problem.
- **Never replace working code with equivalently good code** in a different style. If both approaches are correct, the one already in the codebase wins. Stability is a feature. Churn is a defect.
- **Assume previous improvements are correct** unless you find concrete evidence they are not. The burden of proof is on the session proposing a change, not on the existing code. This burden is heavy — you must be able to point to a specific, objective flaw, not a stylistic preference.
- **Build on prior improvements** -- if a previous session improved error handling, look for edge cases it missed. Do not redesign the error handling from scratch.
- **Report what you confirmed as excellent** so the next session knows not to re-examine it. This shrinks the work surface over time, which is how convergence works.
- **Facts only** — every finding must be grounded in an objective, verifiable defect. "This could be cleaner" is not a finding. "This function swallows errors silently, causing silent data loss when X fails" is a finding. If you cannot describe the defect in terms of what goes wrong at runtime, what type is incorrect, or what documented pattern is violated, it is not a finding — it is an opinion, and opinions cause divergence.

### What Previous Sessions May Have Done

- Fixed specific bugs or edge cases
- Hardened error handling in a module
- Improved type safety
- Added missing cleanup logic

### What This Session Must Respect

- **Assume previous improvements are at standard** unless you find evidence they fall short -- a regression, a missed edge case, a quality gap the previous session did not notice
- **Do not undo previous work** because you would have done it differently -- "different" is not "better"
- **Build on prior improvements** -- if a previous session improved error handling, look for edge cases it missed or further quality gaps, do not replace the approach with an equivalent alternative
- **Report what you confirmed as already excellent** so the next session knows not to re-examine it

### What Future Sessions Will Need

- Your "Already at Standard" list tells them what is already verified as excellent — **this list should grow with each session until it covers the entire area**
- Your "Remaining Concerns" list tells them where to look next
- Your "Fixes Applied" list tells them what changed and why, and serves as evidence that the fix was deliberate and considered

---

## Anti-Patterns to Avoid

These are the specific behaviors this skill exists to prevent:

### Divergence Anti-Patterns (the most critical to avoid)

1. **Session ping-pong**: Session A refactors code one way, Session B refactors it back another way, Session C refactors it again. Each session thinks it is "improving" but the code is just oscillating between equivalent states. **Root cause:** making changes that are lateral moves, not strict improvements. **Prevention:** apply the convergence test to every change.
2. **Fix-introduces-fix**: A fix resolves one issue but creates a new surface for criticism that the next session will "fix," creating an infinite chain of fixes. **Root cause:** not self-reviewing fixes for new issues before committing. **Prevention:** after writing every fix, re-read it as a hostile reviewer would. If you can find fault, revise.
3. **Expanding scope creep**: Session A fixes 3 real issues. Session B fixes 2 real issues and "improves" 4 things that were fine. Session C "improves" 6 things that Session B wrote. The scope of "things to fix" grows instead of shrinking. **Root cause:** not applying strict triage. **Prevention:** the number of findings must decrease with each session, not increase. If you find more issues than the previous session fixed, most of your "findings" are probably lateral moves.
4. **Standards drift**: Each session applies a slightly different standard of quality, so code that met Session A's standard fails Session B's standard, which gets rewritten to fail Session C's standard. **Root cause:** subjective quality judgments. **Prevention:** ground every finding in a concrete, objective defect — a bug, a type error, a missing error path, a violation of the codebase's own established patterns.

### General Anti-Patterns

5. **Redesigning what is already excellent**: changing a well-crafted approach to a different well-crafted approach because "I prefer this style" or "it's more modern." If it is already at the highest standard, leave it alone.
6. **Scope creep**: asked to improve hot reload, ends up refactoring the entire MCP server. Perfect the target area thoroughly, but stay within it.
7. **Speculative hardening**: adding retry logic, circuit breakers, or fallback paths for scenarios that cannot actually occur in this system.
8. **Pattern evangelism**: introducing a new pattern (e.g., a state machine library, an event emitter abstraction) when the existing approach is already clean and robust.
9. **Cosmetic churning**: reordering imports, reformatting code that is already clean and clear.
10. **Completeness theater**: adding JSDoc to every function or types to every local variable when the code is already self-documenting.
11. **Testing theater**: writing tests that verify obvious behavior while ignoring actual edge cases.
12. **Busy work**: making changes so the session feels productive. A session that reports "this code is already excellent" is more valuable than one that makes lateral changes to justify its existence.
13. **Protecting garbage**: leaving poor code alone because "it works." If the implementation is sloppy, fragile, tangled, or unclear -- that is a defect, even if the output is correct. Fix it.

---

## Checklist Before Handing Off to Ralph

- [ ] **Target project identified** — determined whether findings target root monorepo, docs, a plugin, or another standalone subproject
- [ ] Read every file in the target area (not skimmed)
- [ ] Audited against all quality dimensions
- [ ] Every finding triaged: genuine quality gap or lateral move?
- [ ] **Convergence test applied to every finding**: would a future session confirm it or skip it?
- [ ] **Adversarial review gate passed for every finding**: all five questions answered "no, no, no, no, yes"
- [ ] **Every finding represents a terminal fix**: no future session will touch this code unless a new objective defect is found
- [ ] No already-excellent code was flagged for change
- [ ] No new patterns proposed when existing patterns are already at standard
- [ ] **Net issue count strictly decreased**: findings resolve more issues than they could possibly introduce
- [ ] **Termination guarantee upheld**: if this skill runs again immediately after ralph completes, it will find zero issues in code that was changed
- [ ] Results include both findings and confirmed-excellent areas
- [ ] **"Already at Standard" list is comprehensive** — covers every sub-area reviewed, giving future sessions clear signal on what not to re-examine
- [ ] **Did NOT implement fixes directly** — all fixes are delegated to ralph via PRD file
- [ ] **Loaded `ralph` skill** and generated timestamped PRD file from findings
- [ ] **PRD has correct `workingDirectory` and `qualityChecks`** if targeting a standalone subproject (omitted for root monorepo)
- [ ] **Acceptance criteria use the correct project's verification commands** — not root monorepo commands for a subproject
- [ ] Each ralph story is right-sized (completable in one iteration)
- [ ] Ralph stories are ordered by dependency (no story depends on a later story)
- [ ] Each story has specific acceptance criteria and implementation hints in the notes field
