# Oracle Fusion ADF field guide

How this plugin talks to Oracle Fusion Cloud, and every behaviour of Fusion's UI layer that
shaped the code. Read this before changing the plugin or adding a screen; the companion
[adding-a-screen.md](adding-a-screen.md) is the step-by-step recipe.

## Why the plugin drives the UI instead of an API

- **REST is closed to the browser session.** `/fscmRestApi/resources/*` answers 401 to the
  SSO cookie and to the signed JWT embedded in page links; the token-relay endpoints 404 or
  401. A REST call made with `credentials: 'include'` also makes Chrome pop a native Basic
  sign-in dialog on the user's screen — never fetch REST paths with cookies. Any REST probe
  must use `credentials: 'omit'`.
- **OTBI / BI Publisher were ruled out** by the user.
- So the plugin replays the classic UI's own requests: Oracle ADF Faces ("ADF rich client")
  partial page requests, the same ones the browser sends when a person clicks.

## The protocol in one page

Every action is a form POST to `/fscmUI/faces/FuseWelcome?_adf.ctrl-state=…` with the
header `Adf-Rich-Message: true`. The body carries:

| Field | Meaning |
| --- | --- |
| `javax.faces.ViewState` | Page state token; take the newest one from each response |
| `org.apache.myfaces.trinidad.faces.FORM` | Always `f1` |
| `event` | Client id of the component the event fires on |
| `event.<id>` | The event itself, as `<m xmlns="http://oracle.com/richClient/comm">…</m>` — key/value pairs ending in `type` (`action`, `query`, `valueChange`, `disclosure`, `selection`, `fetch`, `dialog`, …) |
| `oracle.adf.view.rich.PROCESS` | Component(s) the server processes the event under (often a parent) |
| `oracle.adf.view.rich.RENDER` | Component(s) to re-render, when not implied |
| `oracle.adf.view.rich.DELTAS` | Client-side state the server has not seen, e.g. `{table={selectedRowKeys=3,viewportSize=10000}}` |
| every form field | Current values of the page's inputs, as a browser submits them |

Responses are XML: `<content action="…">` with `<fragment>` CDATA (HTML of re-rendered
regions) and `<script>` CDATA (component setup, messages). A `<noop/>` or `<redirect>`
answer, or a download with the wrong content type, means the server no longer holds the
window. Messages arrive as
`AdfPage.PAGE.addMessage(id|null, new AdfFacesMessage(TYPE_ERROR, summary, detail, null), label)`.

`adf-protocol.ts` builds events (`richEvent`, `richEventBatch`) and parses responses
(`parseRichResponse`, `parseMessages`).

## Background windows

ADF keeps page state **per window**. The plugin opens its own window with plain requests
(`adf-window.ts`): GET `FuseWelcome` returns a loopback page, and a second GET with
`_afrWindowId=null` makes the server allocate a new window. Nothing is rendered in the
browser, so searches never touch the pages the user is looking at.

Each search screen keeps **one** window (`search-screen.ts`), opened on first use and reused;
operations on it are queued, because every request depends on the state the previous one
left. ADF keeps a bounded number of page states per session: opening many windows evicts
older ones, including the user's own, and Fusion then answers the evicted window with a
generic "An application error occurred". The plugin treats that error as a closed window and
reopens once. **Keep debug harness windows to one or two.**

## State that belongs to the session, not the window

Some choices are stored per user session, so a change in the plugin's window shows up in the
user's own tabs, and the user's own clicks change what the plugin's window sees:

| State | Consequence | Handling |
| --- | --- | --- |
| Tasks panel category (Inventory / Counts / Shipments / Receipts) | The plugin found "no such task" after a category switch elsewhere | `openTask` sets the category every time |
| Expanded rows of a tree table | Rows expanded by the plugin show expanded for the user | Documented in the README |
| Collapsed / expanded sections of a detail page | A section may already be open, or not | `findCollapsedSection` returns null when already open; both paths work |
| Table column visibility (Show All) | Persists beyond the window — the user's table shows the same columns | Only done where the user agreed (movement requests) |

## Traps, by symptom

Each of these cost a debugging session. The fix is in the code; this is why it is there.

### A search returns 0 rows, no error

- **Panel folded.** After a successful search the query panel collapses; a collapsed panel
  ignores submitted criteria and re-runs the previous search. Unfold it first with a
  `disclosure` event carrying `DELTAS {panel={disclosed=true}}` — putting the delta on the
  query itself does not work. (`expandPanelEvent`)
- **Operator changed in the same request.** An operator dropdown (Starts with / Contains)
  changed in the query POST is silently ignored. Commit it first as its own `valueChange`.
  The same applies to Organization, whose change also resets dependent criteria. These are
  `leading` criteria. (`leadingChangeEvent`)
