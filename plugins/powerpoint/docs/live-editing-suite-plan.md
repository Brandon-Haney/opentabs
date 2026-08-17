# PowerPoint live editing suite — the plan

The product plan for rounding out AI presentation editing. Companion to
[[pods-editing-roadmap.md]] (the protocol log) and [[pods-action-catalog.md]]
(the decoded wire catalog); this doc is the forward plan: what we keep, what we
retire, the target architecture, and the build sequence.

**Status (2026-08-16): M0 and M1 complete.** M0 shipped the hygiene pass
(`update_slide_text` retired, the root-modified-flag WIP resolved, the
replay-depth guard pinned by tests). M1 shipped pods engine v2: the five
sibling directives collapsed into one `__podsAction` registry with a shared
live-model read and declarative target resolution, plus `get_live_outline`
(live reads) and `open_in_editor` (the closed-deck enabler) — adversarially
reviewed and live-verified on the test deck (outline read; a format write
set-and-reverted, with the accepted-but-dropped head-freeze failure correctly
caught by confirmation and recovered via tab reload). **M2 (`set_text`) is also
complete**: the Typing decode collapsed — the editor's own write is just the
paragraph resubmitted with its full property list and the new text in
`469769250`, no run object at all — and `set_text` shipped as a v2 action,
live-proven with a set-and-revert on the test deck (single-run paragraphs,
single-line text; multi-run and paragraph-split are the remaining text scope).
Next: M3, formatting completion.

An engine-hardening item M1/M2's live runs surfaced: a second write issued
seconds after a confirmed first write on an idle editor rides a frozen head and
is accepted-then-dropped (caught by confirmation every time, recovered by a
deck-tab reload). The engine should learn a write cooldown — wait for the head
sentinel to advance past its own last write before POSTing the next — so
back-to-back edits stop needing the reload recovery.

## Product decisions (locked 2026-08-16)

1. **Editing is co-authoring-only.** Every write goes through the pods
   co-authoring channel, the same way a human editor's does — the server merges
   it revision-by-revision, so a co-editor's in-flight work is never clobbered.
   The closed-file path (full-package OOXML rewrite via Graph `/content` PUT) is
   **not supported for edits** and will be retired: even If-Match-guarded, a
   full-file PUT replaces slides other people may be working on, and it is
   blocked (HTTP 423) the entire time anyone has the deck open anyway.
2. **The "closed deck" story is *open it, then edit*.** When a target deck is
   not open in any tab, the flow is: open the deck in a browser tab (a new
   `open_in_editor` tool), wait for the editor frame + donor to be live, then
   edit via pods. One write path, safe by construction.
3. **Decode via the autonomous capture loop.** New actions are decoded by
   driving the edit with CDP input (keyboard events route to the focused OOPIF;
   a coordinate click reaches in via the zero-size marker) and reading the
   editor's own write back through the shipped `__otb_pods_lastwrite__`
   sentinel — no manual HAR exports, no pre-script changes per capture, `Ctrl+Z`
   to undo. Manual DevTools HAR remains the fallback for multi-request flows
   (image upload) until a ring-buffer sentinel is justified.
4. **All four capability groups are in scope**, sequenced by review-flow value:
   text content → formatting completion → slide structure → shapes/tables →
   media and the long tail.

## Where we are

- **53 tools ship today.** By transport: Graph metadata (file management,
  sharing, thumbnails, versions — ~20), OOXML full-package reads
  (`get_slides`, `get_slide_content`, `get_slide_structure`, notes, comments,
  layouts — ~8), OOXML full-package rewrites (all closed-file edit tools —
  ~20), and pods live (4).
- **The pods pipeline is proven end-to-end**: donor capture in the editor
  OOPIF, head sentinel, fresh-GUID identity minting, conflict retry with
  re-derived bodies, and post-write `applied` confirmation against the live
  model (`runPodsWriteConfirmed`, with an idempotency gate so structural writes
  are never blindly re-issued).
- **The action catalog is largely decoded** (see [[pods-action-catalog.md]]).
  Exemplars exist for the entire character/paragraph/shape formatting tier
  (mechanical extensions of the shipped engine), and for the structural tier
  (`NewSlideWithLayout` shipped, `DeleteSlide` shipped, `DuplicateSlide`,
  `ChangeLayout`, `InsertShapeAtSpecifiedLocation`, `MoveShapes`, fill/outline/
  style, `PowerPointInsertTable`, table styling, `Typing`/`BackspaceCharacter`).
- **The scaling bottleneck is the engine, not the protocol.** Each new action
  today costs a ~420-line per-action extension module plus a three-place
  dispatch edit (directive interface, allow-list extractor, resolver chain
  entry) — five sibling directives already exist. The Excel EWA bridge solved
  the same problem with **one** generic directive whose declarative knobs
  absorbed every new capability; pods needs the same consolidation before the
  next ~25 actions land.

## Verdicts on the existing surface

Requested call: judge each surface on the evidence.

