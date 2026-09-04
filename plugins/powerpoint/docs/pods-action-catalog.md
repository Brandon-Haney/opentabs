# Pods live-edit action catalog

Every action below was captured from a live editing session (HAR, 2026-08-15, 361 `/pods/PowerPoint.ashx`
requests) and **works with the deck OPEN in the browser** — the co-authoring channel, not Graph. Each is a
type-3 revision carrying a `131140` action descriptor (`ActionName` in prop `469780989`) plus the objects it
changes. Exemplar bodies saved under `scratchpad/actions/`.

Build status: ✅ shipped live · ◑ wire decoded, easy to build (reuses the `format_text` pattern) · ○ decoded,
harder build (rewrites the object graph) · · captured, not yet analysed.

## The object graph (decoded 2026-09-03 from a zero-base model read)

`393227` slide —`603986976`→ `1074135132` shapes —`603986976`→ `393229` text body
—`603986975`→ `393230` paragraphs —`603987475`→ `1179725` runs; `536886591` on the
paragraph is the end-mark run. `603986975` is a generic *ordered children* property
(the root uses it for its slide list) and `603986976` a generic *content refs*
property. `603995142` on a shape is **not** its paragraph list (present on only
17 of 33 shapes; a mapping built on it resolved nothing). Runs in the loaded model
carry **no text** — the text is on the paragraph. Run boundaries are a
paragraph-level offset list in `469769746`, **confirmed 2026-09-03** by a live
range-bold capture; see "How a paragraph holds more than one format" below.

## Slides (structural)
| Action | Bytes | Build | Notes |
| --- | --- | --- | --- |
| `NewSlideWithLayout` | 2,577 | ○ | Rewrites the presentation root (`393271`) slide-list props `603998444`+`603986975`, adds a new `393227` slide object referencing an existing layout (`536889506` → layout id, `335562835/836` → master/layout ids). Server materializes the rest. |
| `NewSlideWithoutDialog` | 35,582 | ○ | New slide with placeholders inlined (`131073`×21). |
| `DuplicateSlide` | 471,791 | ○ | Inlines the whole source slide object graph. Big. |
| `DeleteSlide` | 2,285 | ✅ (`delete_slide_live`) | Rewrites the presentation root minus the removed slide ref. Live-verified. |
| `MoveSlideById` | ~9,000 | ✅ (`move_slide_live`) | **Slide reorder.** Same mechanism as add/delete: resubmit the root `393271` with the ordered slide list `603986975` REORDERED. NO `134236525` modified flag (like add, unlike delete). Live-verified 2026-08-17: reordering ONLY `603986975` suffices — the parallel ref lists (`603998444` children, `603995377`/`603998458` single refs) are copied verbatim and the server reconciles them. Exemplar: `scratchpad/actions/MoveSlideById_editor_capture.md`. |
| `ChangeLayout` | ~9,877 | ○ | Reassigns a slide's layout. |

## Slide-level formatting (slide `393227`)
| Action | Build | Wire |
| --- | --- | --- |
| `FormatBackgroundSolidFill` | ✅ (`set_slide_background`) | **Slide background color.** Resubmit the target SLIDE object (`393227`) with `469780561` = `"#RRGGBB,,,"` + `469780621` structured json (`{RGBColor, Alpha:100, ThemeColor:-1}`) + `469780560` = `""` + `469780963` fill-mode, in the SLIDE's own cell. The big `469780520` theme/color-scheme blob is copied verbatim (don't synthesize). Live-verified 2026-08-17. Exemplar: `scratchpad/actions/FormatBackgroundSolidFill_editor_capture.md`. |

## Character formatting (run `1179725` — extends `format_text`)
| Action | Build | Wire |
| --- | --- | --- |
| `SetFontSize` | ✅ | run `268442635` (half-pt) |
| `Bold` | ✅ | run `134224900` — CONFIRMED against the editor's own bold capture (2026-08-16): the editor writes run `134224900:"true"` (and mirrors it on the shape), matching `format_text` exactly. |
| `SetItalic` | ✅ | run `134224901` |
| `Underline` | ◑ | run `134224902` |
| `Font` (family) | ◑ | run `469769226` + `469780527/528/529` (typeface) |
| `SetFontColor` | ◑ | run `469780760` = `"@RRGGBB,,"` + `335551500` (BGR int) |
| `SetFontBackgroundColor` (highlight) | ◑ | run color props (background variant) |
| `Strikethrough` / `Superscript` / `Subscript` | ◑ | run `134224903` / `134224904` / `134224905` respectively — named by the client's own property registry, which shifts the earlier guess by one. |
| `GrowFontSize` / `ShrinkFontSize` | ◑ | run `268442635` step |
| range format (select part of a paragraph, then Bold/…) | ○ DECODED 2026-09-03 | See "How a paragraph holds more than one format" below. |
| hyperlink (Ctrl+K) | ○ DECODED 2026-09-03 | A field code spliced into the paragraph text; see below. |

