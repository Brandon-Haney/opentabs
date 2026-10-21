# Word's live document model

How a document is shaped inside the co-authoring channel, decoded from a real
document containing a title, headings, body text, a bulleted list, a numbered
list, a 3×5 table and a paragraph with bold and italic runs.

Read the model with the pre-script's sentinels (see `../src/pre-script.ts`), and
target the frame as `frameUrlIncludes: "wordeditorframe"` — the page has sibling
`officeapps` frames that carry no sentinel:

```
https://usc-word.officeapps.live.com/__otb_word_model__?digest=1
```

The digest reduces every object to `{classId, objectId, props}` with long values
truncated, which turns a 55 KB model into something readable without losing any
structure.

## Block structure

| Class | What it is | Key property |
| --- | --- | --- |
| `1073872968` | Section | `603986976` → its body containers; `335559753`/`335559754` page size in twips; `335559747`–`335559750` margins |
| `393241` | Body container | `603986976` → ordered list of block wrappers |
| `393229` | Block wrapper | `603986975` → the one block it holds (a paragraph *or* a table) |
| `393230` | Paragraph | `469769250` → its text |
| `393250` | Table | `603986976` → rows; `335551831`/`335551832` row and column counts; `469769574` column widths; `536886401` → table style |
| `393251` | Table row | `603986976` → cells; `335559995` row height |
| `393252` | Table cell | `603986976` → a `393229` wrapper, so a cell holds blocks like the body does |

A section holds **several** body containers, not one: a table splits the flow, so
this document's section lists three — the blocks before the table, the table, and
the blocks after it. Code that walks the document must iterate the section's list
rather than assuming a single container.

## Paragraph style

A paragraph names its style through **`536884268`**, pointing at a style-definition
object (`1073872969`). Applying "Heading 1" means setting that property, not
changing font or size.

Style definitions carry `469775450` (display name, e.g. `heading 1`), `469778129`
(style id, e.g. `Heading1`), `469778324` (based-on) and `201340122` (type: 1
character, 2 paragraph, 3 table), alongside the formatting they imply —
`268442635` is size in half-points, so Heading 1's `40` is 20pt.

## Lists

A list paragraph is an ordinary paragraph carrying two properties:

- `335559682` — which list it belongs to
- `335559683` — its level

It also takes the `List Paragraph` style through `536884268`, but that style only
supplies the indent; the numbering comes from the list reference.

Each list has nine level definitions (`131073`), one per level:

| Property | Meaning |
| --- | --- |
| `469777804` | Level text — `%1.` for numbering, `-`/`o`/Wingdings glyphs for bullets |
| `469769242` | Number format |
| `469769226` | Font for the glyph |
| `335559685` / `335559991` | Indent and hanging indent |

The document's numbering table (`1074135175`) lists every level definition in
`603995142` and maps each list to its definition in `469789782`.

## Runs, and where character formatting lives

A paragraph holds its **whole text in one string** (`469769250`). Formatting that
changes partway through is expressed as parallel arrays, not as separate objects
holding their own text — the same shape as PowerPoint's model.

For a paragraph reading `All figures in this review are provisional and will be
confirmed once the period closes. Corrections should be sent to the operations
desk before the end of the month.`:

- `469769746` = `[31, 42, 89]` — run boundaries as character offsets. Four runs:
  `0–31` plain, `31–42` (`provisional`), `42–89` plain, `89–end` italic.
- `603987475` = four references, one per run, to character-formatting objects.

Character formatting (`1179649`) is where bold and italic actually live:

| Property | Meaning |
| --- | --- |
| `134224900` | Bold |
| `134224901` | Italic |
| `134224902` | Underline, with `201334293: "0"` (single) beside it |
| `134224903` | Strikethrough |
| `134224904` | Superscript |
| `134224905` | Subscript |
| `335551500` | Font colour, as `0xBBGGRR` (`255` is red); `4278190080` (`0xFF000000`) is Automatic |
| `335551501` | Highlight colour, as `0xBBGGRR` (`65535` is yellow); Highlight > No Color writes `4278190080` |
| `268442635` | Font size in half-points (`28` is 14 pt; Grow Font steps 10 pt to `22`) |
| `469777841`–`469777844`, `469769226` | Font name, written to all five slots; the theme-font links `201341986`, `201342446`–`201342449` go to `-1` |
| `335551547` | Language (`1033`), carried from the run being formatted |
| `201342000` | Language hint; `0` on every format the editor writes |
| `335560228` | `1` on every format that sets a property |
| `134233130` | `true` on the format Clear Formatting writes, which sets nothing else |

