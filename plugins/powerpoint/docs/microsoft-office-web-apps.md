# Building OpenTabs plugins for Microsoft Office web apps

A field guide for the SharePoint-hosted Office web apps — Word, Excel, PowerPoint,
OneNote — served from `*.sharepoint.com` with an editor on `*.officeapps.live.com`.
These apps share one architecture and a set of walls that cost real hours to find
the first time. This is the map, so the next plugin does not rediscover them.

The reference implementations are this plugin (`powerpoint`, the co-authoring
`/pods` channel) and `excel-online` (the EWA frame bridge). Read
[[slide-editing-plan.md]] for the PowerPoint-specific co-authoring deep dive.

## The page is three frames deep

A file open in the web editor is not one page. It nests:

```
Tab:      https://<tenant>.sharepoint.com/:p:/r/…/Doc.aspx?…      (plugin's own origin)
 └ frame: https://<tenant>.sharepoint.com/…/Doc.aspx             (same-origin wrapper)
    └ frame: https://<region>-<app>.officeapps.live.com/…        (the real editor — cross-origin OOPIF)
```

- The plugin's **adapter** runs in the top `sharepoint.com` frame — that is where its
  URL patterns match and where the Graph token lives.
- The **editor's real API** lives two frames down, in a cross-origin
  out-of-process iframe (OOPIF) on `<region>-<app>.officeapps.live.com`
  (`usc-powerpoint.officeapps.live.com/pods/ppt.aspx` for PowerPoint,
  `…-excel.officeapps.live.com/…/xlviewerinternal.aspx` for Excel). A script in
  the top frame cannot see into it.

**The host is `<region>-<app>.officeapps.live.com`** — the app name is in the
hostname. That is the only reliable per-app discriminator (see frame scoping below).

## Two transports: closed file vs open file

| | Transport A — Graph `/content` | Transport B — co-authoring channel |
| --- | --- | --- |
| Endpoint | `graph.microsoft.com/…/drives/{d}/items/{i}/content` | `…officeapps.live.com/pods/<App>.ashx` (PowerPoint) / EWA RPC (Excel) |
| Granularity | whole file (GET/PUT) | incremental revisions |
| When it works | file **not** open in an editor | file **is** open in an editor |
| Blocked by | WOPI co-authoring lock → **HTTP 423** while open | nothing — this *is* the co-author path |

A file a human has open in the web editor holds a **WOPI co-authoring lock** that
refuses *any* Graph `/content` write, including by its own author, and the lock
outlives the editor tab by **~4 minutes**. So a plugin that only knows Transport A
cannot do what a person does — edit a file they have open. Transport B is the only
way. Guard every Transport-A write with an `If-Match` on the eTag the read
observed (Graph enforces it — verified 412 on mismatch).

## The direction: co-authoring is the write path, everywhere

**Decided 2026-09-03, and it applies to every Microsoft web app this repo
touches, not just PowerPoint.** Document content is written through the app's
own co-authoring channel. The whole-file Graph PUT is legacy: it stays only
where no live path has been proven yet, and each app retires it as its live
path lands.

The reasoning is the table above, and it does not vary by app. A whole-file PUT
cannot edit a file anyone has open, because the WOPI lock refuses it outright.
When it does succeed it replaces every part of the document, including slides,
sheets or paragraphs a colleague is editing at that moment — it wins by
overwriting rather than by merging. And it cannot do the ordinary thing a person
does, which is to change a file that is open in front of them. A co-authoring
revision has none of those properties: the server merges it against everyone
else's work, exactly as it merges the editor's own.

So the target state per app is the same shape — Graph keeps metadata (file
management, sharing, search, thumbnails, versions) and closed-file reads, while
every content write goes live — and only the distance to it differs:

| App | Live channel | Where it stands |
| --- | --- | --- |
| PowerPoint | `/pods/PowerPoint.ashx` revisions | **Proven.** Live tools shipped; the staged tools are retiring as their live counterparts land. |
| Excel | EWA RPC in the editor frame | **Proven.** Stays deliberately hybrid: Graph's Workbook API is a real, supported, closed-file API, so the rule here is that anything touching an OPEN workbook, or anything Graph cannot express, goes through the bridge. |
| Word | unproven | **Research first.** Its WOPI context reports `IsPragueDocument`, which points at Fluid — binary ops over a socket rather than replayable JSON posts. Until someone captures that channel and confirms it can be replayed, the staged path is all Word has, and removing it would leave nothing. Do not retire it on principle. |
| OneNote | WAC `ObjectModel` command bus | **Different mechanism again.** Graph is unusable (the SharePoint token carries no `Notes.*` scope), reads come from the page cache, and the editor frame exposes a command bus rather than a revision wire. |

