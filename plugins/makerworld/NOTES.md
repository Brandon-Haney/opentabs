# MakerWorld plugin — working notes

Investigation log and open work. The [README](./README.md) documents behaviour a
_user_ of the tools needs; this file records what was learned reverse-engineering the
site, what has been ruled out, and what is still open — so a later session can resume
without re-deriving any of it.

Last worked: **2026-08-12**. Tool count: **31**.

---

## Reverse-engineering technique

The whole REST surface is generated client code in the Next.js bundles. Two things
make it tractable:

**Resolving which service an endpoint sits on.** Calls look like
`(0,n.XX)({url:"/path",method:"get"})`, where `XX` is a minified wrapper. Grep a
page's chunks for `(\w+)\s*[:=].*=>\s*\w+\(\{name:"([a-z-]+-service)"` to get the
letter→service map, then follow re-export chains like `Bi:function(){return f}` to
resolve an imported symbol. Adjacent calls in the same client module can sit on
**different** services — `/my/createfromdesign/{id}` is on `creation-service` while
the draft endpoints beside it are on `design-service`. Never infer a prefix from a
neighbour.

**Probing heuristic: 404 means wrong path, 400 means right path and wrong body.**
That distinction located both `comment-service` and `creation-service` after guesses
failed.

Path params are built with `.concat()`, so a regex over `url:"..."` literals misses
roughly half the endpoints.

### Services (22)

`iot` · `user` · `design` · `search` · `aftersale` · `comment` · `report` ·
`operation` · `point` · `design-user` · `creation` · `creation-executor` · `wallet` ·
`community` · `crowdfunding` · `put` · `design-store` · `design-recommend` · `seller` ·
`buyer` · `mwstore-common` · `task` — each as `<name>-service`.

Reference data follows a `design-service/design/<noun>` shape: `/design/license`
and `/design/category` both sit there. The category tree arrives as an unnamed
root whose children are the eleven browse sections, each with the assignable
leaves beneath it, and carries about 25 KB of marketing prose that
`list_categories` discards.

### Server-rendered data

Some data is never a REST endpoint and only exists in `getServerSideProps`. Reach it
at `/_next/data/{buildId}/en{route}.json`; `buildId` changes every deploy and must be
read from `window.__NEXT_DATA__.buildId` at runtime. Used for creator analytics, the
model editor draft, and the profile editor's printer fleet.

**Requesting an editor route is a mutation.** Fetching `/my/models/{id}/edit` or
`/my/profiles/{id}/edit` — even as JSON, even server-side — forks a draft. Harmless
(drafts are inert and invisible) but it means no read-only tool may use those routes.

---

## Editing flow

```
GET  /_next/data/{buildId}/en/my/{models|profiles}/{id}/edit.json  → draft + payload
PUT  /api/v1/design-service/my/draft/{draftId}                     → whole payload
POST /api/v1/design-service/my/draft/{draftId}/submit              → {}
```

Draft status codes: **14** editing → **2** / **6** submitted → **3** approved. A
`Failed` state exists. The live model keeps serving throughout and never leaves
`status: 1`; design ID, slug and all statistics survive.

The PUT takes the entire document including expiring signed URLs for model files, so
it must be read immediately before writing. Edit-drafts never appear in `list_drafts`
— they are reachable only by ID.

**API edits are routed to manual review (`resultDesc: "need_risk_review"`); website
publishes clear automatically in ~2 minutes.** Both API submissions in testing were
flagged, both UI publishes were not. Any write tool should expect the slow path.

---

## Printer compatibility

Fully mapped — see the README for the user-facing version. In short:
published = `otherCompatibility` (derived from the 3MF, **not settable**) minus
`unsupportedDevModels` (author opt-outs, **authoritative and writable**). Narrowing
works, widening is impossible.

Ruled out, do not retry:

- Writing `otherCompatibility` — accepted into the draft, survives review, discarded
  on publish.
- Republishing to refresh — expands a stale list sometimes, but will not restore
  printers absent from the derived set.
- The website's own checkboxes — they render from `unsupportedDevModels` and submit
  `otherCompatibility`, so a printer can show ticked, publish, and still not be
  offered. This is a MakerWorld front-end bug.

The derived set is **recomputed each time a profile draft is opened** and grows as
printers are added, so read it immediately before writing rather than reusing a value
from earlier in a session.

### Device codes

Held in `src/printers.ts` and surfaced by `list_printers`. Authoritative source is
`pageProps.machines` on the profile editor, which pairs `devModelName` with
`devProductName`. There is no read-only endpoint for it — twelve candidates
probed, all 404, and it is not a client-side constant — so the pairing is
carried in the plugin. Consumers union it with whatever a profile already lists,
so a stale entry can only under-report, and `set_printer_compatibility`
validates against the live fleet it has to read anyway.

The `owned_printers` setting records the hardware in the room and nothing else.
It accepts either identifier in any case, so `a1 mini` and `N1` both resolve.

It was briefly wired as a publish target — `set_printer_compatibility` narrowed
to it when called with no list — which was **wrong**, and is worth recording so
nobody rebuilds it. The two questions are unrelated: a design is offered to
every printer whose plate it fits, and Brandon owns three of the fourteen while
almost every model of his is meant for all of them. Defaulting to the owned set
would have withdrawn ten printers from a model intended for everyone. Ownership
is now reporting-only (`cannot_test_on` — models you cannot test a print of
yourself), and the write path takes an explicit argument.

