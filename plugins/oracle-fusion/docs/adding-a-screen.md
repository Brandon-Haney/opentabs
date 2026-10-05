# Adding a Fusion screen

The recipe that built every tool in this plugin. Read [adf-field-guide.md](adf-field-guide.md)
first for how the protocol works and which traps already have fixes.

## 1. Inspect the page before capturing

With the screen open in the user's tab, read its DOM (`browser_execute_script`, read-only):

- **Query panel**: `[role=search]` — labels, field names, dropdown options, default values.
  Note fields filled by default (Manage Orders fills Buyer with the user).
- **Results table**: `new AdfRichTable('…')` id, an `…:ATex` Export button or not, and the
  View → Columns items (`[role=menuitemcheckbox][id*="_shwClm"]`) — hidden columns are often
  the ones that matter (locators).
- **Row links**: `…:<rowKey>:<linkId>` anchors that open a detail page.
- **Menus**: Actions / View items (`[role=menuitem]`) such as About This Record, View Picks,
  View Item Availability.

Often the existing building blocks already cover the page: try the generic route (tile →
Tasks → task → search) in **one** background window before asking for a capture.

## 2. Capture what is not covered

Ask the user to perform the clicks while network capture runs on their tab
(`browser_enable_network_capture` with `urlFilter: '/fscmUI/faces/'`).

- **Stop all plugin calls while recording.** Plugin requests run through the same tab and
  flood the buffer; a multi-megabyte buffer makes `browser_get_network_requests` time out.
  Use a small `maxRequests` and restart the capture if it fills.
- **Confirm the first action was recorded** before the user goes on; captures have silently
  stopped mid-walkthrough.
- Ask for the exact path, including closing dialogs and leaving detail pages — the way back
  is often the unknown part (Done buttons, close-tab warnings, dialog OK versus Done).
- Read the saved capture with a script that prints, per request, `event`, the decoded
  `event.<id>` payload, `PROCESS`, `RENDER` and `DELTAS`; save each response body to disk for
  fixtures.
- A popup the browser fetched on its own (`type=fetch`) is part of the flow; the response
  before it shows it with `findComponent('…').show()`.

## 3. Build from existing pieces

A new screen is usually configuration plus a mapper:

```ts
const screen = createSearchScreen({
  workArea: inventoryWorkArea,          // tile label, from a setting
  workAreaSetting: INVENTORY_WORK_AREA_SETTING_LABEL,
  category: INVENTORY_TASKS,            // omit when the Tasks panel has no categories
  task: 'Review Completed Transactions',
  entryButton: undefined,               // a landing page's button to the search page, if any
  results: exportedRowsWithDetails,     // see the table below
});
```

| Page shape | Reader |
| --- | --- |
| Table with Export | `exportedRows` |
| Export + a detail page per row (+ About This Record, + a detail-page table export) | `exportedRowsWithDetails` |
| Tree table (expandable rows) | `treeRows` (+ `pickAvailabilityRows`) |
| Table without Export | `renderedRows(pattern, { showAllColumns })` |
| No Export + detail pages (sections, per-line dialogs) | `renderedRowsWithDetails(pattern, { sections, lineCommand })` |

Criteria are addressed by the label the page shows (`{ label, text | date | option | checked }`);
mark organization and operator criteria `leading`. Partial matches on a lookup field go
through `screen.lookup(field, text)`.

Write the output schema and mapper in `tools/schemas.ts`. Keep every column (named fields for
the important ones, the rest in `additional_columns` / `columns` / `details`), and leave
on-request data out of the output when it was not requested.

## 4. Test against live data

- Pick records whose answer you already know (from the user's screenshot or another tool)
  and compare field by field.
- Test the **second call**, not just the first: a search after a detail read, after a
  rejected search, after a zero-row search. Most bugs here were state left by the previous
  operation.
- Test multi-row detail reads and check each row got **its own** record.
- Test a zero-row search and a too-broad search; both must say so rather than look normal.
- Re-run the other tools after changing a shared module (`results.ts`, `search-page.ts`,
  `search-screen.ts`).

## 5. Finish

- Unit tests with fixtures shaped like the captured HTML (`*.test.ts` beside each module).
- `npm run check` in the plugin (build, type-check, lint, format, tests).
- Tool descriptions stay under 1,000 characters — the build rejects longer ones.
- `npx opentabs-plugin readme` regenerates the README; re-append the manual **Notes**
  section afterwards (the generator does not preserve it).
- Build plugins through the repo script from **Bash**: in PowerShell
  `npm run build:plugins -- --filter=oracle-fusion` loses the `--` and builds every plugin.