Two rules follow, and they are what keep this from being a slogan:

1. **Capability never regresses.** A staged tool is deleted when its live
   counterpart ships and is verified, not before. "We prefer co-authoring" is
   never a reason to leave a user with no way to do something.
2. **While a staged write still exists, guard it.** Every whole-file PUT carries
   an `If-Match` on the eTag its read observed, so a concurrent write loses the
   race loudly with a 412 instead of being silently overwritten. This matters
   most for a PUT that retries: a replay after a hidden success will happily
   overwrite whatever landed in between unless the eTag stops it.

## Auth: the token is minted once, on a cold load

- The page mints a **Microsoft Graph** token only on a **cold page load**. Capture
  it from the AAD token-endpoint response with a `document_start` MAIN-world
  pre-script that wraps `fetch`/`XHR` and reads the JSON from
  `login.microsoftonline.com/<tenant>/oauth2/(v2.0/)?token`. Mirror it to
  `localStorage` so warm reloads and sibling tabs can reuse it.
- The **co-authoring channel** authenticates with headers minted *in the editor
  frame*: `x-aadtoken` (a Bearer AAD token), `x-accesstoken` (a WOPI access token),
  `x-key`, `podsid`. These never appear in the top frame.
- Recovery when a token expires: **reload the tab** (`reauthenticate`) to force a
  cold mint. A silent-refresh path (MSAL `acquireTokenSilent` / a `prompt=none`
  hidden-iframe renewal using the still-valid SSO session) is the better long-term
  answer and is not yet built — see the token TODO.

### Who the page is: member, guest, or anonymous link

Graph availability is decided by the *identity the page runs as*, not by the
plugin. `_spPageContextInfo` and `_wopiContextJson` say which case you are in
(`powerpoint__diagnose` reports it as `identity.kind`):

| Page identity | How to recognise it | Graph token | Co-authoring channel |
| --- | --- | --- | --- |
| `member` — signed in to the hosting tenant | `aadUserId` set, `isExternalGuestUser` false | minted by the page's MSAL; captured per origin | works |
| `guest` — B2B guest of the hosting tenant | `isExternalGuestUser: true` | minted against the *hosting* tenant (its `tid`), so it addresses that tenant's drives — capture is per origin, nothing from the home tenant leaks across | works |
| `anonymous-link` — "anyone with the link" share | `isAnonymousGuestUser: true`, login `urn:spo:tenantanon#<tenant>`, zero `msal.*` keys | **never exists**: the page has no Microsoft 365 sign-in, so nothing mints one and nothing can be refreshed | works — the WOPI session is the only transport |

Verified 2026-09-03 on a deck in another company's tenant opened through an
edit-capable anonymous link: `get_live_outline` and the `*_live` writes reach it
through the editor frame, while every Graph-backed tool fails by design. The
plugin now throws `ANONYMOUS_SHARING_LINK` (an AUTH_ERROR sibling) naming the
live tools instead of pointing at `reauthenticate`, which is a no-op there — a
reload would only drop the live session. The captured token is stored per
origin (`<tenant>.sharepoint.com`), so a foreign tenant's page never sees, and
is never confused by, the home tenant's token.

Two capture details that bit before: the page does not call Graph on every
load (three cold loads in a row captured a token once), so a missing token
after a reload is not proof the interceptor is broken; and a Bearer token
sniffed off a Graph request header now keeps the JWT's own `exp` — the earlier
fixed 600-second trust window expired a perfectly good token ten minutes after
load.

## Reaching the cross-origin editor frame

The plugin's `urlPatterns` govern the top frame; they can never match the
cross-origin editor OOPIF. To run code there:

- Declare **`preScriptFrameMatches: ["*://*.officeapps.live.com/*"]`** in
  `package.json`. The platform registers the pre-script as an `allFrames`,
  `world: 'MAIN'`, `document_start` content script on those frames, so it runs
  inside the editor OOPIF before the app's own scripts.
- **Scope the interceptor to your app's host.** `preScriptFrameMatches` is a
  Chrome match pattern and cannot express `*-powerpoint.officeapps.live.com` (the
  `*` must be a whole label), so the registration matches *every* Office app's
  editor. Gate installation in code:

  ```ts
  const host = location.hostname.toLowerCase();
  if (host.endsWith('officeapps.live.com') && host.includes('powerpoint')) {
    installInterceptor();
  }
  ```

  Skip this and your interceptor runs inside Excel's editor (and Excel's inside
  yours), wrapping the other app's `fetch`/`XHR` for nothing. It is visible in
  DevTools as the wrong plugin's pre-script initiating requests, and it is a real
  cross-plugin bug even though it happens to be harmless to capture.