The real editing pattern is opt-out, not opt-in, which is why
`set_printer_compatibility` leads with `withdraw_printers`. The A1 mini's 180mm
plate is the usual reason a model is excluded from anything.

---

## Request pacing

A 429 at the end of the 2026-08-12 session prompted `src/request-gate.ts`, which
every API call now passes through. Requests are serialized and spaced 200 ms
apart; a 429 multiplies the spacing by four for the rest of the page's life and
it steps back down only after twelve clean responses. Rate-limited requests are
retried whatever their method, since a refusal means nothing executed; transient
failures are retried for reads only. A `Retry-After` above 30 s is reported
rather than waited out.

Reads are cached for a minute by full URL, which collapses the shared
creator-dashboard fetch that `diagnose_listing` and `analyze_earnings_velocity`
both open with. Two reads deliberately bypass the cache: anything through
`fetchPageData`, because editor payloads carry short-lived signed URLs and
fetching one forks a draft. Any write clears the cache.

The limit itself is still unmeasured — B4 remains the task that would replace
these numbers with evidence. They are deliberately conservative in the meantime.

Verified offline against stubs (pacing, serialization, cache hit and
invalidation, retry and no-retry paths, the attempt cap, queue survival after a
rejection). The plugin has no test runner, so the harness lived in the
scratchpad and was run against `dist/`; re-create it rather than looking for it
in the repo.

## Open work

### A — printer compatibility · closed

Mechanism mapped, `set_printer_compatibility` shipped with `withdraw_printers`,
`supported_printers` and `dry_run`. Design `1490785` is still missing X1 Carbon,
X1, X1E, P1S and P1P, which no tool can restore. Brandon decided on 2026-08-12
not to pursue it — no bug report, no re-slice. Do not reopen it unprompted.

### B — peer benchmarking · not started, read-only

1. Map `search-service/searchlist` — params, sort options, response shape.
2. Establish which metrics are public for other creators. Impressions and views are
   expected to be private, which would cap peer comparison at prints, downloads,
   likes, collects. **Confirm before designing** — it decides whether the tool can
   compare funnels or only outcomes.
3. Map category browse and sort params; check whether competitors'
   `instances[].extention.modelInfo` exposes their profiles.
4. Probe rate limits. A 429 was hit incidentally at the end of the 2026-08-12
   session, so the ceiling is lower than assumed. The request gate now paces
   and retries, but its numbers are guesses; this task is what would replace
   them with a measurement.
5. Build the tool.

### C — comment and rating replies · not started, needs UI captures

Comments and ratings are separate record types with separate reply paths
(`/commentreply` and `/rating/reply/reply/` seen in the bundle, neither confirmed).

1. Capture a reply to a comment — Milo's unanswered P2S question on `1490785` is
   overdue and now has a good answer, so the test produces real value.
2. Capture a reply to a rating — `iEPR3D`'s 4-star "a little bit flimsy" on the same
   model.
3. **Capture a deletion. Hard blocker** — no public-write tool ships without an undo.
4. Probe length limits and whether the 64-entry `forbiddenWords` list served on the
   edit page is enforced server-side.
5. Build one tool covering both paths, dispatching on the `kind` that
   `list_model_feedback` already returns. Permission `ask` — replies are public and
   attributed.

### D — before/after measurement · not started

Smaller than first assumed: MakerWorld retains **per-day history**, so a comparison
can be reconstructed retroactively and nothing needs snapshotting.

1. Confirm day-granularity analytics are gap-free.
2. Confirm `updated_at` moves only on real edits, not on comments or ratings.
3. Build a comparison tool defaulting to the model's `updated_at` as the split point.
   Tag changes move impressions over weeks, so it should refuse or caveat windows
   shorter than ~14 days rather than reporting noise.

---

## Live experiments

Two natural experiments started **2026-08-12**. Re-measure **2026-08-26** (+14d) and
**2026-09-09** (+28d).

| Model | Change | Direction |
| --- | --- | --- |
| `1513324` GPU adapter | +4 tags (`sff`, `itx`, `graphics card`, `fractal design`); printers 7 → 12 | improvement |
| `1490785` XG mount | printers churned, ended at 8; tags unchanged | neutral to negative |

`1513324` also has draft `9198222` pending review which keeps it at 12 by withdrawing
A1 and A1 mini — stale input on a `set_printer_compatibility` call. Re-running with
the full derived 13 would take it to 14. Marginal, on a throwaway model.

---

## Known limitations

- **Printer compatibility cannot be widened** by any tool.
- **Uploading from disk** is capped by base64 through the tool call, because
  MakerWorld's CSP blocks loopback fetches. See the README, and the platform-level
  extension fetch relay that would fix it.
- **`update_model` only touches title, description and tags** — deliberately. Cover
  image, files, print profiles, license and category are where a bad write does real
  damage.
- **Two tools remain untested by design:** `redeem_product` (spends points
  irreversibly) and `publish_draft` (publishes to a public profile).
- **`list_drafts` cannot see edit-drafts** of published models.

## Practices worth keeping

- Read `get_print_profiles` immediately before `set_printer_compatibility`; the
  derived set moves.
- Prefer the ledger (`list_transactions`) over the analytics endpoints for per-model
  earnings — it reconciles exactly to `totalIncome`, and the two disagree by ~1.4%
  because the daily series drops edge days.
- Sum `regular_points + exclusive_points` rather than reading `points`, which is
  rounded for display.
