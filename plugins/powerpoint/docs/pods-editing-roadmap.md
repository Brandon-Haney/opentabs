# Editing an open deck via `/pods` — roadmap

The plan for building **edit-while-open** tooling on PowerPoint's co-authoring
channel. The mechanics and the diagnostics live in
[[microsoft-office-web-apps.md]] (the field guide); this doc is the forward plan —
what is done, what blocks the first real write, the phased path, and the full set
of tools we intend to support.

**Status (2026-08-14): Phase 0 PROVEN.** A hand-constructed `SetFontSize` revision
was accepted (`StatusCode:0, IsConflict:false`) and **applied** to a live open deck
— the "Fusion draft" title's `draft` run visibly shrank 44 pt → 24 pt. Transport,
identity chaining, construction, and application are all confirmed end-to-end. The
remaining gate is a lightweight **head read** (see
[The head-read gap](#the-head-read-gap--now-the-1-blocker)) — needed to chain a
*second* edit; the first works by merging off any recent real revision.

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
- **Constructed write PROVEN (2026-08-14).** A fresh-guid `SetFontSize` revision was
  accepted and applied to a live open deck. This confirms the server accepts a
  **fresh client guid** and a **non-verbatim body** — not just a verbatim replay.
- **Identity model (decoded from 10 consecutive live edits, then verified by writing):**
  - A revision `Id` is `<clientGuid>|<counter>`; the client guid is constant per
    session. A *new* client may use its **own** fresh guid — the server accepts it.
  - `BaseId` (and the top-level `srs[1].ExpectedLatestId`) = a recent **server-canonical
    head**. **Read it, never derive it.** The server *merges* an edit based off any
    recent real revision, so the exact head is not required for the *first* edit.
  - per-revision `ExpectedLatestId = 0`, `ContextId = 0`.
  - Re-mint exactly three ids off the fresh guid — run object `|1`, revision `|2`,
    object group `|3` — and **rewrite the paragraph's run-reference** (`393230` prop
    `603987475`, a `{guid}{ctr},…` list) to point at the new run id, or the new run is
    orphaned and the change won't bind. Keep the action descriptor `b3ab583c|1` (131140)
    and the paragraph body `b3538142|49` (393230) verbatim.
  - **You cannot base a follow-up on your own optimistic `Id`, nor reuse a base your
    own edit has already superseded** — both return `StatusCode:124, ServerError
    Code 157`. Each *successive* edit needs the fresh current head → the head-read gap.
- **Construction model:** `exemplar + patch one property + fresh guid + BaseId from a live head`.
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

## Solved (Phase 0)

1. ~~**Identity derivation.**~~ **SOLVED** — see the identity model above. `BaseId` is
   *read* from a recent server head, not derived; a fresh client guid is accepted; the
   three minted ids + the paragraph run-reference rewrite are the whole recipe.
2. ~~**Constructed-write acceptance.**~~ **SOLVED** — a built (non-verbatim) edit was
   accepted (`StatusCode:0, IsConflict:false`) and applied (verified visually). The
   rule stands: `StatusCode:0` = accepted; still verify *application* by re-reading.

## The head-read gap — now the #1 blocker

A *second* edit needs the **current** server head as its `BaseId`. Two things are now
proven about that:

- Basing off your own just-submitted `Id`, or off a base your own edit has superseded,
  fails with `StatusCode:124, ServerError Code 157, Source 2`.
- The head lives only in the poll **request** (`ExpectedLatestRevisionId`), which the
  donor hides; and polling from *behind* returns a **full slide sync** (100s of KB;
  observed 863 K for one slide) with the head at the truncated tail — unreadable
  through the tool's response cap.

So the open work is a **lightweight head read**. Candidates, cheapest first:
(a) find the pods op the editor uses to learn the head without a full graph dump;
(b) expose the editor's own client-side head via a tiny pre-script read (it already
holds it — it puts it in every poll); (c) a bounded/paged sync read. Until one lands,
each session can make exactly **one** constructed edit off a known recent revision.

## Still open

3. **Shape / cell targeting.** `CellId` names the shape a run edit applies to (proven:
   `23069e19…|3` = the "Title 1" placeholder). Map a target shape (by slide +
   placeholder/role, as the Graph tools do) to its `CellId` — needs a
   `CellId`-discovery read, likely from the same sync response.
4. **Token freshness over a long session.** The `x-aadtoken`/`x-accesstoken` in the
   donor expire; today recovery is a tab reload. A silent refresh is the better
   answer — see the token TODO below.

## Reading the wire — the capture constraint

Constructing a write needs two things read from real traffic: a **type-3 body to use
as a template** (the full envelope — `ObjectGroups` nesting, the sibling context
objects, the `CellId`/`ContextId` wiring — not just the property ids) and the
**identity fields** on a live revision. Neither is in hand: the property catalog was
decoded from a HAR that is now deleted, and that decode only pulled property *values*
— it never recorded the revision identity. So Phase 0 starts by reading bytes. The
channels, and what each can and cannot see (all confirmed live 2026-08-14 on the
Fusion deck):

