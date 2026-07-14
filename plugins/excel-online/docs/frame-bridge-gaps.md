# Frame-bridge tools — known gaps and future work

The advanced Excel tools driven through the frame bridge (`freeze_panes`,
`format_range_advanced`, `set_print_area`, `insert_page_break`, `set_hyperlink`,
`add_comment`, `add_conditional_format`, `apply_cell_style`, the plain-range filter
tools, `add_data_validation`/`clear_data_validation`, `remove_duplicates`,
`group_rows_columns`, `text_to_columns`) call Excel Online's internal
`EwaInternalWebService` RPC directly. Most of the protocol has been decoded — the
conditional-formatting `Command` codes, for example, were read straight out of the
client bundle (`EwaTS.conditionalformattingcommandhandlerservice.js`, the
`menuItemId → Command` map); the rest were decoded from live network captures of the
Office Web Apps frame. A few items remain unsolved and are recorded here so
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

## 3. AutoFilter on a plain range — solved via the frame bridge

Plain-range AutoFilter (the dropdown arrows from Data → Filter on unstructured
data) is **not exposed by Graph at all**: the `workbookWorksheet` resource has
no `autoFilter` relationship in v1.0, and the drive-item
`worksheets/{id}/autoFilter/apply` path 404s on both v1.0 and beta. (`filter_table`
/ `clear_table_filters` cover **table** filtering via the Graph
`tables/{id}/columns/{col}/filter` endpoints.)

It is now handled through the frame bridge:

- `toggle_range_autofilter` → EWA `ToggleAutoFilter`, options `{ filterRange:
  {SheetName, NamedObjectName:"", FirstRow, LastRow, FirstColumn, LastColumn} }`
  (0-based). Toggles the sheet AutoFilter on/off.
- `filter_range_column` → EWA `ApplyFilterV2`, options `{ parameters: {Location:
  {SheetName, NamedObjectName:"", FirstRow:0, FirstColumn:<1-based abs col>},
  FieldId:"<0-based field in range>", DataSourceIndex:-1, FilterType:"Sheet",
  AnchorType:0, ChartId:null, AnchorValue1:-1, AnchorValue2:-1}, checkedItems:
  ["i"+value, …], avoidDecodingItems:true }` (values kept; text and numeric
  verified). No `contextPatch` needed.
- `filter_range_custom` → EWA `SetCustomFilter`, options `{ parameters:{
  ActiveCompareType, ColumnName:"", Value1, Value2, Location:{SheetName,
  NamedObjectName:null, FirstRow:1, FirstColumn:<1-based abs col>, LastRow:1,
  LastColumn:<same>}, FieldId:"0", FilterType:"Sheet", ValueTypeText:true, … } }`.
  The column is identified by `Location.FirstColumn` alone (`ColumnName:""`
  works). `ActiveCompareType` is even for a positive operator, odd for its
  negation: equals 0 / not_equal 1, begins_with 2 / does_not_begin_with 3,
  ends_with 4 / does_not_end_with 5, contains 6 / does_not_contain 7,
  greater_than 8 / greater_or_equal 9, less_than 10 / less_or_equal 11,
  between 12 / not_between 13. All are exposed; the four negations and
  begins_with/ends_with are each +1 (or the base) of a live-verified code.
- `filter_range_top` → EWA `SetTop10Filter`, options `{ parameters:{ Count:"<N>",
  Top:<bool>, Type:<1=items|2=percent>, Location:{… FirstColumn:<1-based abs>},
  FieldId:"0", FilterType:"Sheet", MaxCount:500, Title:"", … } }`.

Clearing a single column's item filter is `ApplyItemFilter` with `items:null`.
The EWA `NumRowsFiltered` in the response is the number of rows **kept**, not
hidden.

## 4. Data validation — solved via the frame bridge

Graph does not expose data validation (the `workbookRange` resource has no
`dataValidation` relationship in v1.0 **or** beta), but it is reachable through
the frame bridge. `add_data_validation` → EWA `CreateOrEditDataValidation`,
options `{ selectedRanges, ruleOptions:{ Command:0, RuleType, ConditionType,
IsIgnoreBlank, IsInCellDropDown, LowerBoundary, UpperBoundary, IsAlertBlocking,
IsShowErrorAlert, IsShowInputMessage, AlertTitle, AlertMessage, InputTitle,
InputMessage, ShouldIgnoreFormulaError } }` with a `ViewportStateChange` context
patch (no prep needed).

- `RuleType` is sent by name from the client's `DataValidationRuleType` enum:
  `anyValue` (clears validation), `wholeNumber`, `decimal`, `list`, `date`,
  `time`, `textLength`, `custom`. A `list` sets `IsInCellDropDown:true` and puts
  the comma-joined choices (or a range/formula) in `LowerBoundary`.