| Surface | Verdict | Rationale |
| --- | --- | --- |
| Graph file management, sharing, search, thumbnails, versions | **Keep** | Metadata-only; no co-editing risk. Add `restore_version` (Word plugin has the pattern). |
| OOXML package reads (`get_slides`, `get_slide_content`, `get_slide_structure`, `get_slide_notes`, `get_comments`, `list_slide_layouts`) | **Keep, complement with live reads** | Reads are safe, but they read the last *saved* package — during active co-editing they trail the live state. The pods model read (the type-2 zero-base poll the engine already uses for target resolution) is the true live read; expose it. |
| `create_presentation` | **Keep** | Uploads a brand-new file; nothing to clobber. |
| OOXML rewrite edit tools (~20: `set_placeholder_text`, `add_slide`, `delete_slide`, `duplicate_slide`, `move_slide`, `set_slide_hidden`, `add_text_box`, `add_shape`, `add_image`, `add_table`, `update_shape`, `update_slide_text`, `fit_text`, `delete_shape`, `duplicate_shape`, `update_slide_notes`…) | **Retire, staged** | Policy decision 1. Each retires when its live counterpart ships (capability never regresses). `update_slide_text` retires immediately — already superseded by `set_placeholder_text`/`update_shape` and self-described as imprecise. |
| Session model (`open_presentation`, `commit_presentation`, `discard_presentation`, `list_presentation_sessions`, `session.ts`, the write half of `pptx-utils.ts`) | **Remove at end of retirement** | Exists solely to batch closed-file rewrites. Delete `clearAllSessions` (dead export) with it. |
| Pods live tools (4) | **Keep — this is the product** | Phase 0/1 proven; the suite grows from here. |
| `__otb_pods_lastwrite__` sentinel | **Keep, now load-bearing** | Was dev tooling; it is the capture channel for the autonomous decode loop (decision 3). |
| `reauthenticate` + pre-script Graph token capture | **Keep** | Reads and file management still ride Graph. Silent token refresh stays on the cross-cutting list. |
| Uncommitted WIP (`markRootModified` in extension `pods-bridge.ts` + add-slide comment) | **Resolve now** | Keep the `pods-add-slide.ts` comment (records a live-verified fact). Delete `PROP_ROOT_MODIFIED`/`markRootModified` — unreferenced, and its doc comment generalizes a per-action finding the codebase's own live evidence contradicts. The root-modified flag (`134236525`) is per-action editor mimicry: delete sets it, add must omit it; flag handling belongs inside each action's builder next to its capture-derived comment. |

## Target architecture

### 1. Pods engine v2 — one directive, an action registry

Collapse the five sibling directives into a single generic `__podsAction`
directive, mirroring what the EWA bridge learned:

- **One extractor/resolver** in `tool-dispatch.ts`; adding an action never
  touches dispatch again.
- **An action-builder registry** in the extension: per-action pure builders
  (`buildRunFormatBody`, `buildAddSlideBody`, …) keyed by action name, each
  carrying its own capture-derived conventions (property sort, root-modified
  flag, anchor rules) and unit-tested against captured shapes.
- **Declarative target resolution**: the directive names a target
  (`{ slide: n }`, `{ shapeName }`, `{ paragraphText }`, `{ runText }`) and the
  engine resolves it against the live model in-frame — the multi-MB model never
  crosses the frame boundary. Mixed-run paragraphs stop being a bail-out and
  become a resolution case (match a run *within* a paragraph, splitting where
  the action requires).
