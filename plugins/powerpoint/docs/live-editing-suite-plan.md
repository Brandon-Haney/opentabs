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

**SOLVED (2026-08-17): the "second write drops" failure.** The root cause was
neither the frozen head nor client incorporation lag: the service dedupes
writes on `(session, Sequence)`, and every builder carried its capture's
constant Sequence — so within one session the first write applied and every
later one was acknowledged as a presumed retransmit and silently dropped. The
engine now mints a unique per-write Sequence (floor 100,000, above the
editor's own counter; fresh per conflict retry), and consecutive writes apply
reliably — verified live with seven back-to-back structural and format writes,
zero drops. A second mid-session failure mode was decoded the same day: the
server compacts (checkpoints) the revision stream, after which zero-base model
reads are refused with ServerError 157 and an empty RevisionList for the rest
of the session; the engine auto-recovers by reloading the deck tab and
re-reading against the fresh session's base. Both are documented in
[[pods-action-catalog.md]] under "Protocol reliability".

**Status (2026-09-03): identity-aware auth shipped; range formatting and
hyperlinks are one capture session away.** A deck in another company's tenant
opened through an edit-capable anonymous sharing link was reached live
(`get_live_outline` on the editor session) — the earlier "the plugin can't reach
a foreign tenant" diagnosis was wrong; what fails there is Graph, by design,
because an anonymous-link page has no Microsoft 365 sign-in at all. `diagnose`
now reports `identity.kind` (member / guest / anonymous-link) and `canEdit`;
Graph tools on such a page throw `ANONYMOUS_SHARING_LINK` naming the live tools;
`reauthenticate` is a no-op there. `get_live_outline` names the shape each
paragraph belongs to (walking shape → text body → paragraph in the live model),
so two paragraphs with the same text can be told apart. The in-frame write
sentinels no longer carry session headers. Next: M2b below.

**M2b capture done, range formatting SHIPPED (2026-09-03).** A live capture of
three gestures on the test deck decoded all three of the remaining text gaps at
once, and the first of them is built and live-verified.

- **Run segmentation decoded and shipped.** A paragraph's text is one string;
  `469769746` holds the run-boundary offsets and `603987475` one run reference per
  stretch, with the same run object reused across stretches. `format_text` and
  `set_font_size` now take an optional `match` (plus `occurrence`), so an agent
  formats part of a paragraph the way a person selects a few words and clicks Bold.
  Text outside the match keeps its formatting, a match spanning two formats keeps
  both bases, and a paragraph that already had several runs is no longer refused.
  Live-verified on Fusion Milestones: one word of the title turned red and back,
  `applied: true` both ways, the rest of the title untouched.
- **Hyperlinks decoded, not yet built.** PowerPoint splices a Word field code
  (`U+FDDF` + `HYPERLINK "<url>"`) into the paragraph text and hides it with run
  flags; Insert Link is two writes, the second resubmitting the whole shape. See
  [[pods-action-catalog.md]]. Building it means mutating visible text, so it wants
  its own builder, tests and set-and-revert cycle.
- **`NewLine` decoded, not yet built.** Two chained revisions in one POST, and the
  split appends a new text-body BLOCK to the shape rather than a paragraph to the
  existing one. This is the piece that turns a 1-4 paragraph template into the
  15-39 paragraphs a real review needs.
- **The client's own catalogs are now available** without a capture at all: 2,892
  action names and 2,195 property ids with types, extracted from anonymously
  fetchable bundles and validated against every id this repo had decoded by hand.
  They settle naming and semantics; they do not settle which objects a revision
  must carry, so captures remain the way to learn an action's object graph.

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

**M2b — Format like a person does: select a range, then apply (needs one capture
session).** Today `format_text` formats a whole single-run paragraph, `set_text`
replaces one paragraph, and there is no hyperlink action — the three gaps that
stopped the SOP-link deck (an agent needs 15–39 paragraphs where the template
gives 1–4, needs to bold or colour part of a line, and needs 11 hyperlinks).

What the live model already tells us (zero-base read of Fusion Milestones,
2026-09-03): text lives on the paragraph only — runs carry formatting, not text
— and the deck's one two-run paragraph carries paragraph property `469769746 =
"8"`, the character length of its first run. The working hypothesis is that run
boundaries are a paragraph-level offset list, so a range format is: new run
objects (copies of the covering run with the changed props), the run-ref list
`603987475` rewritten to name the pieces in order, and `469769746` set to the
split offsets — the whole paragraph resubmitted, end-mark `536886591` untouched.
A hyperlink is expected to be a run-level property (or a small linked object)
on the covering run. Neither is built until the editor's own writes confirm the
shape; the last constructed run collapse without a capture crashed the editor.

The capture session (Brandon, on Fusion Milestones only — never Chris's deck),
one gesture at a time, reading the write log after each:

1. Confirm the interceptor is live: `browser_fetch_in_frame({ tabId,
   frameUrlIncludes: "powerpoint.officeapps", donorGlobal: "__otbPptPodsDonor",
   url: "https://opentabs.invalid/__otb_pods_head__" })` answers `{head, ts}`
   with a fresh `ts`. A stale `ts` or a 404 page means the tab predates the
   pre-script registration — reload it first.
2. In the title, select the single word `Timeline` (double-click) and press
   **Ctrl+B** — a bold toggle on a range inside a one-run paragraph. Read
   `https://opentabs.invalid/__otb_pods_writelog__` the same way (newest first,
   `{url, method, body, ts}`, no headers). Then **Ctrl+Z**, read again (the
   inverse), and confirm with `get_live_outline` that the title is one run again.