- **Safety net.** The panel stays open after a search that found nothing; the plugin then
  compares every submitted value with the value the server re-rendered and errors on a
  mismatch instead of returning an empty result. (`unappliedCriteria`)

### A search returns rows that do not match

- **Rejected search, stale rows.** A refused search (bad item, org, subinventory) leaves the
  previous results on the page. Messages are checked before any rows are read; warnings
  count ("Too many matching records" truncates silently otherwise).
- **Default criteria.** Some panels pre-fill fields: Manage Orders fills Buyer with the
  signed-in user. Clear every criterion the tool does not set, explicitly.
- **Date filter in another time zone.** Manage Pending Transactions filters its date in ≈UTC
  but displays local time. The tool searches a day wider each side and filters by the
  displayed date.

### Columns land under the wrong headings

- **Frozen columns** render as cells of the row itself, ahead of the cell holding the inner
  values table. Read `row.cells` in order, expanding the inner table in place. (`parseFlatTable`)
- **Cells that contain tables** (a link beside a notes icon): take the inner table's own
  `rows[0].cells`, never every `td` inside it.
- **A dialog left on the page** after it closes is re-rendered by later responses, with its
  own `tr[_afrRK]` rows and `th` headings. Tree rows are recognised by their node cell
  (`td[_afrNdCol]`); headings by ids under the table's own id.
- **Grouped export headings.** An export can have two `<th>` heading rows: a group (e.g.
  "Additional Information", colspan 31) above the grouped columns' own names. `parseExport`
  builds a rowspan/colspan grid and takes each column's lowest heading.
- **A lookup dialog's fields share the panel's name prefix** (`<field>::_afrLovInternalQueryId:value00`).
  Names with a nested `::component:` segment belong to the nested panel, not the main one.

### Detail pages return the wrong record

- **Tables that open the selected row.** On Manage Orders a row link opens the *selected*
  row, not the clicked one. Every row-link click carries `{table={selectedRowKeys=<key>}}`,
  as a browser's click does.
- **Tabbed shell (newer work areas).** Records open in a tab of their own; Done answers with
  a "You have not saved your changes. If you close this tab…" warning
  (`findComponent('…:MAwarn').show()`). Fetch the popup and click its Yes button
  (`…:MAyes`), or the record tab stays active and the search panel stops answering. Only
  that shell warning is ever confirmed automatically.
- **Done's response may not redraw the results** in a tabbed shell; row links are then found
  in the search response, whose ids do not change.

### Large results

- **Rendered tables cap at 500 rows** however large a viewport is asked for. Tools refuse a
  larger result with the count so the caller narrows it. Paging past 500 would need a capture
  of the table's scroll fetch.
- **Exports return every row** but only the columns the table shows.
- **A tool call silent for ~25 s is killed.** `search-screen` reports progress every 10 s.

## Module map

| Module | Responsibility |
| --- | --- |
| `adf-protocol.ts` | Event encoding, response parsing, messages, `elementText` |
| `adf-window.ts` | Background window: `submit`, `download`, `WindowClosedError` |
| `work-area.ts` | Home tiles, Tasks panel, task category, opening a task |
| `search-page.ts` | Query panel parsing, criteria (`Criterion`), search/export events, `parseExport` |
| `search-screen.ts` | One kept window per screen; queue, heartbeat, reopen, leading criteria, lookups, `SearchRejectedError` |
| `results.ts` | Results readers: export, export + detail pages, tree, rendered rows (+ details) |
| `flat-table.ts` | Plain table parsing, row keys, Show All columns |
| `tree-table.ts` | Tree tables: rows, expansion events |
| `detail-page.ts` | Row links, label/value fields, sections, Done, close-tab warning |
| `row-actions.ts` | Row selection, menu commands, dialogs (About This Record, availability, picks) |
| `lookup.ts` | A field's "Search and Select" dialog, for partial-number matches |
| `inventory.ts`, `procurement.ts` | Work-area tile settings and task categories |
| `tools/schemas.ts` | Output schemas and row mappers for every tool |

## Output conventions

- **Optional data is absent, not blank.** Fields read only on request (`include_details`,
  `include_availability`, `include_lines`) are left out when not requested. An agent once
  read blank placeholders as "Fusion has no value". When present, an empty string means
  Fusion has no value.
- **Failure is an error, never an empty result.** "No data" and "failed quietly" must not
  look alike.
- **Statuses over errors** where the answer is informative: an unknown document number is a
  `not_found` status, not a thrown rejection.
- **Full data.** Return locators, not just subinventories; keep every column the page
  exports (`additional_columns`, `columns`, `details`).
