# Frame-bridge tools — known gaps and future work

The advanced Excel tools driven through the frame bridge (`freeze_panes`,
`format_range_advanced`, `set_print_area`, `insert_page_break`, `set_hyperlink`,
`add_comment`, `add_conditional_format`) call Excel Online's internal
`EwaInternalWebService` RPC directly. Most of the protocol has been decoded — the
conditional-formatting `Command` codes, for example, were read straight out of the
client bundle (`EwaTS.conditionalformattingcommandhandlerservice.js`, the
`menuItemId → Command` map). A few items remain unsolved and are recorded here so
they can be picked up later. The bundle-extraction method used to decode the rest
is documented separately and applies here too.

## 1. Conditional formatting — New Rule "Cell Value" operators

`add_conditional_format` covers every conditional-formatting operator: the quick-menu
rules (greater/less/between/equal, text contains, duplicates, top/bottom, above/below
average), all data-bar, color-scale, and icon-set style presets, and the four **New
Rule → "Format only cells that contain" → Cell Value** operators that are absent from
the quick menus — `greater_than_or_equal` (Command 68), `less_than_or_equal` (69),
`not_between` (70), and `not_equal` (71). Those four are not in the client's quick-menu
command map (`Ha.cMd`); their codes were captured from live New-Rule requests (they use
`Command` 68–71, not the low unused slots one might guess). No open operator gap remains.

## 2. Conditional formatting — `date_occurring` time periods

The "A Date Occurring" highlight rule (`Command 6`) is wired but not exposed, because
its `TimePeriodType` sub-enum (yesterday / today / tomorrow / last 7 days / last week /
this week / next week / last month / this month / next month) is undecoded — it lives
in the same unreachable RuleEditor pane chunk. The request field name (`TimePeriodType`)
is confirmed; only the integer values are missing.

**To resolve:** capture one `date_occurring` rule per period. Network capture of the
Office Web Apps frame is a cross-origin child target, so it is only recorded if the
**page is refreshed after enabling capture** (the debugger's `setAutoAttach` attaches
to the frame on its next load; an already-loaded frame is missed). With that, apply one
rule per period in the New Rule dialog and read `TimePeriodType` from each request.

## 3. AutoFilter on a plain range — absent from Graph, needs the frame bridge

`filter_table` / `clear_table_filters` cover filtering **tables** (the Graph
`tables/{id}/columns/{col}/filter` endpoints, v1.0). Filtering a plain,
non-table range — the dropdown arrows a user gets from Data → Filter
(Ctrl+Shift+L) on unstructured data — is **not exposed by Graph at all**: the
`workbookWorksheet` resource has no `autoFilter` relationship in v1.0, and the
drive-item `worksheets/{id}/autoFilter/apply` path 404s on both v1.0 and beta.

Reaching plain-range AutoFilter would mean driving Excel Online's internal
`EwaInternalWebService` through the frame bridge, the same route the
conditional-formatting tools use. The method name and options are undecoded.

**To resolve:** capture a live "Filter" toggle and a column filter apply on a
non-table range (refresh the page after enabling network capture so the
cross-origin Office frame is recorded), then decode the method and option shape
the way the CF `Command` catalog was decoded.

## 4. Data validation — blocked on both routes

Data validation is unreachable by either backend:

- **Graph** does not expose it. In v1.0 the `workbookRange` resource has no
  `dataValidation` relationship (only `format`, `sort`, `worksheet`), so there
  is no REST path to set a validation rule on a range.
- **Frame bridge** reaches the semantic layer but is walled at the ownership
  layer (below).

`add_data_validation` was built for the bridge and its payload shape is correct
(it reaches the semantic layer), but `CreateOrEditDataValidation` returns
`DataValidationEditStateChangedError` under out-of-band replay across three verified
approaches (raw donor, prep + state-merge, and a `ViewportStateChange` selection
patch). Unlike conditional formatting, the data-validation dialog's edit-state is
owned by the live Office client; an out-of-band commit is treated as a competing
participant ("another user has made changes"). This is a runtime ownership barrier,
**not** a payload or protocol decode problem, so bundle research will not unblock it.
The tool was removed rather than shipped broken. Reaching data validation would
require driving the actual DV dialog in the page (owning its edit-state), not the
direct-replay bridge.