- **`browser_fetch_in_frame`** issues a request from inside a named child frame,
  same-origin to it. Its `donorGlobal` option replays a request the app already
  made (see below) — the way to use the editor's own live auth without
  reconstructing it.

## The co-authoring wire format is JSON, not opaque binary

The scariest-sounding part is the friendliest. The `/pods/PowerPoint.ashx` channel
speaks **JSON**, not raw [MS-FSSHTTPB] bytes:

```jsonc
POST /pods/PowerPoint.ashx?action=<guid>
{
  "Mode": 4,
  "srs": [[ <typeCode>, { … } ]]   // srs = an array of [typeCode, payload] sub-requests
}
```

| `typeCode` | Meaning | Payload shape |
| --- | --- | --- |
| `2` | poll / get-revisions (a read) | `{OperationId, DependentOn, ExpectedLatestRevisionId, SlideId, Sequence, LocalRenderingParams}` |
| `3` | edit (a write) | `{OperationId, DependentOn, Revisions:[…]}` |

A **type-3 revision** is a graph of typed objects:

```jsonc
"Revisions": [{
  "Id": "<guid>|<n>", "CellId": "<guid>|<n>", "BaseId": "<guid>|<n>",
  "ExpectedLatestId": "<guid>|<n>", "ContextId": "<guid>|<n>",
  "ObjectGroups": [{
    "Id": "<guid>|<n>",
    "Objects": [
      { "ObjectId": "<guid>|<n>", "ClassId": 131140, "Properties": [<propId>, <value>, …] },
      … more objects …
    ],
    "IsFolderCell": false
  }]
}]
```

- Objects are typed by numeric **`ClassId`**; each carries a flat **`Properties`**
  array of alternating numeric property-id + value. (Observed ClassIds in a text
  edit: `131140` an edit-context object whose value is `"Typing"`, `393230` a
  text/run object carrying the typed string, `1074135132`.)
- Revisions chain by identity: `Id` names this revision, `BaseId` the one it builds
  on, `ExpectedLatestId` the optimistic-concurrency guard. **Derive these from a
  live type-2 poll**, never hardcode them.
- The response is `{"Responses":[[<type>,{"StatusCode":0,…,"RevisionList":[]}]]}`.
  **`StatusCode: 0` means accepted, not necessarily applied** — a verbatim replay
  of a poll is a legitimate no-op that returns `StatusCode 0` and an empty
  `RevisionList`. Verify resulting state independently.

Crucially, **you do not build this from decoded enums — you copy an exemplar.**
The action self-labels: the `ClassId: 131140` object carries a literal
`"ActionName":"NewSlideWithLayout"` property. Diffing two captures of the *same*
action shows everything byte-identical except four slots — the revision `Id`, its
`BaseId`, and the action's `ActionId`/`ActionTime`. So capture one real request per
action and patch those four; do not reverse-engineer the object graph. See
[copy an exemplar for the object graph](#copy-an-exemplar-for-the-object-graph-read-the-bundle-for-everything-else).

## The donor / replay pattern (using captured auth safely)

The co-authoring auth headers are minted in the editor frame and must not leak to
the host page or a tool result. The pattern:

1. A frame-local `document_start` interceptor wraps `fetch`/`XHR` and stashes the
   freshest matching request as a **donor** — `{url, method, headers, body, ts}` —
   in a MAIN-world global (e.g. `__otbPptPodsDonor`). It is never posted to the
   host or exposed as a host-reachable replay function.
2. **`browser_fetch_in_frame` with `donorGlobal`** reads that donor and re-issues
   the request *inside the same frame*. The credentials are used where they were
   minted and never cross into the service worker, host page, or tool result.

Two gotchas that will eat an afternoon:

- **The app opens XHRs with a URL *relative* to the pods base**
  (`open("POST", "PowerPoint.ashx?action=…")`). The raw `open` argument does not
  contain the full `/pods/PowerPoint.ashx` path, so a naive filter never matches
  and nothing is ever stashed — even though the request is right there in the
  stack. Resolve with `new URL(url, location.href)` before matching, and stash the
  absolute form (a replay needs it).
- **Several frames share the same path.** An editor nests more than one
  `…/ppt.aspx` frame; a plain URL-substring match can land on a sibling that never
  issued the request, whose donor global is empty. When reading a donor, select the
  frame that actually *holds* it, not the first URL match. (`browser_fetch_in_frame`
  now does this automatically when `donorGlobal` is set.)

## Copy an exemplar for the object graph, read the bundle for everything else

**Correction (2026-09-03): an earlier version of this guide said the client JS
contains none of the wire field names and that you cannot read the request
graph. Both claims are false, and acting on them costs the reader the whole
static-analysis route.** `ObjectGroups`, `ExpectedLatestId`, `BaseId`, `CellId`,
`IsFolderCell`, `PutOnlyCall` and `RootObjectDescriptors` all appear verbatim in
`ppteditDS.core3.js`, alongside the revision class itself and the ClassId
literals. The bundles also yield the full command table and the property-id
registry — see "The client's own catalogs" in [[pods-action-catalog.md]].

What *is* true is narrower, and it is the part worth keeping. There is **no
per-action revision builder anywhere in the client**. `SerializedRevision` takes
a differ, walks two snapshots of the document graph, and serializes whichever
objects came back dirty, each with its complete property bag. No action id
reaches it and nothing switches on one; undo runs the same differ with the
arguments swapped. So no table exists — in the bundle or anywhere else — saying
which objects a given action's revision must carry. That single fact is why
exemplars still matter:

- **Read the bundle** for what an action is called, what a property id means and
  what type it holds, and which object type a handler targets. All of it is
  static, free, and needs no capture.
- **Capture an exemplar** for the object graph: which objects an action creates
  or dirties, and the surrounding properties a constructed write must preserve.
  That is a runtime fact about document state, and it is the only thing a
  capture is still required for.

The bound on that remaining work is small. PowerPoint only ever calls
`createInstance` with seventeen distinct ClassIds across every bundle, so the
structural surface is finite and mostly already proven.

With that framing, the exemplar procedure is:

1. **Capture one real request per action.** Every write self-labels via the
   `ClassId: 131140` object's `ActionName` (`NewSlideWithoutDialog`, `DuplicateSlide`,
   `DeleteSlide`, `CommitTextEdit`, …), so attribution is free.
