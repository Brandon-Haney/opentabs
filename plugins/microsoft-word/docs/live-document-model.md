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

So bolding a word means splitting the boundary array and pointing that run at a
format object with `134224900` set — the text string itself never changes.

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
