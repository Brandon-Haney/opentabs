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

**Apply index vs. catalog index.** For every style except the five Number
Format styles, the `styleIndex` sent to `ApplyNamedCellStyle` equals the
catalog `StyleIndex`. The five Number Format styles apply at **catalog index +
1** — a captured click of each sent one higher than its catalog value and
produced exactly its number format (Comma catalog 30 → apply 31, Comma [0]
31 → 32, Currency 32 → 33, Currency [0] 33 → 34, Percent 34 → 35). `apply_cell_style`
stores the verified apply indices.

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

## Number-format styles (apply at catalog index + 1)

The five **Number Format** styles are exposed by `apply_cell_style` at their
verified apply indices, which are one higher than their catalog `StyleIndex`:

| Style | Catalog StyleIndex | Apply styleIndex | Resulting number format |
| --- | --- | --- | --- |
| Comma | 30 | 31 | `_(* #,##0.00_);…` |
| Comma [0] | 31 | 32 | `_(* #,##0_);…` |
| Currency | 32 | 33 | `_($* #,##0.00_);…` |
| Currency [0] | 33 | 34 | `_($* #,##0_);…` |
| Percent | 34 | 35 | `0%` |

An earlier attempt used the catalog index directly (`Currency` = 32) and got a
`Comma [0]` format, which is exactly what apply index 32 produces — the source
of the off-by-one. `set_number_format` remains the tool for setting a direct
number format that is not a named style.