## Paragraph formatting (paragraph `393230`)
| Action | Build | Wire |
| --- | --- | --- |
| `CenterTextJustify` / `RightTextJustify` / `LeftTextJustify` | ✅ (`align_text`) | paragraph `335551550` + `335551620` (1=left, 2=center, 3=right, 4=justify), both set to the code. Paragraph-only — no new run, run-ref unchanged; smallest write (~1.5 KB). Live-verified 2026-08-17 with a center→right→center round trip (the revert's before-state read back the intermediate value, proving application). |
| `PandoraLineSpacing` | ◑ | paragraph line-spacing props (~1.4 KB). **Line spacing IS live-writable** — earlier "not supported" was the Graph limitation, not pods. |
| `ToggleBulletsList` | ◑ | paragraph + `393229`/`393234` list objects |
| `ToggleNumberedList` | ◑ | paragraph + numbering objects |
| `DemoteIndent` / `PromoteIndent` | ◑ | paragraph outline level |
| `NewLine` | ● BUILT 2026-09-03 | `add_paragraph`. Splits a paragraph; two chained revisions, and it appends a new text-body block to the shape. A third chained revision types the text in. See below. |

## Text content
| Action | Build | Wire |
| --- | --- | --- |
| `Typing` | ✅ (`set_text`) | Far simpler than feared: an action descriptor (3-prop form, no ActionId json) plus the paragraph `393230` resubmitted with its FULL property list, text `469769250` carrying the paragraph's entire new text, properties sorted ascending. NO run object is written — the run-refs (`603987475`, end-mark `536886591`) keep pointing at the existing runs, which keep supplying the formatting. The flag props (`134236461/462/479`) and `469780757` `{"Lines":[…]}` are ordinary paragraph properties present in the read model, copied verbatim. Proven live 2026-08-16 (set + revert, both `applied:true`, survived a session reload). Single-run paragraphs only; multi-run needs per-range bookkeeping the capture does not exercise. Sequence 37. |
| `BackspaceCharacter` | superseded | inverse of typing — subsumed by the `Typing`/`set_text` whole-text replacement |
| `Backspace` (multi-run select-all delete) | ○ exemplar captured 2026-08-16 | The editor's own multi-run text deletion, captured live via the last-write sentinel: ONE POST carrying TWO CHAINED revisions (revision 2's `BaseId` = revision 1's `Id` — intra-POST chaining, previously unseen). Rev 1: action descriptor `Backspace` (WITH the `469780658` ActionId json) + the paragraph with text `""` and its run-ref/end-mark COLLAPSED to a single run. Rev 2 (based on rev 1): the SHAPE `1074135132` resubmitted with its full updated state (timestamp, paragraph-ref list `603995142`, text-body ref) + the paragraph again with `Lines:[1]`. The shape-level resubmit is the piece our constructed run-collapse lacked — and its absence is what crashed the editor client. Also decoded the crash's sibling symptom: our `set_text` leaves the referenced run's own text (`469769250` on the run) stale, and the editor reconciles the paragraph/run divergence by splitting in a second run — and fights manual deletions until a reload. Fixes to build: sync the run's text in the same revision (prevents divergence), and use this exemplar's chained-revision + shape-resubmit shape for multi-run edits. Sequence 6. |
| placeholder materialization (type into an EMPTY placeholder) | ○ needs ring-buffer capture | Captured live 2026-08-16 via the last-write sentinel: the FINAL revision of the burst writes the shape `1074135132` DIRECTLY (~70 props: corner-point geometry `469780576`, transform matrix `469780756`, EMU anchor rect `469780886`, timestamp `335551866`, author-stamp json `469780706`, creation guid `469780944`, paragraph-ref list `603995142`, text-body ref `603986976`) plus the paragraph `393230` with the typed text — whose run-ref points at runs created by EARLIER revisions of the same burst, which the single-slot sentinel does not retain. So `1074135132` IS writable (correcting the earlier render-only classification), and materialization is a multi-revision burst needing the ring-buffer capture channel to decode fully. Until then: an empty placeholder's prompt paragraphs refuse/no-op our writes; once ANY keystroke materializes the placeholder, `set_text` on its real text is proven live. |

## Shapes / text boxes (shape `1074135132`)
| Action | Build | Wire |
| --- | --- | --- |
| `InsertShapeAtSpecifiedLocation` | ○ | new `1074135132` shape + `393227` at x/y/w/h |
| `MoveShapes` | ◑ | shape geometry (`a:xfrm` equivalent props) |
| `ApplyShapeFillColor` | ◑ | shape fill color |
| `ApplyShapeOutlineColor` | ◑ | shape line color |
| `ApplyShapeStyle` | ◑ | shape style ref |
| `PowerPointTextAnchoringTop/Middle/Bottom` | ◑ | shape vertical text anchor |

## Tables (`393250`/`393251`/`393252`)
| Action | Build | Wire |
| --- | --- | --- |
| `PowerPointInsertTable` | ○ | new table graphic-frame |
| `ApplyTableStyle` | ◑ | table style GUID |
| `ApplyTableStyleOption` | ◑ | header/band toggles |
| `PowerPointCellShadingColor` | ◑ | cell `393252` fill |

## How a paragraph holds more than one format (decoded 2026-09-03)

This is the mechanism behind "select some text, then click Bold", and it is not what
a run-per-span model would predict.

- The paragraph's text (`469769250`) is **one string for the whole paragraph**. Runs
  carry formatting only; they hold no text of their own.
- **`469769746` is the run-boundary list**: comma-separated character offsets into that
  string where the formatting changes. N runs means N-1 offsets, and the property is
  **absent entirely on a single-run paragraph**.
- **`603987475` lists one run reference per segment, in order.** The same run object may
  appear more than once — runs are shared formatting descriptors, not text spans.
- `536886591` is the end-mark run: the formatting a caret at the end of the paragraph
  inherits.

Captured from a real range-bold. The title reads `" Fusion Pilot Timeline: Key Milestones"`
and the word `Timeline` occupies characters 14 to 21, so the editor wrote:

```jsonc
469769746: "14,22"                      // three segments: [0,14) [14,22) [22,end)
603987475: "{orig}{58},{new}{23},{orig}{58}"   // head and tail share ONE run object
```

The two-run paragraph in the same deck (`"04/29 - PILOT GO -- NO GO"`) carries
`469769746: "8"`, which is the same rule with one boundary.

| Action | Build | Wire |
| --- | --- | --- |
| **range format** (select part of a paragraph, then Bold/size/colour/…) | ○ decoded, ready to build | ONE revision, three objects: the action descriptor; the paragraph resubmitted with a new `469769746` and a rewritten `603987475`; and **one new `1179725` run** that is a verbatim copy of the covering run's property list with only the requested properties overridden. The head and tail segments keep pointing at the original run object, so nothing else is touched. Exemplar: `Bold`, `Sequence 5`, 2,650 bytes. |
| **`NewLine`** (Enter — paragraph split) | ● built as `add_paragraph` | ONE POST carrying **two chained revisions** (`rev2.BaseId = rev1.Id`). Rev 1: action descriptor (`469780989:"NewLine"`, while the `469780658` json calls it `"Enter"`); the **shape `1074135132` resubmitted with a second text-body reference appended to `603986976`**; the source paragraph; a **new text body `393229`** whose `603986975` names the new paragraph; and the new paragraph `393230` with `469769250:""`, its run-ref and `536886591` pointing at the source paragraph's run. Rev 2: the new paragraph again with `469780757:{"Lines":[1]}`. So a split appends a text-body BLOCK to the shape — a shape's `603986976` is a list of blocks, not a single one. Exemplar: 6,926 bytes. |
| **hyperlink** (Ctrl+K) | ○ decoded, ready to build | See below — it is a field code, and it carries **no action name at all**. |

### What one capture of `NewLine` could not tell us

The captured split was an Enter at the end of a title, and that title carried no
`536886591` (`endOfParagraphFormatting`) of its own. The new paragraph got the
source's RUN reference in both `536886591` and `603987475`, which is consistent
with two different rules — inherit the source's end-mark, or reuse the source's
run — because in that one paragraph they were the same value.

Live paragraphs frequently carry an end-mark that is a DIFFERENT run from the body
text's: the first real target tried had `536886591` pointing at run `{60}` while
`603987475` pointed at `{143}`. The builder therefore inherits an end-mark as an
end-mark, falling back to the run reference only when the source has none — which
reproduces the capture exactly. Getting this wrong is cosmetic, not destructive:
the new line inherits the wrong formatting rather than corrupting anything.

The general lesson is worth more than the property: a capture whose two candidate
rules coincide has not decided between them, and the deciding case shows up on the
first document that is not the one you captured.

### A hyperlink is a Word field code inside the paragraph text

Nothing about hyperlinks was known before this capture, and the answer is that
PowerPoint on the web does not model them as a run property or a relationship. It
splices a **Word-style field code straight into the paragraph's text**, exactly as
`HYPERLINK "<url>"` appears in a `.docx` field:

```
" Fusion Pilot Timeline: Key \uFDDFHYPERLINK \"https://example.com/sop\"Milestones"
                              ^ U+FDDF begins the field code   ^ display text follows
```

The field code is then hidden by run flags rather than by a separate structure. With
the URL above the editor wrote `469769746: "28,64"`, giving three segments:

| Segment | Characters | Run | Properties |
| --- | --- | --- | --- |
| leading text | `[0,28)` | the original run, resubmitted with a fresh `335551866` timestamp | unchanged formatting |
| the field code | `[28,64)` | a new `1179725` | **only** `134225428:"true"`, `134225430:"true"`, `134225433:"true"` — no formatting at all, because it is never drawn |
| the link text | `[64,end)` | a new `1179725` | a full copy of the covering run's formatting **plus** `134225428:"true"`, `134225433:"true"`, `134236593:"true"` |

New property ids, named from their distribution across the two runs:

| Property id | Meaning |
| --- | --- |
| `134225428` | the run is part of a field (set on both the code and the display text) |
| `134225430` | the run **is** the field code, so it is hidden (set only on the code run) |
| `134225433` | the run is field content (set on both) |
| `134236593` | the run is a hyperlink's display text (set only on the display run) |

Insert Link is **two writes**, ~1.5 s apart, and neither carries a `469780989` action
name — the manifest shows them as unnamed. The first write is the one above. The
second resubmits the whole shape `1074135132` plus the paragraph again, now with
`536886591` restored and the run references pointing at the ids the **server**
assigned to the runs the first write created. That second write is the same
shape-resubmit shape the `Backspace` capture needed, and its absence is what
previously left the editor client fighting our edits.

Undecoded: `469769819`, which appeared once as `"100"` on the hyperlink write and is
absent from every other capture. Do not write it.

## The client's own catalogs — names and property ids without a capture

PowerPoint for the web hands over its whole vocabulary to anyone who asks. A plain
unauthenticated `GET https://usc-powerpoint.officeapps.live.com/pods/ppt.aspx`
returns the real editor app shell (no WOPI POST, no browser, no auth), and the
bundle URLs it names are public CDN assets that `curl` fetches directly. Two
extractions come out of them, both validated against everything this repo had
already decoded by hand:

- **Action names.** `ppteditDS.core1/core2.js` carry reverse-lookup switch tables
  registered as `Commands` and `CommonCommands`. Merged: **2,892 action names** with
  their 32-bit ids, in one global id space. All 38 names ever seen on our wire are
  present, which is what proves it is the right table. The ids are not a hash of the
  name — seven standard 32-bit hashes were ruled out — so they can only be read from
  the table.
- **Property ids.** `ppteditDS.core1.js` states the composition rule verbatim:
  `propertyId = index | (group << 10) | (typeCode << 26)`. Expanding the nine
  registries yields **2,195 property ids** with their wire types, of which 179 carry
  a human-readable name. Every one of the 57 ids this repo had decoded by capture
  resolves, with matching types.

The catalogs, the extraction script and the full method are kept at
`~/.opentabs/wire-catalogs/` (they are Microsoft's identifiers, so they live beside
the repo rather than in it, and the `h<16-hex>` CDN path segment rotates per build,
so re-scrape rather than trusting a cached URL).

**What this does not settle.** The self-label is telemetry, not dispatch: the client
writes `469780989` only behind the feature flag `PPTEmitUndoActionNameForEditIntent`,
taking the name from the undo stack's top command. So knowing 2,892 names does not
buy 2,892 capabilities — it tells you what an action is called and what its
properties mean, while **which objects a revision must carry is still only knowable
from a capture**. It also explains why our builders' cosmetic `ActionName` has never
mattered to the server.

Two things the registry corrected on sight: the run flags `134224903/904/905` are
strikethrough / superscript / subscript rather than the trio the catalog first
guessed, and `align_text`'s justify case was emitting `JustifyTextJustify`, a name
that exists nowhere in the client — the real one is `FullTextJustify`.

It also independently confirms the run-segmentation decode above: `469769746` is a
string property sitting immediately beside the run-reference list (`603987475`) in
the same registry group, `134225430` is literally named **`isHidden`** — the hidden
field-code run — and `536886591` is literally **`endOfParagraphFormatting`**.

### Removing a link, and the wire rule it taught us

`RemoveHyperlink`, captured 2026-09-03. Two writes again. The first restores the
paragraph: the text without the field code, one boundary where the link began, and
two run references — the untouched head run, and a new run for the words that were
linked. The second, about a second later, resubmits the shape and re-points both
references at the original run.

The new run is where the lesson is. It does **not** drop the field flags. It writes
them `false`:

| Property | Adding a link | Removing it |
| --- | --- | --- |
| `134225428` in-field | `"true"` | `"false"` |
| `134225433` field content | `"true"` | `"false"` |
| `134236593` | `"true"` | **left `"true"`** |

**A property a revision omits keeps the value it already had.** The write is merged
onto the document, so omission means "unchanged", not "off". A constructed removal
that deleted those keys instead of clearing them left the run half a field; the
editor then repaired the paragraph by rebuilding the link with a target guessed from
the visible words, turning a link to a real URL into one pointing at the word itself.
It survived a reload, so it reached the document. Any builder that turns a flag off
must write `false`.

`134236593` staying `true` after removal also rules out the earlier reading of it as
"this run displays a link" — whatever it marks outlives the field.

## Capture channel

`__otb_pods_lastwrite__` and `__otb_pods_writelog__` (12-entry ring buffer, newest
first) answer with `{url, method, body, ts}` only — the session headers stay in the
frame-local donor. Read them with `browser_fetch_in_frame` (`donorGlobal:
"__otbPptPodsDonor"` selects the right frame; the URL override hits the sentinel).
The response is capped at 200 K characters, so read after every gesture.

## Protocol reliability (decoded live 2026-08-17)

**`Sequence` is a retransmit key, not telemetry.** The service dedupes writes on `(session, Sequence)`:
a POST repeating an earlier write's Sequence is answered `StatusCode 0` from the earlier acknowledgement
and silently dropped — byte-identical symptom to a stale-head drop. This was THE "second write fails"
root cause: every builder carried its capture's constant Sequence, so within one editor session the first
write applied and every later one was treated as a retransmit. (It also explains user keystrokes vanishing
after our writes — the editor's own counter reaching a number we had burned.) The engine now mints a
unique per-write Sequence (floor 100,000 — far above the editor's own counter, so the two ranges can never
collide), fresh per conflict retry. Verified live: seven consecutive structural+format writes, zero drops,
zero reloads. Builders keep their captured constants for exemplar fidelity; the engine overrides them.

**The revision stream compacts mid-session.** After enough revisions the service checkpoints the document
and discards history; from then on the type-2 zero-base model read is refused with `StatusCode 124` /
`ServerError 157` and an EMPTY `RevisionList` (same 157 code as a stale write base — distinguish by the
empty list on a read). Nothing in the old session can serve full-state reads again. Incremental polls
still work, which is why the editor itself is unaffected. Recovery (automated in the action engine):
reload the deck tab, wait for the fresh co-authoring session, re-read — a fresh session's load
establishes a new readable base. Safe mid-co-authoring: every accepted revision is already persisted
(the checkpoint IS a save).

## The recurring pattern
Almost every "modify existing text/shape" action is the proven `SetFontSize` shape: resolve the target
(paragraph/run/shape) from the live model, resubmit a copy with the relevant properties changed (and, for run
changes, a new run + rewritten run-ref). So the whole character + paragraph + shape-format tier is a
mechanical extension of the shipped `format_text` engine. The structural tier (new slide, insert shape/table,
typing) rewrites the object graph and needs per-action construction + adversarial verification before it
touches a real deck.