3. Select `Milestones`, press **Ctrl+K**, paste a URL (any public page), Enter.
   Read the log — expect one or two type-3 writes; the one after the dialog
   commit carries the link. **Ctrl+Z**, read again.
4. Click at the end of the title, press **Enter**, type `Second line`. Read the
   log — the `NewLine` split plus the `Typing` write for the new paragraph.
   **Ctrl+Z** twice, read again.
5. Save each body under `plugins/powerpoint/docs/exemplars/<ActionName>.json`
   (bodies only — the sentinels carry nothing else) and diff against the model
   read; record the property ids in [[pods-action-catalog.md]].

The ring buffer keeps 12 writes and `browser_fetch_in_frame` returns at most
200 K characters, so read after every gesture rather than at the end. Once
decoded: `format_text` gains `range: { start, end }` (or `match: "Timeline"`)
resolved against the paragraph text, `set_hyperlink` mirrors Excel's tool shape
(`url`, `remove`), and `set_text` gains multi-line input that emits one
paragraph per line. All three are registry builders on the existing engine.

**M3 — Formatting completion (all decoded, mechanical).**
- ~~Live-verify `format_text` colour~~ **DONE 2026-09-03** (a range colour change,
  set and reverted). Underline and font family are still unproven live; add
  highlight, and strikethrough/superscript/subscript (`134224903`/`904`/`905`,
  named by the client's registry).
- Paragraph tier: `set_alignment`, `set_line_spacing`, bullets/numbering
  toggles, indent promote/demote — paragraph-property patches, no new run;
  smaller writes than anything shipped.

**M4 — Slide structure completion.**
- ~~`move_slide` live~~ **SHIPPED 2026-08-17** as `move_slide_live`
  (`MoveSlideById`, captured 2026-08-16): the root's ordered slide list
  reordered, everything else verbatim — live-verified that the parallel ref
  lists need no client-side maintenance. `set_slide_background`
  (`FormatBackgroundSolidFill`) shipped the same day.
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
  inherently multi-action, and the editor's own multi-run deletes chain
  revisions intra-POST). With the Sequence fix, consecutive single-action
  writes are already reliable — batching is now about atomicity and round-trip
  economy for multi-edit reviews, not reliability.

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
