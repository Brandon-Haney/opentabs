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

**Decoded — `ApplyFilter`** (pivot page filter), verified end to end 2026-08-06:

```
parameters: {
  Location: { SheetName, NamedObjectName: null,
              FirstRow: 1, FirstColumn: 1, LastRow: 1, LastColumn: 1 },
  IsPivotFilter: true,            // what separates this from a plain-range filter
  FieldId: "6",                   // cacheHierarchy index, as a JSON string
  DataSourceIndex: 1,
  HierarchyLevel: 1,
  AnchorType: 0, ChartId: null, AnchorValue1: -1, AnchorValue2: -1
}
checkedItems: ["12","15","16"]    // member ids, not names; several selects several
```

`Location` is **not** free-form: it addresses the cell showing *that filter's* current
selection, **zero-based**, and the service answers `RetryOutOfSync` for any other cell.
Page filters stack in the rows directly above the pivot body, one per row in declaration
order, separated by a blank row, with the caption in the pivot's own column and the value
in the next one. `pageFilterCell` derives it as
`(anchorRow - 1 - filterCount) + filterIndex` for the row and `anchorCol + 1` for the
column, all zero-based.

**The `filterIndex` term is load-bearing and easy to miss.** Both live pivots are anchored
at `A4` with two page filters, so a derivation from the block's top alone produces `row 1`
for both — which is right for the Sales pivot, whose target is its *second* filter, and
wrong for the PROTracker pivot, whose target is its *first* (`row 0`). One pivot is not
enough to validate this; it took a second one addressing a different filter position.

**`FieldId` is hexadecimal**, upper case, as a string — unlike every other pivot method,
which takes the same id as a plain number. Field 6 encodes as `"6"` in either base, which
is exactly why a decimal id worked on the first pivot tested and then failed on the next,
whose field 14 the service wants as `"E"`.

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
current values rather than assume. `GetPivotFieldManagerData` returns both.

**`DestinationAxis` is a bit-flag enum, now fully observed:**

| Value | Zone |
| --- | --- |
| `1` | Rows |
| `2` | Columns |
| `4` | Filters (page) |
| `8` | Values (data) |
| `0` | Removed — paired with `SourceAxis` set to the zone it left and `SourceAxisPosition` set to its index within that zone |
| `-1` | Default placement (a measure dropped without a target lands in Values) |

`ItemType` is `3` for a measure, `5` for a hierarchy/field, and `0` on a removal.

**A removal reuses the same positive `ItemIndex` the field was added with** — an earlier
note here claimed a negative one, which was wrong. Verified end to end against a live
pivot: removing `Invoice Year` (index 20) from Columns sends
`{SourceAxis: 2, SourceAxisPosition: 0, ItemType: 0, ItemIndex: 20, DestinationAxis: 0}`,
after which `ColumnAxis` comes back empty.

**`dataSourceIndex` is per-pivot, not a constant.** The scorecard's pivots answer to `0`;
a pivot created over the workbook's third connection answers to `2`. Passing the wrong one
fails as a generic out-of-sync error rather than a bad-argument one, so read it from
whatever value a successful `GetPivotFieldManagerData` used rather than assuming.

**`GetPivotFieldManagerData`** (GET) is the key lookup — it returns the field well as
`RowAxis` / `ColumnAxis` / `FilterAxis` / `DataAxis`, each entry carrying `Name` and
`PivotCacheIndex`, plus the current `FieldListVersion` / `FieldWellVersion`:

```
cell={"SheetName","NamedObjectName","FirstRow","FirstColumn"}   // 0-based
dataSourceIndex=<n>  optionalPivotAnchorParameter={"AnchorType":0}  type=1  version=<n>
```

