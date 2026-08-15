# Editing an open deck via `/pods` — roadmap

The plan for building **edit-while-open** tooling on PowerPoint's co-authoring
channel. The mechanics and the diagnostics live in
[[microsoft-office-web-apps.md]] (the field guide); this doc is the forward plan —
what is done, what blocks the first real write, the phased path, and the full set
of tools we intend to support.

**Status (2026-08-14): Phase 0 PROVEN.** A hand-constructed `SetFontSize` revision
was accepted (`StatusCode:0, IsConflict:false`) and **applied** to a live open deck
— the "Fusion draft" title's `draft` run visibly shrank 44 pt → 24 pt. Transport,
identity chaining, construction, and application are all confirmed end-to-end, and the
**head read is solved**, and the **dispatch path is shipped** (see
[The dispatch path](#the-dispatch-path--shipped-2026-08-14)) — a plugin tool now triggers a
pods write with one call. What remains before real formatting tools is the **object-graph
read** (decoded; build pending): finding a target shape and its per-session edit-form
paragraph/run object ids on the live deck, so a tool can construct an edit for an arbitrary
shape rather than a captured template.

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

## The head read — SOLVED (2026-08-14)

A *second* edit needs the **current** server head as its `BaseId` (basing off your own
just-submitted `Id`, or off a base a prior edit has superseded, fails with
`StatusCode:124, ServerError Code 157, Source 2`). The head lives only in the poll
**request** (`ExpectedLatestRevisionId`) — a poll response omits it when current, and
polling from *behind* returns a full slide sync (863 K for one slide) with the head at
the truncated tail.

**Fix (candidate (b), shipped):** the pods interceptor parses `ExpectedLatestRevisionId`
out of the editor's own polls and serves the latest head back through an in-frame
`fetch` **sentinel** (URL marker `__otb_pods_head__`). `browser_fetch_in_frame` reads it
in one cheap call; only a bare revision id leaves, and only inside the frame. Proven
end-to-end: read head → construct a chained `SetFontSize` → accepted and applied (the
"draft" run was shrunk and then restored on a live deck). Chaining is no longer bounded
to one edit per session.

**The read flow:** `browser_fetch_in_frame(tabId, frameUrlIncludes:"powerpoint.officeapps",
donorGlobal:"__otbPptPodsDonor", url:"https://opentabs.invalid/__otb_pods_head__")` →
`{ head, ts }`. The `donorGlobal` is only there to select the editor frame; the URL
override hits the sentinel. Read the head fresh right before each edit — after your own
edit the editor briefly reports an optimistic id, then settles to a server `newguid|1`.

## The dispatch path — SHIPPED (2026-08-14)

A plugin tool can now trigger a pods write with one call — it never touches the editor
frame itself. The tool builds the `{Mode,srs}` body with two placeholder tokens and
returns a `__podsBridge` directive; the extension resolves it on the dispatch tab.

- **Directive** (`podsWrite(body)` in `plugins/powerpoint/src/pods-bridge.ts`):
  `{ __podsBridge: { frameUrlIncludes, donorGlobal, headSentinel, body, guidToken, headToken } }`.
  The body carries `__OTB_PODS_GUID__` in the run/revision/object-group ids + the run-reference,
  and `__OTB_PODS_HEAD__` at `BaseId`/top-`ExpectedLatestId`.
- **Engine** (`runPodsBridge` in `platform/browser-extension/src/browser-commands/pods-bridge.ts`):
  reads the head sentinel → mints one `crypto.randomUUID()` → two string substitutions over the
  serialized body → replays the POST via `fetchInFrame(donorGlobal)` → judges success on the
  parsed payload (`StatusCode:0 && !IsConflict`) → retries a stale-base conflict (up to 3×) with a
  freshly-read head. A sibling of the EWA bridge, sharing only `fetchInFrame`; wired as a second
  resolver after `resolveBridgeDirective` in `tool-dispatch.ts` (each a no-op unless its marker is
  present). No MCP-server surface.
- **Security:** the donor and head are read only inside the editor frame; only a bare revision id
  and the constructed body cross the boundary. The pods pre-script honours `__otbBridgeReplayDepth`
  so a replayed write is not re-captured as its own donor.
- **Proven** end-to-end via a temporary tool (since removed): two tool-triggered `SetFontSize`
  writes on a live deck, each reading a fresh head and returning `StatusCode:0`. Unit-tested:
  engine substitution/verdict/retry/null-head, the allow-list parser, and the `podsWrite` factory.

The gap to real formatting tools is now purely the **object-graph read** (below) — a tool still
needs to find the target shape and its per-session edit-form paragraph/run object ids on the live deck.

## The object-graph read — decoded (build pending, 2026-08-14)

The last piece before real formatting tools: on the live deck, find a target shape and
its edit-form paragraph/run object ids so a tool can construct a write for it. Decoded
from a cold-load HAR:

- **`CellId` is a per-slide storage cell, not a shape.** `23069e19…|3` holds the *whole*
  slide's objects (100+). Shapes are addressed by their object ids *within* the cell, and
  the edit targets a paragraph/run, not the cell.
- **Two id-spaces, two read forms:**
  - **Render form** — a **type-2 poll** returns shapes as `ClassId 1074135132` objects, each
    carrying the shape **name** (`469780826`, e.g. "Title 1") and a render run-list. Good for
    *finding* a shape by name; its ids are render-space, not writable.
  - **Edit form** — a **type-3 `PutOnlyCall`** returns, in its **`MergedChanges`**, the
    write-form model: `393230` paragraphs carrying the **text** (`469769250`) + a run-ref list
    (`603987475`), and `1179725` runs carrying the **formatting** (`268442635` font size in
    half-points). This is exactly the shape a constructed write uses, plus `LatestRevisionId`
    (the head). Object ids here are **per-session** (they change every load), so the read must
    be live.
- **On-demand `MergedChanges` is hard (2 negative live experiments).** `MergedChanges` is
  "everything since your base," and the cold-load client got it by pushing a real slide-flag
  revision (`393271`) against a *behind* base. But **both** an empty-`Revisions` type-3 **and**
  a no-op (empty-`ObjectGroups`) revision against the file base `0f4f6c23…|1` come back
  `StatusCode:0` with **no** `MergedChanges` — the server just accepts them. So it needs the
  genuine cold-load conditions (a real object push against a server-tracked behind base with an
  actual delta), which is not cleanly replicable from a tool.

**Tried: capture `MergedChanges` from the network.** A pre-script shape-index builder was
written (parse the edit-form `MergedChanges` in-frame → index paragraphs by text → serve via a
sentinel; the sentinel and capture path worked, 27 pods responses seen). But **`MergedChanges`
never flowed on a warm reload** (`mergedSeen: 0`, even after advancing the head then reloading).
At the time this was attributed to the editor caching the model in IndexedDB. **That
attribution was wrong** — see the storage inspection below. The index builder was reverted.

**Verified: the edit-form model is not persisted in any client store** (both origins,
IndexedDB *and* Cache Storage — inspected in-frame via a temporary `__otb_pods_idb__` sentinel
plus a same-origin read of the WOPI host frame):

- **Editor origin (`usc-powerpoint.officeapps.live.com`):** IndexedDB holds only Office add-in
  plumbing (`OSF.Cache`, `OSF.MOS.Acquisitions`, `OSF.TMT.Titles`, `SdxCatalog` manifests), a
  user-photo cache, sensitivity labels, and *empty* model/telemetry stores (`ALModels_db` and a
  GUID-named db, both count 0). **Cache Storage is empty.** No document model anywhere.
- **WOPI host origin (`*.sharepoint.com`):** a `PowerPointDocument` IndexedDB exists, but its
  one store (`Documents`) holds only **`EUPL_*` / `EUPL_H_*` encrypted rendered previews**
  (`{devicePixelRatio, encryptedData, iv, euplCacheVersion, lut}`, one normal + one high-res per
  open deck) — the "fastboot" preview painted instantly on load (`fastboot=true` is in the pods
  URL), AES-encrypted at rest. **Not the editable object graph.** Cache Storage empty.

So there is **nothing editable cached client-side to read.** The instant-paint on reload is the
encrypted preview; the real write-form model is an **in-memory runtime construct that streams
over the network on every session start.** The "read the cached model directly" avenue is
closed.

**The real read path — CONFIRMED LIVE: the *session-open* response carries the full model.**
Because nothing editable is cached, the editor loads the whole object graph over pods on every
fresh session. A temporary response-capture (`__otb_pods_resp__` sentinel, added to the donor
interceptor) recorded every `/pods` response on a cold load and confirmed it directly. Of 42
responses, the model is a single **type-1 response** (`{"Responses":[[1,{…}]]}`), **~450 KB**,
with **`BaseId: 00000000-0000-0000-0000-000000000000|0`** (from-scratch full load). Marker
counts in it: `393230` (paragraphs) **59**, `1179725` (runs) **28**, `469769250` (text) **59**,
`469780826` (shape names) **86**, `1074135132` (render shapes) **85**, `LatestRevisionId` 1. The
other big responses are noise: `RenderedImages` (base64 PNG), `MainMasterResources` (master/layout
styles). So the session-open type-1 / zero-base response **is** the write-form read.

**Model structure (decoded from the captured body).** Envelope:
`Responses[[1,{Cells:[{RevisionList:[{BaseId:"0…|0", ObjectGroups:[{Objects:[…]}]}]}]}]]`. Each
object is `{ClassId, ObjectId:"<guid>|<ctr>", Properties:[id,val,id,val,…]}` (a **flat** id/value
pair array). `393271` = presentation root (slide refs in props `603998444`/`603995377` as
`{guid}{ctr},…` lists). `1179649` = master/layout catalog (`ContentMasters` with names "Title
Slide", "Text Only 1"). The write-form objects: `393230` paragraphs (text `469769250`, run-ref
list `603987475`), `1179725` runs (size `268442635` half-pt, text `469769250`), `1074135132`
render shapes (name `469780826`).

**In-frame parser BUILT (uncommitted WIP in `pre-script.ts`).** Reducing 450 KB in-frame beats
pulling it through the tool boundary in chunks (~200 K tokens of double-escaped JSON). The
`__otb_pods_resp__` sentinel now has three modes: default = response summaries; `?off=&len=` =
raw slice of the richest body; **`?parse=1`** = recursive walk collecting every
`{ClassId,ObjectId,Properties}` → compact index (paragraphs `{objectId,text,runRef}`, runs
`{objectId,sizeHalfPt,text}`, shapes `{objectId,name}` + class histogram). Summary and chunk
modes are proven live; `?parse=1` is deployed but not yet read back (blocked — see below).

**BLOCKER — OOPIF pre-script registration degrades under rebuild churn.** The `__frames`
content script (`world:MAIN`, `allFrames:true`, `*://*.officeapps.live.com/*`) attaches
UNRELIABLY to a freshly-loaded editor OOPIF, and gets worse with each pre-script rebuild (each
rebuild re-registers, and Chrome's MAIN-world OOPIF injection is flaky). It worked cleanly early
(frames 11537/11556/11640 returned live data) but after ~8 rebuilds it stopped attaching, and
~15 rapid deck reloads pushed `officeapps.live.com` into serving a **404 "Service Unavailable"
WAC page** (Microsoft-side session throttling) with screenshots failing "image readback". Recipe
to iterate pods pre-script changes with the least pain: **minimize rebuilds** (develop offline,
deploy once); after a rebuild, `extension_reload` then reload until the head sentinel returns
JSON (not a 404 / "Failed to fetch"); if it won't attach, hard-reload the extension from
`chrome://extensions` and let officeapps cool down for a few minutes before reloading the deck.
The parser is proven-shaped and will return the index on the next clean attach.

Once the index is available, `set_font_size` = read it → find the paragraph by visible text →
construct (new run + rewrite the paragraph's run-ref, identity tokens) → the shipped `podsWrite`
dispatch. Also test whether a **partial run update** (only the size property) applies, which
would shrink what the index needs.

## Still open

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