2. **Diff two captures of the same action** — everything is byte-identical except
   four slots: the revision `Id` (`<session-guid>|<counter>`; the guid is stable
   per session), its `BaseId` (the current head, from a poll), and the action's
   `ActionId`/`ActionTime`.
3. **Replay = copy the exemplar verbatim, patch those four.** Derive `Id`/`BaseId`/
   `ExpectedLatestId` from a fresh type-2 poll; mint a new `ActionId`/`ActionTime`.
   This is the donor pattern, and being an opaque copy is also why it survives
   Microsoft's build churn — there are no field names to break.

**Capture needs no human "recording."** Drive the editor programmatically: CDP
keyboard events route to the focused OOPIF, and a coordinate click reaches into it
via a zero-size `pointer-events:none` marker placed in the *host* page at the target
viewport coordinate (selector-based clicks cannot cross the frame boundary).
`Ctrl+Z` undoes cleanly, so a drive → capture → undo → screenshot-verify loop is
safe on a real deck.

**Know which transport you are on.** Excel's EWA `Command` codes live in its
bundle as named constants (see `excel-online` and the EWA command catalog), and
PowerPoint's pods vocabulary is equally readable — the difference is only that
pods has no per-action object table to read, so its object graph comes from an
exemplar while its names and property semantics come from the bundle.
Its **property semantics**, however, *are* decodable — from labelled captures, not
the bundle. See below.

## Decoding the property catalog

Copy-an-exemplar replays one captured action verbatim. To **construct** varied
edits — any font, any size, any colour — you need the semantic layer: which numeric
property id means what. That is decodable, and a handful of *labelled* captures
decode it fast:

1. In the open editor make a few formatting edits with **distinctive, greppable
   values** — font size 37, font "Consolas", colour `FF0000`, right-align — each
   ideally its own edit. Export a HAR (DevTools captures the OOPIF; CDP capture does
   not).
2. Each action self-labels via `ActionName`, so you know which edit is which. Grep
   the type-3 bodies for your distinctive values to map value → property id, then
   cross-check the id against the client bundle for a symbolic name.

Text formatting lives on a **`ClassId 1179725`** run object; the run's text and the
paragraph geometry live on a sibling **`ClassId 393230`**. Decoded from one capture
set (font 37pt / Consolas / red / right-aligned):