**`PivotCacheIndex` is the `cacheHierarchy` index** — the same number
`inspect_data_model` already parses out of the pivot cache, and the same number
`ApplyFilter` wants as `FieldId`. Confirmed on live data: `CMTD Sales` →
`PivotCacheIndex 307` matches the OOXML `hierarchy="307"`, and a filter field →
`PivotCacheIndex 6` matches the `FieldId: "6"` a captured `ApplyFilter` sent. So field
resolution does not need the lazily-grouped field list at all; the workbook package
already carries the ids.

**`GetPivotFilterData`** (GET) returns the member tree for one filter field, which is
what turns a member *name* into the numeric id `ApplyFilter`'s `checkedItems` takes:

```
cell={…}  dataSourceIndex=<n>  optionalPivotAnchorParameter={"AnchorType":0,"ChartId":null,"AnchorValue1":-1,"AnchorValue2":-1}
fieldId="<n>"        // JSON-quoted, i.e. the literal characters "6"
parentId=-1  needConnect=true
```

Response: `Result.PivotFilterItemsList.PivotFilterItems` — a tree whose root is the
"All" member (`Id: 1`) with the real members nested under its own `PivotFilterItems`,
each `{ DisplayString, Id, State, LeafItem }`. `State` is `0` selected, `1` not selected,
`2` partially selected. `ApplyFilter` then takes `checkedItems: ["<Id>"]`.

**Ids are assigned per filter tree and follow the model's ordering, not the displayed
order.** On one live month filter `JUN - 2026` is 12, `JUL - 2026` is 15 and `SEP - 2025`
is 18; on a second pivot over a different model the *same months* are 4, 3 and 13. So an
id is meaningless outside the tree it came from and cannot be inferred from position,
cached across pivots, or reused after the filter changes. Anything that guesses selects
the wrong member and reports success.

That is why `set_pivot_filter` takes ids from `get_pivot_filter_members` rather than
accepting a member name it would resolve itself: a tool gets one bridge call, so the
lookup cannot be folded into the write.

`parentId` must be `-1`; passing a member id to fetch a subtree answers
`UnexpectedPivotError`.

**`PftTokenMissing` is a user-consent gate, not a bug.** Both filter methods answer
`PftTokenMissing` ("Please refresh the page") until the workbook has been allowed to query
its external data *in that session*. Excel asks for this with the **"Query and Refresh
Data"** dialog — "the query to get the data might be unsafe so you should only refresh the
workbook if you trust its source" — and records the answer with:

```
POST SetParameters
  parameters: []          setParametersAtOpen: true
  confirmation: 1243883867      // MessageId of the prompt
  confirmationChoice: true      // the user pressed Yes
```

Once the user answers, every pivot operation works for the rest of the session — the gate
covers `ApplyPivot` as well as the filter methods, so field placement is blocked by it
too. It is session-wide rather than per-pivot, and any reload — including the plugin's own
reauthenticate path — discards it.

**Replaying `SetParameters` does not grant it.** Tested directly, with the captured
arguments byte-for-byte and with `setParametersAtOpen` both true and false: the call
answers `Errors: []`, bumps the workbook revision, and changes nothing — the filter
methods stay blocked. It is the *answer* to a prompt the client raises, not a grant that
can be issued on its own, and nothing in the captured stream shows the server raising a
pending confirmation for it to satisfy. A tool built on it was written, tested, and
removed rather than shipped, because it reported success while silently doing nothing.

So this is a genuine boundary, not a policy choice: the consent has to come from the user
in Excel's own UI. Which is arguably the right outcome — the prompt asks whether an
external data source is trustworthy — but it is worth recording that it was tested rather
than assumed.

Things that look like the cause and are not, each tested directly — worth recording so the
next reader does not spend the time again:

- **Session freeze.** `TimeFromLastEcsFreeze` reads `-2` on every successful call and a
  large value on the failures, which looks conclusive and is not: after a refresh the
  counter returns to `-2` while the error persists. Pure correlation.
