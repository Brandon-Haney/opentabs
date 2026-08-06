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

## 6. PivotTable operations — method names decoded, argument shapes partly open

PivotTables are driven through `EwaInternalWebService` like everything else, but the
method names do not follow the `<Verb><Noun>` shape the other operations use, so they
are not guessable. Captured live (2026-08-06) while refreshing a cube-backed pivot and
changing a page filter:

| Method | Calls | Purpose |
| --- | --- | --- |
| `Refresh` | 15 | Refresh the pivot / its data connection. **Not** `RefreshPivotTable` or `RefreshAll`. |
| `GetPivotFieldListData` | 5 | The field list — every field the model exposes |
| `GetPivotFieldManagerData` | 4 | Field-manager (zone assignment) state |
| `GetPivotFilterData` | 2 | Filter member list for a field |
| `ApplyFilter` | 2 | Apply a pivot filter. Distinct from the plain-range `ApplyFilterV2`. |
| `GetPivotTableCellInfo` | 1 | Pivot metadata at a cell |
| `GetSensitivityLabelsForPowerBIDatasets` | 6 | Sensitivity labels, Power BI-backed pivots only |

Existence can be probed without knowing the arguments: an unrouted method answers
**401**, a real method with a bad body answers **500**. `RefreshPivotTable`,
`RefreshAll`, `GetPivotTableInfo`, `SetPivotFilter`, `ApplyPivotFilter`,
`RefreshSelectedConnection` and `PivotFieldDrop` all 401 — they do not exist.

**Decoded — `ApplyFilter`** (pivot page filter):

```
parameters: {
  Location: { SheetName, NamedObjectName: "None",
              FirstRow: "1", FirstColumn: "1", LastRow: "1", LastColumn: "1" },
  IsPivotFilter: "True",          // what separates this from a plain-range filter
  FieldId: "6",                   // index of the pivot field
  DataSourceIndex: "1",
  HierarchyLevel: "1",
  AnchorType: "0", ChartId: "None", AnchorValue1: "-1", AnchorValue2: "-1"
}
checkedItems: ["16"]              // member indices, not member names
```

`GetPivotTableCellInfo` takes `activeCell: { SheetName, NamedObjectName: "", FirstRow,
FirstColumn }`. Pivot coordinates here are **1-based**, matching the plain-range filter
methods.

**`Refresh`** — decoded once the capture cap was raised (see the capture note below):

```
connectionName:      "<workbook connection name>"   // from xl/connections.xml
externalSourceIndex: 1
userAadToken:        "<JWE, ~3.2 KB>"               // REQUIRED — omitting it answers 500
```

`userAadToken` is an encrypted AAD token (`alg:dir`, `enc:A256CBC-HS512`, `xms_hd_iat`
claim) that lets the server re-query the model on the user's behalf. It appears on
`Refresh` and on no other method; `UpdateWacAADToken` is a GET that carries no token.
It is minted inside the Office frame, which is the crux of the remaining work — the
adapter runs in the SharePoint host frame and cannot read across that boundary. The
intended fix is to let the frame-bridge engine (which already runs *inside* the frame
and already reads `__otbEwaDonor`) pull named values from frame globals into the
request body, paired with a pre-script that stashes the freshest token it observes.
That keeps the credential in the frame — it never reaches the host page or the adapter.

**`GetPivotFieldListData` / `GetPivotFieldManagerData` / `GetPivotFilterData` are GETs**,
which is why they were recorded with no request body and why POSTing to them answers
500. Everything travels in the query string:

```
context=<~900 char JSON>   cell={"SheetName","NamedObjectName","FirstRow","FirstColumn"}
dataSourceIndex=1          optionalPivotAnchorParameter={"AnchorType":0}
type=1  version=<n>  relatedGroup=-1  selectedTab=-1  waccluster=<cluster>
```

Note the GET `context` is ~900 characters, not the ~88 KB one a POST carries.
`FieldListItems` comes back grouped and lazily expanded (11 top-level entries with 40
`RelatedGroups`), so resolving a field name to the `ItemIndex` that `ApplyPivot` wants
means walking `relatedGroup` ids.

## 7. PivotTable field placement and creation — decoded

**`ApplyPivot`** places a field into a zone. Captured once per zone:

```
cell:  { SheetName, NamedObjectName: null, FirstRow, FirstColumn, LastRow, LastColumn }  // 0-based
dataSourceIndex: <n>
optionalPivotAnchorParameter: { AnchorType: 0 }
pivotFieldApplyData: {
  FieldListType: 1, FieldListVersion: <n>, FieldWellVersion: <n>,
  SourceAxis: 0, SourceAxisPosition: 0,
  ItemType: <3 = measure | 5 = hierarchy/field>,
  ItemIndex: <index into the expanded field list>,
  DestinationAxis: <-1 = default | 1 = Rows | 4 = Filters>, DestinationAxisPosition: <n>
}
```

`FieldListVersion` and `FieldWellVersion` increment on every operation (observed 1→3→6
and 1→4→8) — they are optimistic-concurrency counters, so a caller must read the
current values rather than assume. **`DestinationAxis` for Columns and Values is not
yet observed**; only default (-1), Rows (1) and Filters (4) are confirmed. Do not guess
the other two — capture them.

**Creating a PivotTable does not use a bespoke EWA method at all.** It goes through
`ExecuteRichApiRequest`, which tunnels the Office.js object model over the same
endpoint as a `ProcessQuery` batch. That is a far better surface to build on than
reverse-engineered RPCs, because it is the documented Excel JS API:

```
ObjectPaths:
  1  root workbook
  3  workbook.Worksheets
  21 workbook.DataConnections
  24 DataConnections.Add(<name>, "OLEDB;Provider=MSOLAP;…;Data Source=pbiazure://api.powerbi.com;
                                  Initial Catalog=<datasetGuid>;…", "Model", "Cube")
  27 Worksheets.GetActiveWorksheet()
  30 <worksheet>.PivotTables
  32 PivotTables.Add(<pivotName>, <ref to 24>, "<Sheet>!<Anchor>")
     ReferencedObjectPathIds: [0, 24, 0]     // arg 1 is an object reference, not a literal
Actions:
  ShowPivotFieldList(true)
```

Two details worth keeping: `Initial Catalog` here is the **plain dataset GUID**, not the
`sobe_wowvirtualserver-<guid>` form that `xl/connections.xml` records; and the envelope
carries add-in identity (`SolutionId`, `CompliantSolutionId`, `InstanceId`,
`MarketplaceType: sdxcatalog`, `AppPermission`, `RequestFlags`) because the capture came
from the Power BI task-pane add-in. Whether a replay needs valid add-in identity, or
whether any values work, is untested.

**Capture procedure (this is the part that is easy to get wrong):** the debugger's
`setAutoAttach` only attaches to child targets that load *after* capture is enabled, so
the order must be `browser_enable_network_capture` → **reload the page** → interact.
Enabling capture against an already-loaded Office frame records nothing and looks
exactly like "there is no such traffic". Verified both ways in the same session.
