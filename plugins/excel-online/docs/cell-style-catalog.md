# Named cell-style catalog (EWA `ApplyNamedCellStyle`)

`apply_cell_style` drives Excel Online's internal `ApplyNamedCellStyle` method
through the frame bridge. Its request body is
`{ context (+ ViewportStateChange selection), styleIndex, selectedRanges }`,
where `styleIndex` selects one of the workbook's built-in named cell styles.

The `styleIndex` values are Excel Online's own — **not** the ECMA-376
`builtinId`. They were read from a live `GetNamedCellStylesEx` response
(`d.Result[]` of `{ StyleName, StyleCategory, StyleIndex }`) and cross-checked
against captured `ApplyNamedCellStyle` requests. The read method
`GetNamedCellStylesEx` (op 542) populates the gallery; `ApplyNamedCellStyle`
(op 216) applies a style. Style names are localized server-side, so the catalog
is only available at runtime from the server, not from the client bundle.

## Full catalog (49 built-in styles)

| StyleIndex | StyleName | Category |
| --- | --- | --- |
| 0 | Normal | Good/Bad/Neutral |
| 40 | Good | Good/Bad/Neutral |
| 41 | Bad | Good/Bad/Neutral |
| 42 | Neutral | Good/Bad/Neutral |
| 16 | Hyperlink | Data and Model |
| 29 | Followed Hyperlink | Data and Model |
| 43 | Input | Data and Model |
| 44 | Output | Data and Model |
| 45 | Calculation | Data and Model |
| 46 | Linked Cell | Data and Model |
| 47 | Check Cell | Data and Model |
| 48 | Warning Text | Data and Model |
| 49 | Note | Data and Model |
| 50 | Explanatory Text | Data and Model |
| 35 | Title | Titles and Headings |
| 36 | Heading 1 | Titles and Headings |
| 37 | Heading 2 | Titles and Headings |
| 38 | Heading 3 | Titles and Headings |
| 39 | Heading 4 | Titles and Headings |
| 51 | Total | Titles and Headings |
| 52–75 | Accent1..Accent6 + 20/40/60% tints | Themed Cell Styles |
| 30 | Comma | Number Format |
| 31 | Comma [0] | Number Format |
| 32 | Currency | Number Format |
| 33 | Currency [0] | Number Format |
| 34 | Percent | Number Format |

Themed accents, in `styleIndex` order: Accent1 52, 20% 53, 40% 54, 60% 55;
Accent2 56–59; Accent3 60–63; Accent4 64–67; Accent5 68–71; Accent6 72–75.

## Number-format styles are not exposed

The five **Number Format** styles (indices 30–34) are decoded here for the
record but are **not** exposed by `apply_cell_style`. Applying one through
`ApplyNamedCellStyle` does not set the style's number format cleanly — a live
test of `Currency` (32) left a `Comma [0]` number format instead of the
currency format. Since `set_number_format` already applies currency, percent,
and comma formats reliably through the workbook API, there is nothing to gain
by routing them through the bridge, so they are omitted.