So bolding a word means splitting the boundary array and pointing that run at a
format object with `134224900` set — the text string itself never changes.

### The character-formatting write

Captured 2026-10-20 from the editor's Bold, font colour, font size and Clear
Formatting buttons on a selected word. Every one writes the same five things:

- **The paragraph (`393230`)**, whole, with the run boundaries (`469769746`) split
  at the selection's edges and every per-run property extended to match: the new
  run points its `603987475` entry at the format object below, and the
  `469777884`, `469777513` and `469777415` lists gain one entry per new run
  (`{0}`, `0`, `0`). The editor does not merge neighbouring runs whose formats
  match, so a paragraph formatted repeatedly accumulates runs.
- **A new character format (`1179649`)** holding only the properties the gesture
  set, plus `335560228: "1"` and `201342000: "0"`; Clear Formatting writes
  `201342000: "0", 134233130: "true"` instead. Its id is a version-5 GUID, so the
  editor names a format after its content and reuses it for identical formatting.
- **The root (`393271`)**, whole, with the new format's id appended to its list
  `603995325`. The list names the formats this editing session introduced, not
  every format in the document: after a reload the editor's next write lists only
  its own new format, while paragraphs keep pointing at older ones.
- **The paragraph's block (`393229`)**, with `335551866` set to the edit time.
- **The undo history**: a `1179729` author record and the `131140` object
  pointing at it, as for typing.

Ctrl+Space, the desktop shortcut for clearing character formatting, sends
nothing in Word on the web; the ribbon's Clear Formatting button is the gesture.

### Hyperlinks and the Hyperlink character style

A real hyperlink is a Word field, captured from Insert > Link on a selected word.
The paragraph text gains U+FFFC placeholders around the linked text —
`￼￼￼formatting￼` — and each placeholder is its own one-character run pointing
at a field-character object (`131073`) instead of a character format:

| Placeholder | `335559696` | Carries |
| --- | --- | --- |
| first | `15` | the field code, `469777596: "HYPERLINK \"https://example.com/\" "` |
| second | `47` | the same field code |
| third | `16` | — (separator) |
| after the text | `17` | — (end) |

The linked text's run points at a character format that names a character style
in `536884443`. Inserting the first link adds the built-in **Hyperlink**
character style (`1073872969`: name `469775450: "Hyperlink"`, underline
`134224902`, colour `335551500`, based on "Default Paragraph Font") to the
story's style list (`603993304` on the `393227` story).

