# Slide editing: structure, transports, and plan

Working document for making the PowerPoint plugin edit a deck the way a person
does — by naming the title, not by clicking where the title happens to sit.

## Scope

**In scope:** the PowerPoint plugin and its own test decks.

**Out of scope:** any deck belonging to someone else. In particular, *ELT
Readout 1.pptx* in Chris's OneDrive (`450510_genpt_net`) is not to be read from,
written to, or used as a test target. The `drive_id` work makes foreign drives
*addressable*; that is a capability, not a licence to use one.

## Two layers

The semantic API and the transport are independent. The same
`set_placeholder_text('title', …)` can be served by either transport, so the API
ships on the working one and can switch underneath without changing signatures.

| Layer | Status |
| --- | --- |
| Semantic API (slots by role) | built — `get_slide_structure`, `set_placeholder_text`, `add_slide` |
| Transport A: OOXML + Graph `/content` | works; full-file PUT, guarded by `If-Match` |
| Transport B: `/pods/PowerPoint.ashx` incremental | proven readable, write unproven, **not pursued** |

### Transport A — Graph

Download the package, mutate ZIP entries, PUT the whole file back. Coarse but
now **safe**: every write goes through `editPresentation`, which sends the eTag
the read observed as an `If-Match` precondition and re-applies the edit to a
freshly read package if the save is refused.

**Verified live (2026-08-13):** opened a session against a throwaway copy,
dirtied it, bumped the file's eTag underneath it, and committed. Graph returned
412 and the commit was refused with the pending edits preserved. The precondition
is enforced by the server, not merely accepted.

Because the guard is real, a full-file PUT no longer means "last writer wins" —
it means "the writer who read the current version wins, and everyone else is
told". That closes the priority-1 concern without needing Transport B.

### Transport B — pods

See [[project_powerpoint_pods_edit_protocol]] in agent memory for the captured
wire format. Published as [MS-FSSHTTPB] / [MS-FSSHTTPD] / [MS-FSSHTTP], with a
reference implementation at <https://github.com/OfficeDev/Interop-TestSuites>.

**Active — and necessary.** `If-Match` solved a different problem. The WOPI lock
refuses *any* Graph `/content` write while the deck is open, including by its own
author, so a plugin restricted to Transport A cannot do what a person does: edit a
file they have open. Only the co-authoring channel can.

**No custom bridge needed.** `browser_fetch_in_frame` already issues an
arbitrary request from inside a named cross-origin child frame, same-origin to it
— which is the entire transport requirement. The in-plugin recorder that made the
original capture possible has been removed and stays removed: it relayed live WOPI
credentials to the host frame and exposed a replay function as a MAIN-world global
any page script could call.

**Proof gate.** Land one `NewSlideWithoutDialog` on an open deck before building
anything else. Additive rather than destructive (a stray slide is recoverable; a
half-applied delete is not), and at ~2.2 KB the smallest write observed —
`DuplicateSlide` is 33.9 KB because it inlines the object graph.

Open question blocking it: a verbatim replay returned HTTP 200 / `StatusCode: 0` /
`IsConflict: false` and changed nothing. Working hypothesis is that re-asserting
existing object identities is a legitimate no-op, and new content needs freshly
minted ones. Unproven — and it decides whether this is a week or a month.

## Placeholder model

Verified against the python-pptx sources, and now implemented in
`src/placeholders.ts`:

- A slide is a set of typed slots, not a canvas.
- **`idx` is the identity, not `type`.** A two-content layout has two `body`
  placeholders distinguished only by `idx`. `findSlot` refuses to guess between
  them and names the indexes instead.
- **Inheritance is slide → layout → master.** A slide placeholder with no
  `<a:xfrm>` takes geometry from the layout placeholder with the same `idx`;
  that one often states none either, so the master is merged in underneath
  (`resolveInheritedGeometry`).
- **`add_slide` is placeholder cloning.** Only `type`, `orient`, `sz`, `idx`
  cross over — never position, size, or text.
- A layout slot the slide never filled is still a slot. `set_placeholder_text`
  creates the shape rather than refusing, which is what PowerPoint does when you
  click "Click to add title".

## Space awareness

`src/text-metrics.ts` models a line as `characters × average advance width`,
with a per-font ratio table. `fitFontSize` picks the largest whole-point size
that fits and reports `fits: false` rather than overflowing silently.