| Property id | Meaning | Notes |
| --- | --- | --- |
| `268442635` | **Font size** | half-points — `74` = 37pt |
| `469780527` / `528` / `529` | **Font family** (latin / EA / complex-script) | e.g. `"Consolas"` |
| `469769226` | Primary typeface | |
| `469780760` | **Font colour** | string `"@RRGGBB,,"`, e.g. `"@FF0000,,"` |
| `335551500` | Font colour (redundant encoding) | BGR integer — `255` = red |
| `335551547` | Language | LCID — `1033` = en-US |
| `134224900` | **Bold** (inferred) | `true` across every capture while the text was bold; `134224901–905` are its italic/underline/… siblings, all `false`. A bold-toggle capture would confirm. |
| `469769250` | Run **text** (on `393230`) | e.g. `" Fusion draft"` |
| `469780968` | Placeholder type (on `393230`) | e.g. `"Slide"` |

Alignment and structural changes are **actions**, not properties
(`RightTextJustify`, `LeftTextJustify`, `NewSlideWithoutDialog`, …).

**Constructing an edit** = take a captured exemplar of the closest action, keep its
object graph, and patch (a) the identity fields from a live poll, (b) the single
property for your change (`268442635` for size, `469780527–529` for font,
`469780760` for colour, …). That yields `set_font` / `set_size` / `set_color` and
the rest from one capture set — no per-feature recording.

## The diagnostic playbook — how not to lose hours

The single biggest time sink is guessing. Prove each claim before acting on it.

- **CDP network capture only sees OOPIFs created after it was enabled.**
  `browser_enable_network_capture` auto-attaches child targets (`Target.setAutoAttach`,
  flattened, recursive), but an editor frame that already existed when capture
  started is never attached — so enabling capture on an open deck shows the host
  page's traffic and none of the co-authoring writes, and it is easy to conclude
  nothing is firing. Enable capture, **then reload the tab**, then act. For
  PowerPoint the in-frame write log (`__otb_pods_writelog__`, below) needs no
  capture at all; a DevTools HAR ("Save all as HAR with content") remains the
  fallback for multi-request flows.
- **The write sentinels carry no credentials.** `__otb_pods_lastwrite__` and
  `__otb_pods_writelog__` answer with `{url, method, body, ts}` — the session
  headers stay in the frame-local donor. A decode only ever needs the body; the
  network capture likewise redacts `x-accesstoken` / `x-aadtoken`.
- **Prove injection with the call stack.** A HAR entry carries
  `_initiator.stack.callFrames`. Grep it for your pre-script's filename: if
  `…-prescript-<hash>.js` appears in the stack for a given request, your
  interceptor *is* installed and *is* running on that request — which turns "why
  isn't it capturing?" from a guess into "the filter is rejecting a request I can
  see I'm receiving."
- **Console-probe the editor frame directly.** In DevTools, switch the Console's
  execution-context dropdown to the officeapps frame, then read your markers:

  ```js
  ({
    installed: XMLHttpRequest[Symbol.for('opentabs.<plugin>.<x>.xhr.patched')] === true,
    donor: window.__otb<...>Donor ?? null,
  })
  ```

  This is ground truth for "is the interceptor installed" and "did it capture,"
  independent of any tool. You can also replay the donor right there with a plain
  in-frame `fetch` to prove the transport reaches the service before wiring it into
  the plugin.
- **State hypotheses as hypotheses.** "The filter is stale," "it's a WebSocket,"
  "it's a sandboxed frame" are all plausible and all were *wrong* here at least
  once. Each was cheap to test and expensive to assume.

## Gotchas checklist

- The WOPI lock outlives the editor tab by ~4 minutes; no request shortens it.
- Navigate the **`/:p:/r/`** URL form, not the Graph `webUrl`
  (`/_layouts/15/Doc.aspx`) — only the former matches the plugin's URL pattern, so
  the pre-script never injects on the wrong one.
- The Graph token is minted only on a cold load; `reauthenticate` (reload) is a
  routine step, not an edge case.
- The **credential-harvest-and-replay pattern trips the agent's auto-mode safety
  classifier**, regardless of legitimate context. Running `browser_fetch_in_frame`
  with a `donorGlobal` needs an explicit allow rule
  (`mcp__opentabs__browser_fetch_in_frame`) — a separate gate from any build/Bash
  rule.
- A full-file ZIP write must snapshot its entries map first: deflating yields to the
  event loop, so a concurrent tool call can otherwise interleave parts.
- `CT_TextCharacterProperties` orders `a:ln` before the fill; `CT_ShapeProperties`
  orders the fill before `a:ln`. Applying the shape intuition to a run produces a
  part PowerPoint offers to repair.

## Specs and references

- [MS-FSSHTTP] / [MS-FSSHTTPB] / [MS-FSSHTTPD], with a reference implementation at
  <https://github.com/OfficeDev/Interop-TestSuites>.
- Reference plugins in this repo: `plugins/powerpoint` (pods co-authoring),
  `plugins/excel-online` (EWA frame bridge).