- **Adopt the remaining EWA hardening**: bounded donor-appearance polling
  (30 s / 500 ms — right after a deck opens the donor is seconds away; today we
  fail instantly), plugin-supplied `errorHints` (map decoded
  `StatusCode`/`ServerError.Code` values to agent guidance as they're learned),
  in-page projection with honesty fields for model reads (big decks will
  otherwise hit the 200 k truncation cliff, which today surfaces as "response
  was not JSON"), a fresh correlation id per replay, and an explicit test that
  the pre-script donor interceptor honors `__otbBridgeReplayDepth` (the
  donor-self-poisoning failure Excel already paid for).
- **Version handshake**: the directive carries an engine version; a dispatcher
  that doesn't recognize it returns a loud error instead of today's silent
  raw-directive no-op when the extension build is stale.

Existing four tools migrate onto v2; their per-action modules become registry
builders (tests carry over).

### 2. The autonomous decode loop

A repeatable, no-rebuild process per new action:

1. Open the test deck (**Fusion Milestones** — never Chris's deck) in the
   editor.
2. Drive the target edit via CDP input.
3. Read the editor's write back via `__otb_pods_lastwrite__`; store the
   labelled exemplar under `scratchpad/actions/`.
4. `Ctrl+Z`, confirm the undo, capture that too if the inverse matters.
5. Diff against the live model read; decode property ids and per-action
   conventions; record them in [[pods-action-catalog.md]].

The sentinels are action-agnostic, so the loop needs **zero rebuilds** — which
also sidesteps the OOPIF attach flakiness that rebuild churn causes. If a flow
proves multi-request (image upload), extend the pre-script with a bounded
response ring buffer at that point, not before.

### 3. `open_in_editor` — the closed-deck enabler

A tool that opens a deck's WOPI edit URL in a tab, then waits until the editor
frame is live (head sentinel answers, donor captured) before returning. With
it, "edit deck X" works whether or not X was already open, on the single safe
write path. Companion: `close_editor` is unnecessary — leaving the tab open is
the co-authoring norm.

### 4. Live reads

Expose the engine's live model read as tool surface: slide list with refs,
shapes per slide with names, paragraphs/runs with text and formatting. This is
both the review-flow read ("what does slide 4 say *right now*") and the
post-write verification substrate. The OOXML reads stay for closed decks and
package-only data (comments, notes, layouts) until live equivalents exist.

## Build sequence

Each wave follows the same rhythm: capture (if needed) → decode → registry
builder + unit tests → plugin tool + schema → live verify on Fusion Milestones
(`dry_run` first, then `applied: true`) → retire the OOXML counterpart.

**M0 — Hygiene (immediately).** Resolve the uncommitted WIP per the verdict
above; add the replay-depth-guard pre-script test; retire `update_slide_text`.

**M1 — Engine v2 + loop + enablers.** The generic directive, registry,
declarative targets, hardening, version handshake; migrate the four shipped
tools; `open_in_editor`; live reads. This is the foundation everything else
lands on — it is deliberately before new capability.

**M2 — Text content (highest review-flow value).**
- `set_text` live — decode the `Typing`/`BackspaceCharacter`/`CommitTextEdit`
  edit-scope (run char-range mechanics under text-length change). This is the
  one genuinely hard decode left; captures exist, analysis doesn't.
- `NewLine` (paragraph split) rides the same decode.
- Retires: `set_placeholder_text`, `fit_text` (its fit math reappears as a
  live-side `fit_text` once size + text are both live), `update_shape`'s text
  half.

**M3 — Formatting completion (all decoded, mechanical).**
- Live-verify the `format_text` props not yet proven (underline, font family,
  color); add highlight, superscript/subscript.
- Paragraph tier: `set_alignment`, `set_line_spacing`, bullets/numbering
  toggles, indent promote/demote — paragraph-property patches, no new run;
  smaller writes than anything shipped.

**M4 — Slide structure completion.**
- `move_slide` live — the one structural capture still missing (drag a slide in
  the thumbnail pane; action name unknown).
- `duplicate_slide` live (`DuplicateSlide`, ~470 KB exemplar — large but
  captured), `change_layout` live (`ChangeLayout`), `set_slide_hidden` live
  (needs capture).
- Retires: `add_slide`, `delete_slide`, `duplicate_slide`, `move_slide`,
  `set_slide_hidden` (OOXML).

**M5 — Shapes and tables.**
- Shape patches: move/resize (`MoveShapes`), fill (`ApplyShapeFillColor`),
  outline (`ApplyShapeOutlineColor`), style (`ApplyShapeStyle`), text anchoring
  — all decoded.
- Inserts: `add_shape`/`add_text_box` (`InsertShapeAtSpecifiedLocation` +
  typing), `add_table` (`PowerPointInsertTable`), table styling and cell
  shading. `delete_shape`/`duplicate_shape` live need captures.
- Retires the corresponding OOXML shape/table tools.

**M6 — Media and the long tail.**
- Images: capture the upload leg (likely multi-request → ring-buffer sentinel),
  then `add_image` live; replace/crop/alt-text after.
- Speaker notes live, comment add/reply/resolve live (both need captures; the
  comments read side already parses the package parts).
- Charts, sections, transitions: captures + decode, priority on demand.
- Batching: multiple actions in one revision envelope (the FSSHTTP envelope is
  inherently multi-action) once multi-edit tool calls justify it.

**M7 — Retirement complete.** Session model deleted, `_live` suffixes dropped
(the pods tools take the canonical names — breaking rename, all call sites are
ours), docs updated ([[slide-editing-plan.md]]'s stale Transport B table row
included).

## Cross-cutting

- **Token freshness.** Pods writes self-heal (donor WOPI headers refresh with
  every editor poll), but Graph reads still die at ~1 h with the capture window
  closed. Silent refresh (MSAL `acquireTokenSilent` / hidden-iframe
  `prompt=none`) remains the right fix, for every Office plugin.
- **Safety classifier.** Live writes ride `browser_fetch_in_frame` +
  `donorGlobal`; the allow rule established for reads must cover the write
  path's dispatch too.
- **MS build churn.** Decoded property ids can shift on a major client update.
  The autonomous loop makes re-decode cheap: if a tool starts accept-then-
  dropping, re-capture and diff.
- **Accepted ≠ applied.** Every write keeps `applied` confirmation; structural
  writes stay non-idempotent (never re-issued unconfirmed).
- **Testing discipline.** Pure builders unit-tested against captured shapes;
  the engine loop driven end-to-end with a mocked `fetchInFrame`; live
  verification manual, on Fusion Milestones only.

## Explicitly out until asked

Animations (`p:timing` complexity, low agent value), slide master/layout
definition editing, cross-deck slide reuse, find-and-replace as a dedicated
tool (composable from live read + `set_text` once M2 lands).
