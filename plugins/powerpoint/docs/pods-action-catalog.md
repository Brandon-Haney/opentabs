# Pods live-edit action catalog

Every action below was captured from a live editing session (HAR, 2026-08-15, 361 `/pods/PowerPoint.ashx`
requests) and **works with the deck OPEN in the browser** — the co-authoring channel, not Graph. Each is a
type-3 revision carrying a `131140` action descriptor (`ActionName` in prop `469780989`) plus the objects it
changes. Exemplar bodies saved under `scratchpad/actions/`.

Build status: ✅ shipped live · ◑ wire decoded, easy to build (reuses the `format_text` pattern) · ○ decoded,
harder build (rewrites the object graph) · · captured, not yet analysed.

## Slides (structural)
| Action | Bytes | Build | Notes |
| --- | --- | --- | --- |
| `NewSlideWithLayout` | 2,577 | ○ | Rewrites the presentation root (`393271`) slide-list props `603998444`+`603986975`, adds a new `393227` slide object referencing an existing layout (`536889506` → layout id, `335562835/836` → master/layout ids). Server materializes the rest. |
| `NewSlideWithoutDialog` | 35,582 | ○ | New slide with placeholders inlined (`131073`×21). |
| `DuplicateSlide` | 471,791 | ○ | Inlines the whole source slide object graph. Big. |
| `DeleteSlide` | 2,285 | ✅ (`delete_slide_live`) | Rewrites the presentation root minus the removed slide ref. Live-verified. |
| `MoveSlideById` | ~9,000 | ◑ BUILD NEXT | **Slide reorder — captured live 2026-08-16.** Same mechanism as add/delete: resubmit the root `393271` with the ordered slide list `603986975` REORDERED. NO `134236525` modified flag (like add, unlike delete). The root carries several parallel ref lists (`603986975` order, `603998444` children, `603995377`/`603998458` single refs) — verify at build whether reordering only `603986975` suffices or the parallels must move too. Buildable on the existing structural engine, no new decode. Single revision, Sequence 28. Exemplar: `scratchpad/actions/MoveSlideById_editor_capture.md`. |
| `ChangeLayout` | ~9,877 | ○ | Reassigns a slide's layout. |

## Slide-level formatting (slide `393227`)
| Action | Build | Wire |
| --- | --- | --- |
| `FormatBackgroundSolidFill` | ◑ | **Slide background color — captured live 2026-08-16.** Resubmit the target SLIDE object (`393227`) with `469780561` = `"#RRGGBB,,,"` + `469780621` structured json (`{RGBColor, Alpha:100, ThemeColor:-1}`) + `469780963` fill-mode. The big `469780520` theme/color-scheme blob is copied verbatim (don't synthesize). Single revision, Sequence 47. Exemplar: `scratchpad/actions/FormatBackgroundSolidFill_editor_capture.md`. |

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
| `Superscript` / `Subscript` | ◑ | run `134224903/904/905` + baseline |
| `GrowFontSize` / `ShrinkFontSize` | ◑ | run `268442635` step |

## Paragraph formatting (paragraph `393230`)
| Action | Build | Wire |
| --- | --- | --- |
| `CenterTextJustify` / `RightTextJustify` / `LeftTextJustify` | ◑ | paragraph `335551550` + `335551620` (1=left, 2=center, 3=right, 4=justify). Paragraph-only — no new run, run-ref unchanged. Smallest write (~1.5 KB). |
| `PandoraLineSpacing` | ◑ | paragraph line-spacing props (~1.4 KB). **Line spacing IS live-writable** — earlier "not supported" was the Graph limitation, not pods. |
| `ToggleBulletsList` | ◑ | paragraph + `393229`/`393234` list objects |
| `ToggleNumberedList` | ◑ | paragraph + numbering objects |
| `DemoteIndent` / `PromoteIndent` | ◑ | paragraph outline level |
| `NewLine` | ○ | splits a paragraph (creates new `393230`) |

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

## The recurring pattern
Almost every "modify existing text/shape" action is the proven `SetFontSize` shape: resolve the target
(paragraph/run/shape) from the live model, resubmit a copy with the relevant properties changed (and, for run
changes, a new run + rewritten run-ref). So the whole character + paragraph + shape-format tier is a
mechanical extension of the shipped `format_text` engine. The structural tier (new slide, insert shape/table,
typing) rewrites the object graph and needs per-action construction + adversarial verification before it
touches a real deck.
