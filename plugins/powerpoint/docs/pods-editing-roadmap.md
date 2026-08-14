# Editing an open deck via `/pods` — roadmap

The plan for building **edit-while-open** tooling on PowerPoint's co-authoring
channel. The mechanics and the diagnostics live in
[[microsoft-office-web-apps.md]] (the field guide); this doc is the forward plan —
what is done, what blocks the first real write, the phased path, and the full set
of tools we intend to support.

**Status (2026-08-14):** transport proven, property catalog decoded, first
constructed write not yet attempted.

## Why this exists

Graph `/content` (Transport A) can only write a file that is **not** open — the WOPI
lock returns HTTP 423 while a human has the deck open. To edit a deck the way a
person does (while it is open), the only path is the co-authoring channel
(Transport B, `POST /pods/PowerPoint.ashx`). Every tool below is the "open file"
counterpart of an existing Graph-based tool.

## What we have — proven and decoded

- **Transport.** Capture + replay of `/pods/PowerPoint.ashx` works end-to-end via
  `browser_fetch_in_frame` with `donorGlobal:"__otbPptPodsDonor"` — a live type-2
  poll replay returned HTTP 200 `{"Responses":[[2,{StatusCode:0,RevisionList:[]}]]}`.
- **Send path for a *constructed* edit exists.** `browser_fetch_in_frame` takes the
  donor for the URL + live auth headers and lets the caller **override `body`** — so
  a hand-built `{Mode,srs:[[3,…]]}` can be posted with real credentials, no new
  platform tool required.
- **Construction model:** `exemplar + patch one property + identity from a live poll`.
- **Property catalog** (run object `ClassId 1179725`; text/geometry on sibling
  `393230`) — see the field guide's table: font size `268442635` (half-points),
  family `469780527/528/529`, colour `469780760`/`335551500`, bold `134224900`
  (inferred), language `335551547`, run text `469769250`.
- **Action catalog** (each write self-labels via `ActionName` on `ClassId 131140`;
  sizes from earlier capture rounds):

  | Action | ~Bytes | Kind |
  | --- | --- | --- |
  | `SetFontSize`, `Font`, `SetFontColor` | 1.5–2.6 K | run formatting |
  | `RightTextJustify` (+ `Left`/`Center`/`Justify` siblings) | ~1.6 K | paragraph alignment |
  | `SetShapeBold` / `SetShapeItalic` / `SetShapeUnderline` | 3.7–17.5 K | run toggles |
  | `CommitTextEdit` | ~4.4 K | text content |
  | `NewSlideWithoutDialog` | 2.2–35.7 K | slide add |
  | `DeleteSlide` | 2.4 K | slide delete |
  | `DuplicateSlide` / `PasteSlide` | ~34 K | slide clone |

## Open engineering problems (what blocks the first write)

1. **Identity derivation — THE gate.** A type-3 revision chains on identity:
   `Id` (this revision, `<session-guid>|<counter>`), `BaseId` (the current head),
   `ExpectedLatestId`, `CellId`, `ContextId`. Derive `BaseId` from a fresh type-2
   poll, mint the next `Id`, set `ExpectedLatestId`. The exact counter arithmetic
   and `ExpectedLatestId` semantics are the make-or-break unknown — work them out
   from the captured exemplars + a live poll.
2. **Shape / cell targeting.** `CellId` names the shape a run edit applies to. Map a
   target shape (by slide + placeholder/role, as the Graph tools do) to its `CellId`.
3. **Constructed-write acceptance.** A verbatim replay is a no-op (`StatusCode:0`).
   An *edit we built* must actually apply — verify by re-reading state (a poll's
   `RevisionList`, a thumbnail, or a Graph read once the lock releases), never by
   `StatusCode` alone (`StatusCode:0` = accepted, not applied).
4. **Token freshness over a long session.** The `x-aadtoken`/`x-accesstoken` in the
   donor expire; today recovery is a tab reload. A silent refresh is the better
   answer — see the token TODO below.

## Ideal path forward (phased)

**Phase 0 — Proof gate (one constructed write).** Land a single hand-built edit and
prove it applies. Recommended first target: **`SetFontSize`** — smallest formatting
edit, fully decoded, trivially reversible (Ctrl+Z, or set it back), and low blast
radius. Alternative: **`NewSlideWithoutDialog`** — additive and recoverable (a stray
slide drags to the bin) and it materialises from a layout reference so the body is
small. Steps: poll → derive identity → patch one property/action into an exemplar →
POST via `browser_fetch_in_frame` (donor auth + `body` override) → verify state.
*Everything else depends on this.*