- **A page reload**, by navigation or by reauthenticate — these *remove* the consent.
- **`Refresh`** of the data connection.
- **`GetPivotFieldListData`**, the obvious candidate for what a dropdown loads first.
- **`needConnect`**, both values.
- **A `ViewportStateChange` context patch** naming the pivot's sheet.

It was found by capturing the app's own dropdown interaction across the *whole* RPC stream.
Earlier captures were filtered to `*Filter*` method names, which hid `SetParameters`
entirely — a filter narrow enough to protect the user's data was also narrow enough to
hide the answer.

**Solved — `GetPivotFilterData` replays cleanly.** It was blocked for a while behind an
error that read as a session problem and was not one. Three arguments were wrong at once,
and because each alone still failed, testing them one at a time only ever produced the
same generic `RetryOutOfSync` ("Please try again"):

| Argument | Wrong | Right |
| --- | --- | --- |
| `dataSourceIndex` | `0` | `1` — external sources are one-based here, as with `Refresh` |
| `cell` | the pivot anchor, zero-based | the page-filter block's top-left, **one-based** |
| `fieldId` | `6` | `"6"` — JSON-encoded, quotes included |

`needConnect` turned out to be irrelevant; both values behave identically. Two lessons
worth keeping. First, **this service reports every bad argument as `RetryOutOfSync`**, so
the error text carries no signal about which one is wrong and guessing is unbounded —
capture the app making the real call and diff it. Second, a method that succeeds is not
evidence the shared plumbing is right: `GetPivotFieldManagerData` passes only numbers and
objects, so it never exercised the string-encoding path that was broken for everyone.

**Every GET parameter on these services is JSON-encoded, strings included.** The app sends
`currentSheetName="Sales PowerBI"` and `fieldId="6"` with the quote characters in the
query string. `buildQueryUrl` used to use `String(value)` for scalars, which silently
dropped the quotes from string arguments — numbers, booleans and null encode identically
either way, which is why nothing noticed until the first method with a string parameter.

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
from the Power BI task-pane add-in.

**The pane creates the destination sheet in a separate, earlier batch** —
`Worksheets.Add()` followed by `GetActiveCell`, with `AutoKeepReference: true` — rather
than folding it into the batch above. Combining the two is what made a hand-rolled
attempt fail with `InvalidSheetName`: the pivot batch runs against a session context
captured before the new sheet existed. `create_pivot_from_connection` therefore requires
the worksheet to exist already, and leaves creating it to `add_worksheet`.

**"Insert Table" is the same mechanism with a different command, and is the more useful
of the two.** The connection's *command* is a DAX query and its command type is the
number `4`, where a PivotTable connection sends the strings `"Model"` / `"Cube"`:

```
ObjectPaths:
  18 workbook.DataConnections
  21 DataConnections.Add(<name>, "<same connection string>",
                         "EVALUATE ROW(\"CMTD_EBITDA\", 'Measure Table'[CMTD EBITDA])", 4)
  23 Application
  26 workbook.Tables
  28 Tables.AddQueryTable(<ref to 21>, "A1")   ReferencedObjectPathIds: [21, 0]
  32 <table>.Worksheet
Actions:
  SuspendScreenUpdatingUntilNextSync on Application
  Style = "TableStyleMedium7" on the new table
  Activate on its worksheet
```

So an inserted table is **a native Excel table bound live to an arbitrary DAX query**,
refreshable like any other connection — not a paste of values. That makes it a better
route for "get Power BI data into a sheet" than writing `execute_dax` output into cells,
which produces numbers that go stale with nothing to indicate it. `insert_powerbi_table`
builds on this.

**`RefreshAllNew` refreshes every connection at once**, and takes only
`{periodic: false, refreshOnOpen: false}` — no per-session AAD token, unlike the
single-connection `Refresh`. It is what Data > Refresh All sends. `RefreshAll` answers 401
because it does not exist, which reads like an authorisation failure and is not one.