Remove Link (captured 2026-10-20) drops every placeholder from the paragraph's
text and its runs from the per-run lists, and points the link text at a new
format: its own properties without the character style `536884443`, with
`134225428` and `134225433` (in a field, in a field's result) set to `false`.

Text can therefore look like a link without being one: a run whose format names
the Hyperlink style, with no field around it, is blue and underlined but goes
nowhere — what an inserted paragraph inherits when its neighbour is a link.
Clear Formatting removes that look, since the format it writes names no style.

### Paragraph formatting

Captured 2026-10-20 from the Home ribbon's Paragraph and Styles groups. Each
writes the paragraph (`393230`) whole with the properties below set, plus its
block's timestamp and the undo history — no format object and no root.

| Gesture | Paragraph properties |
| --- | --- |
| Align centre / right / justify | `335551550` and `335551620` both `2` / `3` / `6` |
| Increase indent (plain paragraph) | `335559685` (left indent, twips) `720` |
| Increase indent (list item) | `335559683` (list level) `0` → `1` |
| Line spacing 1.5 | `335559740` `360` (240ths of a line) and `201341983` `0` (auto rule) |
| Add space before | `335559738` `240` (twips) and `134233117` `false` |
| Shading | `335557856` fill colour (`15983321`) |
| Keep with next / keep lines together / page break before | `134245418` / `134245529` / `134245659`, `true` or `false` (Paragraph dialog, Line and Page Breaks) |
| Border (box) | per side: width `4` (eighths of a point), spacing `4`, colour `4278190080` (automatic) in `335572071`–`73`, `75`–`77`, `79`–`81`, `83`–`85`, and style `single` in `469789798`, `802`, `806`, `810` |

**Styles.** A paragraph names its style in `536884268`, a reference into the
document's style namespace, where built-in styles keep fixed indices: Normal
`|0`, heading 1 `|1`, heading 2 `|2` (List Paragraph was `|36` and Hyperlink
`|37` in the test document). Applying a style also clears the paragraph's direct
formatting (`134233130: "true"` on the paragraph, its runs pointed at the
Clear Formatting format) — a centred paragraph made a heading is no longer
centred. The first use of a built-in style writes its whole definition
(`1073872969`): name `469775450`, size, colour, spacing before/after
(`335559738`/`335559739`), outline level `335560102`, next style `469775498`,
linked character style `469777929` — and adds its name to the story's list of
used styles (`469789709`). A style already in the document is only referenced.

The story's `603993304` lists the styles the document uses, by reference. A
paragraph pointed at a style the story does not list — one the document defines
but no longer uses — is accepted and reads back as styled, then renders
unstyled and loses the style when the document is saved (verified 2026-10-20).
So a write applying a style lists it there, and its name in `469789709`, when
they are missing, as the editor's first use does.

**Lists.** Bullets and Numbering set `335559682` (list number) and `335559683`
(level) on each paragraph and give it the List Paragraph style. A new list
rewrites the numbering table (`1074135175`): `469777425` lists the list numbers,
`469789782` maps each to its definition, and `603995142` holds nine level objects
(`131073`) per definition — indent `335559685` (720 × level) and hanging indent
`335559991`, alignment `469777803`, level text `469777804` (`%1.` for numbers, the
glyph for bullets), and `469769242`: the bullet character code (`8226` •) with
its font in `469769226`, or for numbers `65533,<format>,46` where format `0` is
decimal, `4` lower-letter, `2` lower-roman and `46` is the trailing "." —
`335559684` is `-2` for a bullet level and `-1` for a numbered one.

## Reading the whole document

The editor's own poll (`[[2, …]]`), asked from the zero base
(`ExpectedLatestRevisionId: "00000000-0000-0000-0000-000000000000|0"`), is
answered with every revision since the document loaded — the whole current
document, `LatestRevisionId` included. The live tools read it this way through
the platform's pods engine, which rebuilds the model latest-wins per object id.

The body is reached from the root: `393271` `603986975` → story `393227`
`603986976` → section `1073872968` `603986976` → body containers `393241`. A
block a write has unlisted keeps its object in the latest-wins model, so only a
walk from the root says what is in the document now.

## Writing

A write posts `{Mode: 2, srs:[[3, {…, Revision:{Id, CellId, BaseId,
ExpectedLatestId, ObjectGroups}}]]}` to `/we/OneNote.ashx`, with `BaseId` and
both `ExpectedLatestId`s set to the current head. Each object in it replaces the
object of that id whole, so it carries the full property list.

Every request also carries the open file's WOPI `FileId` (an access token) and
the editor's Cobalt session identifiers (`LocalCobaltSessionId`, `LineageId`, …).
Those exist only in the editor frame, so a request built outside it carries
`__otbWordEnvelope: true` instead, and the pre-script fills them in from the
editor's latest poll before it is sent.

Three gestures, each decoded from the editor's own write and reduced to the
objects that carry the change:

| Gesture | Objects |
| --- | --- |
| Typing | The paragraph, with its whole new text and its run arrays kept consistent |
| Enter | The container with a new block in its `603986976` list, the new `393229` block (`201333763: "1"`, `603986975` → the paragraph) and the new `393230` paragraph |
| Removing a paragraph | The container with the block left out of its list |

The editor also sends one `131162` object per keystroke (`469777754` the
character, `335560025` its offset), a `1179729` author record beside each, and
the `4325465` history object pointing at the newest. These are undo history: a
write without them applies, renders in every open editor and persists (verified
live 2026-10-01). An idle editor polls about every 30 seconds, so another
editor shows a write after up to that long; a reload shows it at once.

### Keeping runs consistent with text

A paragraph with `469769746 = "42,46"` has three runs, and every per-run
property holds three entries: the comma lists `603987475`, `469777884`,
`469777513` and `469777415`, and the one-character-per-run strings `469769819`
and `469777855`. When a write changes the text it moves the boundaries with it:
offsets before an edit stay, offsets after it shift by the change in length, and
offsets inside it move to the end of the replacement, so the new text takes the
formatting of the run where the replaced text began. A run left empty is
dropped from every one of those properties.

A new paragraph copies everything its neighbour carries for the paragraph as a
whole (style, list membership, indents, spacing, the paragraph-mark format in
`536886591`), reduces the run properties to the neighbour's longest run, and
gets its own `335559695`/`335559959` identifiers — what the editor's Enter does.