**Phase 1 — Text formatting.** From the decoded catalog: `set_font`, `set_font_size`,
`set_font_color`, `set_bold` / `set_italic` / `set_underline`, `set_alignment`. Each
= a captured exemplar of its action + the property/action already known.

**Phase 2 — Structural (slides).** `new_slide`, `delete_slide`, `duplicate_slide`,
`move_slide`. Pure copy-an-exemplar (the wire is opaque but stable); patch identity
+ the `ActionId`/`ActionTime`.

**Phase 3 — Shapes & content.** `set_text` (`CommitTextEdit`), add/move/resize shape,
shape fill and line. More object-graph surface; decode geometry/fill properties the
same differential way.

**Phase 4 — Hard cases.** Tables, images, charts — these inline large object graphs
(`DuplicateSlide` is ~34 K for this reason). Likely exemplar-only, per shape kind.

## Full tool catalog to support

The open-file counterparts of the Graph tools, mapped to the pods mechanism:

| Tool | pods action / property | Status |
| --- | --- | --- |
| `set_font_size` | `SetFontSize` · prop `268442635` (half-pt) | property decoded — needs Phase 0 |
| `set_font` | `Font` · props `469780527-529`/`469769226` | property decoded — needs Phase 0 |
| `set_font_color` | `SetFontColor` · prop `469780760`/`335551500` | property decoded — needs Phase 0 |
| `set_bold` / `set_italic` / `set_underline` | `SetShape{Bold,Italic,Underline}` · flags `134224900-905` | bold inferred; italic/underline need a toggle capture |
| `set_alignment` | `{Left,Center,Right,Justify}TextJustify` actions | `Right` captured; capture the other three |
| `set_text` | `CommitTextEdit` · run text `469769250` | needs exemplar + edit-scope decode |
| `new_slide` | `NewSlideWithoutDialog` | exemplar catalogued — needs Phase 0 |
| `delete_slide` | `DeleteSlide` | exemplar catalogued |
| `duplicate_slide` | `DuplicateSlide` | exemplar catalogued (large) |
| `move_slide` | (action TBD — capture a reorder) | needs capture |
| `add_shape` / `set_shape_fill` / `set_shape_line` | (actions/props TBD) | needs capture + decode |
| tables / images / charts | (large object graphs) | Phase 4, exemplar-only |

## Captures still needed (differential decode targets)

- **Bold toggle** (off→on) to confirm `134224900` and, in the same run, pin which of
  `134224901–905` are italic / underline / strikethrough.
- **`Left` / `Center` / `Justify` alignment** actions (only `Right` captured).
- **Shape geometry** — move a shape, resize it; decode the position/size props.
- **Shape fill / line** — set a fill colour and an outline; decode those props.
- One clean exemplar per **structural** action for the copy path.

Capture is automatable (CDP keyboard routes to the focused OOPIF; a coordinate click
reaches in via a zero-size marker in the host page; `Ctrl+Z` undoes) — so these need
no manual recording, though a human doing a few labelled edits + a HAR is the fastest
way to a clean, known-value diff.

## Cross-cutting TODOs

- **Silent token refresh** (raised as a real requirement). Today an expired Graph /
  WOPI token is recovered by reloading the tab, which is disruptive and resets the
  editor. Build a silent path — invoke the page's MSAL `acquireTokenSilent`, or a
  `prompt=none` hidden-iframe renewal against the still-valid SSO session, or a
  `grant_type=refresh_token` call — so tokens stay fresh the way they do for a human
  who never thinks about them. Applies to every Office plugin, not just PowerPoint.
- **Route the semantic tools by transport.** End state: `set_placeholder_text`,
  `add_slide`, and the formatting tools pick the transport automatically — Graph
  when the file is closed, pods when it is open — so callers never choose. The pods
  path is the fallback that makes "edit the deck I have open" work.
- **Safety-classifier gate.** The live write goes through `browser_fetch_in_frame`
  with `donorGlobal`, which the agent's auto-mode classifier blocks by default; it
  needs the allow rule (`mcp__opentabs__browser_fetch_in_frame`) already established
  for the read path.

## Risks / unknowns

- **Identity chaining** is the one genuine unknown; if the server rejects our derived
  ids the whole edit path stalls until we understand the counter/`ExpectedLatestId`
  rules. Phase 0 exists to de-risk exactly this before any tool is built.
- **Constructed vs replayed.** We have only *replayed* verbatim so far. The server
  may treat a modified body differently — Phase 0 tests this directly.
- **MS build churn.** The exemplar-copy path is resilient (opaque bytes, no field
  names to rename), but the decoded property ids *could* shift on a major client
  update; re-run the differential decode if a formatting tool starts no-op'ing.
