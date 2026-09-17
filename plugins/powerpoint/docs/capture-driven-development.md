# Capture-driven development: how the live editing suite grew in one session

Companion to [[pods-action-catalog.md]] (what each write looks like) and
[[live-editing-suite-plan.md]] (what we plan to build). This doc records **how**
the 2026-09-17 session turned a list of "the plugin can't do that" complaints
into sixteen working live tools, what it taught us about the protocol, and the
loop to repeat for every capability still missing.

## What the session shipped

It started from an agent's report on a real review deck: multi-run text could
not be replaced, table rows could not be added, and an appended line "was
accepted but never landed". None of those were protocol limits. They were
builders written from guesses.

| Area | Tools | State before |
| --- | --- | --- |
| Text | `set_text` (multi-run), `add_paragraph` (fixed), `delete_paragraph` | refused, crashed the editor, or missing |
| Tables | `add_table_row`, `delete_table_row`, `set_table_height` | missing |
| Layout | `read_slide_layout`, `move_shape`, `resize_shape`, `duplicate_shape_live`, `set_shape_fill` | missing |
| Notes | the text tools above, on speaker notes | failed on every notes line |
| Scoping | `slide` on `set_table_height`, `format_text`, `set_font_size` | edits could land on a copied slide |

Every one was verified live on the test deck with a screenshot after the edit,
and each edit was also read back from the deck after a tab reload (not just from
the write's confirmation).

## The loop

Each capability went through the same six steps. None of them needed a person at
the keyboard once the deck tab was shared with the browser-automation tools.

1. **Reproduce on the test deck.** Run the failing tool on content shaped like
   the real failure (a pasted slide copy is ideal: real formatting, disposable).
   Screenshot. The `add_paragraph` bug only showed itself as an editor crash
   dialog on screen and a missing line after reload; the tool reported success.
2. **Capture the editor doing it.** Drive the gesture in the editor — click,
   keys, a ribbon button — and read the editor's own write from the in-frame write
   log (`__otb_pods_writelog__`, 60 writes / 24 MB; manifest first, then
   `?entry=N`). One gesture, one read, before the next gesture.
3. **Diff against the builder.** Compare the captured objects and properties with
   what our builder sends. The answer is almost always a property we never wrote,
   one we copied that should have been recomputed, or a container class we did
   not recognise.
4. **Build the smallest faithful write.** Copy the capture's structure: same
   object classes, same revision chaining, same action label. Put shared object
   construction in one module (`pods-text-block.ts`) instead of per action.
5. **Unit-test the shape, then test it live.** Fixtures use the captured
   property ids and values. Live test: write, screenshot, revert with our own
   tools, reload, read back.
6. **Record the decode.** Add the write to [[pods-action-catalog.md]] with the
   property ids and anything surprising, so the next builder starts from facts.

The loop costs a few minutes per capability. Guessing cost days: the old
`set_text` refusal and the `add_paragraph` crash both came from builders
written without a capture.

## What we learned about the protocol

### Text

- **A paragraph's run layout is three properties, not two.** Boundary offsets
  (`469769746`), run references (`603987475`) and a per-segment flag string
  (`469769819`, one character per segment). Any write that puts new text into a
  paragraph must reset all three to a single run; copying a neighbour's layout
  onto shorter text crashes the editor client while the server accepts it.
- **The editor never edits a text block in place.** Enter adds a new text-body
  block after the current one; typing over a whole multi-run paragraph swaps its
  block for a fresh one. A shape's `603986976` is a list of blocks.
- **Many "multi-run" paragraphs are one format.** Pasted text is split at old
  wrap points with every segment naming the same run.
- **Retired objects stay in the model with their text.** A replaced block's old
  paragraph and a deleted row's cells are unlisted, not deleted. Every text lookup
  must walk up to a container that is still listed before trusting a match.
- **Copied slides repeat their text.** Scope lookups by the slide's creation ids
  (`335562805`/`335562806`), which every object on the slide carries.
- **Speaker notes are ordinary text blocks** inside a placeholder shape of class
  `393326`. Supporting them was one container class, not a new tool.
- **List markers.** Blocks the editor creates by typing get their own bullet
  object, which in pasted decks renders differently from the master style. Copy a
  neighbour's marker only when it has one.

### Tables

- Insert, delete and height are all small writes on rows and the table object;
  cells copy the row above. A table frame is found through the table's recorded
  frame origin (`469780522`), not the frame's content reference.
- Rows never render shorter than their text: shrinking a table means shrinking
  text first.

### Shapes

- **Geometry is in half-inches** (`335551508`–`335551516`), confirmed against
  the ribbon's own Width/Height boxes.
- **Resize is a delta**, not a size: `469780600` carries edge deltas in 90-dpi
  pixels and the server applies them. Move is absolute.
- **Some writes come in chained pairs**, e.g. `ApplyShapeFillColor`: first the
  change, then the same change plus a colour-picker record.
- **The server can drop part of a write and still confirm it.** A name written
  with a duplicated shape read back correctly, then vanished on save. Only a
  reload proves persistence.

## Working rules this session earned

- **Screenshot after every edit, and trust the page, not the tool.** Two bugs
  (the notes crash, the dropped name) were invisible in tool results.
- **Reload before declaring done.** The editor's local render and the saved deck
  can disagree.
- **Use the deck's own history for cleanup.** A hand-driven Undo broke a bullet
  style that the tools then had to repair. Revert with our tools whenever one
  exists; when one does not, that is the next tool to build.
- **Read screenshots through the plugin tab tool when automation screenshots go
  stale.** The editor page occasionally stopped repainting for one screenshot
  source while the other showed the true state.
- **A temporary diagnostic beats a fifth guess.** The table-frame lookup took
  four rebuilds of reasoning; one debug field in the read output answered it in a
  single run. Add it, read it, remove it before committing.
- **Dry-run bodies are free introspection.** A `dry_run` write prints the
  properties of the objects it resolved — the fastest way to see what the live
  model holds without dumping it.
- **Build the extension, reload it, reload the deck tab.** A stale extension or
  editor tab silently runs old code. After a root build the MCP server restarts;
  wait about a minute before calling tools again rather than retrying into its
  session rate limit.
- **Remove an option that does not persist** rather than document around it.

## Applying it next

The same loop should drive the remaining gaps, in rough order of value for
review decks:

1. **Scoping everywhere.** Give `set_text`, `add_paragraph`, `delete_paragraph`
   and the table-row tools an optional `slide`, so copied slides are safe.
2. **Shape outline, text box insert, shape delete** — capture
   `ApplyShapeOutlineColor`, `InsertShapeAtSpecifiedLocation`, a Delete key on a
   selected shape.
3. **Table columns and cell fill** — Insert Left/Right, Delete Columns,
   `PowerPointCellShadingColor`.
4. **Paragraph formatting** — line spacing, bullets on/off, indent.
5. **Images and charts** — expect multi-request captures; the write log still
   holds them.

For any other Office web app the method transfers unchanged: find the app's
equivalent of the write log (a pre-script interceptor on its edit endpoint),
capture one gesture at a time, and build from the capture.
