# Capture-driven development for Office co-authoring apps

How to build live editing tools for the SharePoint-hosted Office web apps —
PowerPoint, Excel, Word, OneNote — so that every write matches what the app's own
editor sends. It sits beside [[microsoft-office-web-apps.md]], the field guide to
how these apps are built (frames, auth, transports), which already sets
co-authoring as the write path for all of them. The field guide says **what** the
apps are; this doc is **how to extend a plugin** for any of them.

The method was proven on PowerPoint on 2026-09-17: one session turned "the plugin
can't do that" (multi-run text refused, an appended line crashing the editor, no
table rows, no layout, no speaker notes) into sixteen live tools, each verified on
the test deck. The lessons below that are not PowerPoint wire details apply to
every app, because every app has the same shape: a cross-origin editor frame that
turns user gestures into writes a server merges.

## The loop

Every capability goes through the same six steps.

1. **Reproduce on a test document.** Run the failing tool on content shaped like
   the real failure — a copy of a real slide, sheet or page is ideal: real
   formatting, disposable. Screenshot. Tool results are not evidence: the
   PowerPoint `add_paragraph` bug reported success while the editor showed a crash
   dialog and the line was gone after a reload.
2. **Capture the editor doing it.** Drive the gesture in the real editor — click,
   keys, a ribbon button — through browser automation, and read the editor's own
   write from an in-frame write log. One gesture, one read, before the next.
3. **Diff against the builder.** Compare the captured write with what the plugin
   sends. The answer is almost always a field never written, one copied that
   should have been recomputed, or a container type the lookup did not accept.
4. **Build the smallest faithful write.** Copy the capture's structure: the same
   objects or RPC arguments, the same chaining, the same action label. Put shared
   construction in one module rather than per tool.
5. **Unit-test the shape, then test it live.** Fixtures use the captured ids and
   values. Live: write, screenshot, revert with the plugin's own tools, reload the
   document, read it back.
6. **Record the decode** in the app's wire catalog — ids, units, surprises — so
   the next builder starts from facts.

A capability costs minutes this way. Guessed builders cost days: both PowerPoint
failures that started the session came from writes built without a capture.

## Capture infrastructure, per app

Step 2 needs a way to see the editor's writes from inside its frame. CDP network
capture on the tab misses them (the editor is an out-of-process iframe), and
DevTools HAR exports work but need a person at the keyboard.

| App | Live write channel | Write log | Status |
| --- | --- | --- | --- |
| PowerPoint | `/pods/PowerPoint.ashx` revisions (JSON objects and properties) | `__otb_pods_writelog__` in the pre-script: a ring buffer of the last 60 writes, 24 MB; manifest, then `?entry=N` | **In use.** The loop runs end to end with no manual steps. |
| Excel | `EwaInternalWebService` RPC via the frame bridge | `__otb_ewa_writelog__` in the pre-script: the last 200 requests with a body, path only; manifest, then `?entry=N`, against the `xlviewerinternal.aspx` frame | **In use.** Wait for the "Loading…" bar to clear before judging a reload: the grid first renders a cached view. |
| Word | unproven; WOPI reports `IsPragueDocument` (Fluid, likely socket ops) | none | **Capture first.** Confirm whether the channel is replayable before building anything live. |
| OneNote | WAC `ObjectModel` command bus | none | Different mechanism; the same loop applies once commands can be observed. |

Porting the write log is the highest-leverage piece of work for Word: it is what
made the PowerPoint and Excel loops fast. Read it through `browser_fetch_in_frame`
against the editor frame, as both do.

## Look for the app's own API inside the channel

Before decoding a gesture, check whether the editor already tunnels a documented
API of its own through the same channel. Excel's does: the method
`ExecuteRichApiRequest` carries an ordinary REST call —
`{HttpMethod, PathAndQuery, RequestHeaders, RequestBody, RequestFlags}` — over the
same resource paths as the Graph workbook API, and runs it inside the live
session. That was worth more than any single decode:

- **It answers in milliseconds and needs no Graph token**, on a workbook whose
  Graph calls were timing out and then refusing with 403 under co-authoring.
- **It serves methods the public API lacks**: copy and paste, find and replace, a
  PivotTable over a range, comments, page setup.
- **Its paths are documented**, so a tool is written from the API reference rather
  than from a capture. Keep capturing for what it will not do: Excel refuses
  `find`, `findAll` and `$batch`, and setting several cell borders in one request
  needed the editor's own `FormatCellsV2`.

The lookout is the same in any of these apps: an editor method whose argument is a
whole request, a path, or a script. Word and OneNote host add-ins the way Excel
does, so each is likely to tunnel its own object model too.

**Reading its answers.** A tunnelled call reports its own status inside an
otherwise successful envelope, so a caller that checks only the outer result reads
a refusal as success — the frame-bridge engine now treats a tunnelled status of
400 or above as a failure. A write echoes only the resource's default fields, so a
property it accepted is usually missing from the reply: read it back by name
rather than concluding it was ignored (that mistake cost an afternoon here).
Paths differ in one detail: Graph wants the names in them percent-encoded, and the
session matches them literally.

