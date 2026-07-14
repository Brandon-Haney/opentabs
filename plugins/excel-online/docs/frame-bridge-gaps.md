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

`add_conditional_format` covers every operator reachable from Excel's quick menus
(greater/less/between/equal, text contains, duplicates, top/bottom, above/below
average) plus all data-bar, color-scale, and icon-set style presets. It does **not**
yet cover the four operators that only exist in the **New Rule → "Format only cells
that contain" → Cell Value** dropdown:

- Greater than or equal to (≥)
- Less than or equal to (≤)
- Not between
- Not equal to

These are not in the client's quick-menu command map (`Ha.cMd`), so their wire
`Command` codes are unknown. The unused codes in the observed 1–65 range are
`14, 60, 61, 63, 64` — likely candidates, but unconfirmed. The RuleEditor pane
component that owns this dropdown was not locatable among the conditional-formatting
chunks (there is no CF-specific dialog/editor chunk; the pane renders through a
shared React task-pane chunk).

**To resolve:** either (a) a single capture round — open New Rule, pick each of the
four operators, apply, and read the `Command` from the `AddConditionalFormattingRule`
request; or (b) locate the React task-pane chunk that defines
`ConditionalFormatting.RuleEditor.CellValueDropdown` and read its option→command map.

## 2. Conditional formatting — `date_occurring` time periods

The "A Date Occurring" highlight rule (`Command 6`) is wired but not exposed, because
its `TimePeriodType` sub-enum (yesterday / today / tomorrow / last 7 days / last week /
this week / next week / last month / this month / next month) is undecoded — it lives
in the same unreachable RuleEditor pane chunk. The request field name (`TimePeriodType`)
is confirmed; only the integer values are missing.

**To resolve:** capture one `date_occurring` rule per period, or decode the pane chunk.

## 3. Data validation — walled at the ownership layer (not a decode gap)

`add_data_validation` was built and its payload shape is correct (it reaches the
semantic layer), but `CreateOrEditDataValidation` returns
`DataValidationEditStateChangedError` under out-of-band replay across three verified
approaches (raw donor, prep + state-merge, and a `ViewportStateChange` selection
patch). Unlike conditional formatting, the data-validation dialog's edit-state is
owned by the live Office client; an out-of-band commit is treated as a competing
participant ("another user has made changes"). This is a runtime ownership barrier,
**not** a payload or protocol decode problem, so bundle research will not unblock it.
The tool was removed rather than shipped broken. Reaching data validation would
require driving the actual DV dialog in the page (owning its edit-state), not the
direct-replay bridge.