| Channel | Sees request **bytes**? | Notes |
| --- | --- | --- |
| **Donor replay** (`browser_fetch_in_frame` + `donorGlobal`) | **No** — by design | Returns the server **response** only; the captured request never crosses the frame boundary. This is the *write* path, not a read path. |
| **CDP capture** (`browser_enable_network_capture` → `get_network_requests` / `export_har`) | **No** | Empirically empty for `/pods/PowerPoint.ashx` — the tab-level debugger does not attach to the deeply-nested editor OOPIF (the [CDP OOPIF blind spot](microsoft-office-web-apps.md)). `export_har` reformats the same buffer, so it is blind too, and it redacts headers. |
| **DevTools HAR** (manual export from the editor's own DevTools) | **Yes** | DevTools' protocol attaches to every target including the OOPIF. This is how the property catalog was originally decoded. Proven, zero code. |
| **In-frame sentinel exfil** (a pre-script ring buffer served back through a patched `fetch` sentinel URL) | **Yes** | Fully automatable — no manual step — but adds a capture affordance to committed pre-script code and needs an extension rebuild + reload. |

Two response shapes worth recognising when replaying a donor to probe state:

- **Up-to-date poll** → `{"Responses":[[2,{"StatusCode":0,"RevisionList":[]}]]}`. An empty
  `RevisionList` means "you are current" — it carries **no head revision id**, so a
  clean poll response alone does not hand you `BaseId`. To surface real revision ids
  from a *response*, the poll must be issued from *behind* the head.
- **Stale / non-idempotent donor** → e.g. `{"Responses":[[32,{"StatusCode":124,
  "ServerError":{"Code":223,"Source":3}}]]}`. A non-poll op (srs type `32`) whose
  verbatim replay errors — the donor-staleness signature. Re-capture a fresh poll
  before trusting a replay (see [[project_ewa_bridge_donor_self_poisoning]]).

**Decision for Phase 0:** take one **labelled DevTools HAR** — a single known
formatting edit plus the surrounding polls. It yields the template body *and* the
identity chain in one artifact, needs no committed-code change, and matches the
capture approach already endorsed for the decode. Build the sentinel-exfil channel
only if repeated, unattended capture becomes necessary.

## Ideal path forward (phased)

**Phase 0 — Proof gate (one constructed write). DONE (2026-08-14).** A hand-built
`SetFontSize` on the "Fusion draft" title was accepted and applied on a live open
deck. `SetFontSize` was the right first target — smallest formatting edit, fully
decoded, low blast radius. The recipe that worked:

0. **Capture the template + identity.** One labelled DevTools HAR of a known
   `SetFontSize` edit (the property catalog + a full type-3 body + the surrounding
   polls). This is the read step the [capture constraint](#reading-the-wire--the-capture-constraint)
   forces; a 10-edit HAR also handed us the whole identity chain.
1. **Read identity, don't derive it.** From the HAR: `BaseId` = a recent
   server-canonical head; the client guid is constant per session but a *new* client
   uses its own; the counter never needs computing. (See the identity model above.)
2. **Construct.** Copy the captured type-3 body; swap the three ids to a **fresh guid**
   (run `|1`, revision `|2`, object group `|3`); **rewrite the paragraph's run-reference**
   (`393230` prop `603987475`) to the new run; set `BaseId` + top-`ExpectedLatestId` to
   a recent real revision; patch prop `268442635` (half-points). Everything else verbatim.
3. **Send.** POST via `browser_fetch_in_frame` on the Fusion tab (donor supplies auth
   headers; `body` override carries the constructed edit). Response was
   `StatusCode:0, IsConflict:false`.
4. **Verify it *applied*, not just accepted.** `StatusCode:0` = accepted only — proven
   by re-reading (the title re-rendered at the new size). A *second* edit is blocked on
   the [head-read gap](#the-head-read-gap--now-the-1-blocker).

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

- **`SetFontSize` (Phase 0 blocker)** — one labelled edit (e.g. 34→24 pt on one word),
  captured with its surrounding polls, extracting the **type-3 template body** *and*
  the revision **identity fields** (`Id`/`BaseId`/`ExpectedLatestId`/`CellId`/
  `ContextId`). This is the one capture the entire path waits on.
- **Bold toggle** (off→on) to confirm `134224900` and, in the same run, pin which of
  `134224901–905` are italic / underline / strikethrough.
- **`Left` / `Center` / `Justify` alignment** actions (only `Right` captured).
- **Shape geometry** — move a shape, resize it; decode the position/size props.
- **Shape fill / line** — set a fill colour and an outline; decode those props.
- One clean exemplar per **structural** action for the copy path.

**Driving the edits is automatable; reading them back is not (yet).** CDP keyboard
events route to the focused OOPIF and a coordinate click reaches in via a zero-size
marker in the host page (`Ctrl+Z` undoes), so the *edits* need no human. But the
resulting bytes are invisible to CDP capture (the OOPIF blind spot, confirmed
2026-08-14), so *reading* them still means a manual DevTools HAR or the in-frame
sentinel-exfil channel (see [Reading the wire](#reading-the-wire--the-capture-constraint)).
A human doing a few labelled edits + a HAR remains the fastest route to a clean,
known-value diff.

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