**Letting a tool use the result.** A tool handler can hand the platform a
frame-bridge call and end on it, or — since `ToolHandlerContext.bridge` — run one
and carry on with what came back. The second is what lets a tool built on the
public API move onto the session while keeping its own output; in Excel one
wrapper now sends each workbook path down whichever path is available.

## Lessons that apply to every app

**Verification**

- **Screenshot after every edit and trust the page, not the tool result.** Two
  PowerPoint bugs were invisible in results: an edit the server accepted but that
  crashed the editor, and a property the server confirmed and then dropped on
  save.
- **Reload before declaring done.** The editor's local rendering and the saved
  document can disagree. Only a reload proves persistence.
- **Let the reload finish.** Excel redraws a cached grid while it is still
  loading. Judging state in that window produced two wrong conclusions in one
  session, in both directions.
- **Read a setting back by name.** A write's own response is not evidence that a
  property applied, and its absence there is not evidence that it did not.
- **When an option does not persist, remove it** instead of documenting around it.

**Protocol shapes to expect**

- **A server can accept a write that breaks the client.** The merge server
  validates less than the editor does. Build from captures, not from what the
  server tolerates.
- **Deleted and replaced content usually stays in the model, unlisted.** Any
  lookup by visible text must confirm its match is still attached to the document
  before using it.
- **Copied content repeats text and sometimes identity.** A duplicated slide
  repeated every paragraph; a pasted table kept its source slide's identity until
  rewritten. Scope lookups (slide, sheet, section) and prefer structural identity
  over text.
- **Calibrate units against the app's own UI.** PowerPoint geometry turned out to
  be half-inches; that was confirmed by typing a width into the ribbon and reading
  the write, not by estimating from screenshots.
- **Some edits are deltas, not values** (PowerPoint resize sends edge deltas the
  server applies), and **some arrive as chained writes** (a fill change is two
  revisions). Match the capture exactly; do not "simplify" the chaining away.
- **The same structure appears in unexpected containers.** Speaker notes were
  ordinary PowerPoint text blocks inside a different shape class; supporting them
  took one lookup rule, not a new tool. Check where else a structure lives before
  building a parallel tool.

**Working rules**

- **Revert with the plugin's tools, not the editor's Undo.** A manual Undo during
  cleanup broke a bullet style that then needed repairing. When a revert tool is
  missing, that is the next tool to build.
- **A temporary diagnostic beats a fifth guess.** A table lookup took four
  rebuilds of reasoning; one debug field in a read result answered it in a single
  run. Add it, read it, remove it before committing.
- **Dry runs are free introspection.** A dry-run write returns the properties of
  the objects it resolved — the fastest way to see what the live model holds.
- **Rebuild, reload the extension, reload the document tab.** A stale extension or
  editor tab runs old code silently. A root build restarts the MCP server; wait
  about a minute before calling tools again rather than retrying into its session
  rate limit.
- **When one screenshot source goes stale, use another.** Browser automation
  screenshots occasionally stopped repainting while the plugin's own tab
  screenshot showed the true state.
- **Watch for other editors.** The write log records everyone's edits in the
  session; leave writes you did not make alone.
- **A session expires when the tab sits idle,** after which every call fails —
  reads included — with the app's most generic error. Map that error to "reload
  the document" rather than passing it on.
- **Reloading a tab while the extension restarts leaves the page without the
  pre-script,** so calls hang with no explanation until the tab is reloaded again.
  Check that the write-log sentinel answers before blaming a tool.

## Applying it next

- **All apps:** a slide/sheet/section scope on every tool that finds content by
  text.
- **Excel:** move the rest of the Graph-backed tools onto the session wrapper, and
  capture the gaps listed in `excel-online/docs/frame-bridge-gaps.md`.
- **Word and OneNote:** look for a tunnelled object model first — it may beat
  decoding the channel, as it did for Excel. For Word, capture the co-authoring
  channel and decide whether it is replayable; the staged Graph path stays until a
  live path is proven.
- **PowerPoint:** shape outline, text box insert and delete, table columns and
  cell shading, paragraph formatting, then images and charts (multi-request
  captures; the write log holds them).

## PowerPoint: what the loop decoded (2026-09-17)

The wire details live in [[pods-action-catalog.md]]; the summary:

| Area | Tools | Key findings |
| --- | --- | --- |
| Text | `set_text` (multi-run), `add_paragraph`, `delete_paragraph` | Run layout is three properties — boundaries `469769746`, run refs `603987475`, per-segment flags `469769819` — and new text must reset all three. The editor never edits a text block in place: Enter adds a block; typing over a multi-run paragraph swaps the block. |
| Notes | the text tools | Notes live in placeholder shape class `393326`, same block structure. |
| Tables | `add_table_row`, `delete_table_row`, `set_table_height` | Small writes on rows and the table; cells copy the row above. Rows never render shorter than their text. The table records its frame's origin in `469780522`. |
| Layout | `read_slide_layout`, `move_shape`, `resize_shape`, `duplicate_shape_live`, `set_shape_fill` | Geometry in half-inches; move is absolute, resize is an edge delta; a duplicate's name is dropped on save; fill is two chained revisions. |
| Scoping | `slide` on `set_table_height`, `format_text`, `set_font_size` | Every object carries its slide's creation ids `335562805`/`335562806`. |