**Design rule: a tool that writes text into a bounded box must never silently
overflow.** Either it fits the text, or it says it could not.

`set_placeholder_text` only ever *shrinks*: it resolves the inherited size
through the layout→master→presentation cascade (`resolveSlotFontSize`) and uses
that as the ceiling, writing an explicit `sz` only when a reduction is needed.
Restating the inherited size would pin the slot against later theme changes.

## Open decisions

### 1. Should shrink-to-fit write `sz` or `normAutofit fontScale`?

Researched, not yet decided. The case for switching:

- An explicit `sz` on every run is **permanent**: it overrides the
  layout/master cascade forever, never grows back when the text is shortened,
  and survives a theme change. On someone else's deck that is damage.
- A stale `fontScale` is **self-healing**: the next human keystroke in the box
  makes PowerPoint recompute the right value, and deleting one attribute
  restores the design.
- Stock Office masters carry `<a:normAutofit/>` on the body placeholder, so an
  explicit `sz` can get shrunk *again* on top at the next edit — a visible
  double-shrink.

Facts established: `fontScale`/`lnSpcReduction` are integer thousandths of a
percent (`fontScale` range 1000–100000, default 100000; write bare integers, no
`%`). Writing a bare `<a:normAutofit/>` with no factor is **strictly worse than
today** — it renders at 100% and only corrects when a human edits the box.
Neither python-pptx nor Apache POI computes a factor; python-pptx's `fit_text()`
measures glyphs and writes explicit `sz`, exactly as we do. `<a:spAutoFit/>`
resizes the shape to the text rather than the reverse, and has the same
staleness problem relocated into `<a:ext cy>`.

Blocking question: **all the recompute-on-edit-not-on-load evidence is from
desktop PowerPoint.** The web editor runs autofit live while typing and may
behave differently — and the web editor is our target. Cheap test before
switching: write a deliberately wrong `fontScale`, open the deck in the web
editor without touching the box, and see whether the rendered size honours it.

Also note `<a:bodyPr>` child order is schema-fixed (`prstTxWarp?`, then the
autofit choice, then `scene3d?`, …) and any existing `noAutofit`/`spAutoFit`
must be replaced rather than appended.

### 2. Test coverage stops at the DOM boundary

`vitest` runs in bare Node with no DOM, by choice: jsdom's `XMLSerializer` does
not match Chrome's for namespace prefixes and self-closing tags, so asserting on
serialized XML would pin jsdom's behaviour rather than the bytes we ship.

Consequence: `text-metrics.ts` is covered; `slide-edit.ts`, `placeholders.ts`,
and `slide-layout.ts` are not, because they all parse XML. Options are to assert
on parsed structure rather than serialized strings under jsdom, or to leave the
DOM surface to live verification. Unresolved.

`editPresentation`'s 412-retry path is likewise unpinned by a test — the
behaviour is proven live but not guarded against regression. It needs a mocked
`fetch`, which is achievable in bare Node.

## Hard-won gotchas

- **`StatusCode: 0` means accepted, not applied.** Verify resulting state
  independently; never treat a response as proof of effect.
- **Graph enforces `If-Match` on `/content` PUT** — confirmed by experiment, not
  just by documentation. A rename bumps the eTag, which is a cheap way to force
  the conflict path.
- The WOPI lock outlives the editor tab by **several minutes** (measured ~4), not
  the 30–60 seconds the old error message claimed. No request shortens it.
- Navigating to the Graph `webUrl` (`/_layouts/15/Doc.aspx?…`) does **not** match
  `*://*.sharepoint.com/:p:/*`, so the pre-script never injects. Always navigate
  the `/:p:/r/` form.
- The Graph token is minted only on a cold page load; `reauthenticate` is a
  routine step, not an edge case.
- `writeZip` must snapshot its entries map first. Deflating yields to the event
  loop, so a concurrent tool call can otherwise mix pre- and post-edit parts into
  one archive.
- `CT_TextCharacterProperties` orders `a:ln` **before** the fill; `CT_ShapeProperties`
  orders the fill **before** `a:ln`. Applying the shape intuition to a run
  produces a part PowerPoint offers to repair.
- `npm` on Windows is a `.cmd` shim and Node refuses to `spawn` one directly.
  This broke `npm run dev` and `npm run check:plugins`; both now pass a shell.
