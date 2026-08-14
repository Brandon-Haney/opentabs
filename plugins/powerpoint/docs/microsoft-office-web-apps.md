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

Because it is JSON, the numeric `ClassId`/property enums can be **decoded from the
client bundle** rather than reverse-engineered from binary — see
[the bundle-extraction technique](#decoding-classid-and-property-enums).

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

## Decoding ClassId and property enums

The numeric enums are symbolic constants in the client's webpack bundles. The
technique (proven for Excel's EWA `Command` codes):

1. Find the editor's entry bundle — for PowerPoint it is loaded from
   `res.public.onecdn.static.microsoft/wise/owl/powerpoint.app.boot.<hash>.js`, and
   the editor logic is in `ppteditDS.core1.js` / `core2.js` / `core3.js` (their
   names show up in call stacks). Discover the current hashed URLs from the boot
   bundle's webpack chunk map.
2. `curl` the public CDN bundles to files (no auth needed) and `grep` for the
   feature name (`NewSlide`, `InsertSlide`, …), the `ClassId` decimals and their
   hex forms, and the property-enum constant names near the numbers.
3. Follow the webpack module graph to the routine that assembles the request and
   read how it builds the objects.

## The diagnostic playbook — how not to lose hours

The single biggest time sink is guessing. Prove each claim before acting on it.

- **CDP network capture has an OOPIF blind spot.**
  `browser_enable_network_capture` (Chrome DevTools Protocol) does **not** attach
  to the deeply-nested editor OOPIF, so the co-authoring requests never appear —
  you will see the app's *settings* poll (from a captured frame) but not the actual
  edit traffic and wrongly conclude nothing is firing. **Export a HAR from the
  user's own DevTools** ("Save all as HAR with content") — DevTools attaches to all
  frames and captures the OOPIF.
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