**Replay verified 2026-08-06** — a PivotTable was created and a measure placed into it
entirely through the bridge, reusing the add-in identity values verbatim. Four things
had to be right, and each failed distinctly until it was:

1. **`WorksheetCollection.getItem` does not exist** in this Excel version — it answers
   `ApiNotFound`. Use `GetActiveWorksheet`, and select the target sheet through the
   envelope's `ActiveCell` / `SheetMultiRange`, which is what the add-in does. Verified:
   the call returned the intended sheet's id.
2. **A destination whose sheet name contains a space must be quoted** (`'My Sheet'!A3`).
   Unquoted answers `InvalidArgument`. Simpler still: avoid spaces.
3. **The donor context can be stale relative to the workbook.** Creating the sheet
   through Microsoft Graph and then immediately replaying against a donor harvested
   earlier fails with `InvalidSheetName` — "the worksheet you requested does not exist" —
   because the reused context predates the sheet. Reloading the tab re-syncs the frame
   and the next donor carries a current revision. **Any tool that mixes a Graph
   structural change with a bridge call has to account for this**; it is not specific to
   pivots.
4. Errors surface in two different places. A RichApi failure is nested in
   `Result.ResponseBody[0].Error` as `{Code, Message, Location, ActionIndex,
   HttpStatusCode}` while the outer `EwaResult.Errors` is *empty* and its status is 200;
   an EWA-layer failure appears in `EwaResult.Errors` with `Result` null. A caller must
   check both or it will read a failure as success.

**Side effect to design around:** `DataConnections.Add` creates a connection every time,
de-duplicating by appending a numeral (`SMPOSCompanyOwnedStoreSal1`) rather than reusing
an existing connection of the same name. Repeated attempts therefore accumulate unused
connections in the workbook.

**A workbook connection cannot be deleted from anywhere reachable here.**
`DataConnectionCollection.getCount` — and by extension item access and deletion — answers
`ApiNotFound`; Graph has no connection surface at any version; and Excel for the web only
*lists* them (Data → Queries & Connections shows the list with no delete affordance).
Removing one requires the Excel **desktop** application. Confirmed against a live
workbook. Any tool that can create a connection is therefore taking an action the user
cannot undo without leaving the browser, and must say so rather than implying the
web UI can clean up after it.

**A count read back through Graph lags the live session.** `inspect_data_model` reads the
saved package, so a connection created moments earlier may not appear yet — a check run
too soon reports "no residue" when residue exists. Verified the hard way: four failed
attempts looked clean immediately afterwards and had in fact each left a connection
behind. Re-read after the workbook has saved, or treat an immediate count as a lower
bound.

**Capture procedure (this is the part that is easy to get wrong):** the debugger's
`setAutoAttach` only attaches to child targets that load *after* capture is enabled, so
the order must be `browser_enable_network_capture` → **reload the page** → interact.
Enabling capture against an already-loaded Office frame records nothing and looks
exactly like "there is no such traffic". Verified both ways in the same session.

**The capture buffer does not survive an idle service worker.** `network-capture.ts` keeps
it in a module-level `Map`, and Chrome evicts an MV3 service worker after roughly thirty
seconds without activity — taking the buffer and the debugger attachment with it, silently.
A capture that spans a human doing manual UI work will therefore come back empty, which is
indistinguishable from the person not having done anything. It cost several rounds of
asking Brandon to repeat himself before the cause was found, and once led to telling him he
had not performed an action he had in fact performed.

Until the buffer is persisted (`chrome.storage.session` would survive worker restarts),
the workaround is to poll something cheap every ~20 seconds for the duration of the
capture: any tool call reaches the worker and resets its idle timer. Traffic on the
captured tab also keeps it alive, so the vulnerable window is the gap between arming the
capture and the first request. **Verify the capture is live before asking a human to act** —
firing one throwaway request and confirming it lands is a few seconds and rules this out
entirely.