- `ConditionType` uses the OOXML operator names: `between`/`notBetween` (both
  boundaries) and `equal`/`notEqual`/`greaterThan`/`lessThan`/`greaterThanOrEqual`/
  `lessThanOrEqual` (LowerBoundary only). Verified live: `list`+`between`,
  `wholeNumber`+`between`, `wholeNumber`+`greaterThan`.

`clear_data_validation` removes a rule → the same method with **`Command:1`** (the
dedicated clear op) and `RuleType:"anyValue"`, preceded by a `GetDataValidationSettings`
prep to establish the existing rule's edit-state. `Command:0` is create/edit; using
it to overwrite an existing rule is rejected by the edit-state guard — that command
off-by-one, decoded from a captured add-then-remove, is what made clearing look
impossible.

**The `DataValidationEditStateChangedError` has two distinct causes** (neither is
the ownership barrier the earliest "walled" conclusion assumed):

1. **Donor staleness** — the commit is rejected when the reused donor's revision is
   behind the server. Data-validation commits are the most revision-strict of the
   bridge writes (each success advances the revision, so the donor must re-sync via
   the page's next poll — or a fresh in-grid edit — before the following DV write;
   worse in OCS co-authoring mode). On a current-revision donor both add and clear
   replay cleanly.
2. **No existing rule to clear** — calling `clear_data_validation` (`Command:1`) on a
   cell that has no rule is rejected with the *same* error, even with a perfectly
   fresh donor. Confirmed by capture: the `GetDataValidationSettings` prep succeeds
   and returns `RuleType:0` (anyValue / no rule), then the `Command:1` commit fails.
   This is a no-op situation — the cell is already free-entry — so the error is
   benign, but it does mean clearing an already-clean cell surfaces an error rather
   than silently succeeding. (Note: Graph `clear_range` with `apply_to:"All"` removes
   a cell's data validation, which is how a cell can end up rule-free.)

Data validation also supports a `custom` rule type (formula-based): `add_data_validation`
with `type:"custom"` sends `RuleType:"custom"` and puts the formula (which must evaluate
TRUE for the entry to be allowed) in `LowerBoundary`. Verified live (`=ISNUMBER(...)`).

## 5. Remove duplicates — solved via the frame bridge

Graph v1.0 has no `removeDuplicates` on `workbookRange` (beta/Office-JS only), but it
is reachable through the bridge. `remove_duplicates` → EWA `RemoveDuplicates`, options
`{ removeDuplicatesInput: { HasHeader, Range:{SheetName,NamedObjectName:"",FirstRow,
LastRow,FirstColumn,LastColumn}, KeyColumns:[<0-based indices within the range>] } }`
with a `ViewportStateChange` context patch. When `HasHeader` is true the first row is
preserved, so `Range.FirstRow` starts one row **below** the selection's first row. The
client fires a `GetRemoveDuplicatesInfo` GET first (dialog population); it is not needed
for the commit. The `EwaResult.Result` reports `{CountDuplicates, CountRemaining}`.
Verified live (2 dup rows removed, 3 remaining).

## 6. Group / ungroup rows and columns — solved via the frame bridge

Row/column outline grouping is bridge-only. `group_rows_columns` → EWA
`GroupOrUngroupCells`, options `{ selectedRange:{SheetName,NamedObjectName:"",FirstRow,
LastRow,FirstColumn,LastColumn}, isGroup:<bool>, isRows:<bool> }` with a
`ViewportStateChange` patch. One method covers all four cases via the two booleans:
`isGroup` (true = group, false = ungroup) and `isRows` (true = rows, false = columns).
A **rows** group fills the full column extent (`FirstColumn:0, LastColumn:16383`); a
**columns** group fills the full row extent (`FirstRow:0, LastRow:1048575`). No prep.
Verified live (group rows, group/ungroup columns, ungroup rows).

## 7. Text to columns — solved via the frame bridge

Splitting a delimited column is bridge-only. `text_to_columns` → EWA `TextToColumns`,
options `{ textToColumnsInput:{ Delimiters:{IsTab,IsSemicolon,IsComma,IsSpace,
IsConsecutive,IsCustom,CustomDelim}, SelectedSourceRange:{…single column…},
DestinationCell:{SheetName,NamedObjectName:"",FirstRow,FirstColumn}, OverrideNonBlankCells
} }` with a `ViewportStateChange` patch. `CustomDelim` is the **ASCII code** of the
custom delimiter character (e.g. `45` for `-`), used when `IsCustom` is true; the four
standard delimiters are the boolean flags. `IsConsecutive` treats runs of the delimiter
as one. The destination defaults to the source top-left (split in place). No prep.
Verified live (split `"East-Alpha"` → `East` | `Alpha`).

## Not available on Excel for the web

**Fill Series** (the classic Home → Fill → Series dialog) does **not** exist in Excel for
the web — only Flash Fill (a separate ML-driven autocomplete, `CreateFlashFillAutoComplete`)
is offered. There is no Series RPC to bridge, so it is intentionally not built.
