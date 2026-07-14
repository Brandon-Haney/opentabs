import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges, viewportSelection } from '../bridge.js';

/**
 * Built-in named cell styles mapped to the `styleIndex` the EWA
 * `ApplyNamedCellStyle` method expects. The indices are Excel Online's own
 * (not the ECMA-376 builtinId), read straight from a live `GetNamedCellStylesEx`
 * response (`d.Result[].StyleIndex`) and cross-checked against captured
 * `ApplyNamedCellStyle` requests. Keys are friendly names; the themed accents
 * follow `accent{n}` / `accent{n}_{20|40|60}` for the tint variants.
 *
 * The five "Number Format" gallery styles (Comma, Comma [0], Currency,
 * Currency [0], Percent) are intentionally omitted: applying them through
 * `ApplyNamedCellStyle` does not set the style's number format cleanly, and
 * `set_number_format` already covers currency/percent/comma formatting through
 * the workbook API, so there is nothing to gain by routing them here.
 */
const STYLES = {
  // Good, Bad and Neutral
  normal: 0,
  good: 40,
  bad: 41,
  neutral: 42,
  // Data and Model
  calculation: 45,
  check_cell: 47,
  explanatory_text: 50,
  input: 43,
  linked_cell: 46,
  note: 49,
  output: 44,
  warning_text: 48,
  hyperlink: 16,
  followed_hyperlink: 29,
  // Titles and Headings
  title: 35,
  heading_1: 36,
  heading_2: 37,
  heading_3: 38,
  heading_4: 39,
  total: 51,
  // Themed Cell Styles
  accent1: 52,
  accent1_20: 53,
  accent1_40: 54,
  accent1_60: 55,
  accent2: 56,
  accent2_20: 57,
  accent2_40: 58,
  accent2_60: 59,
  accent3: 60,
  accent3_20: 61,
  accent3_40: 62,
  accent3_60: 63,
  accent4: 64,
  accent4_20: 65,
  accent4_40: 66,
  accent4_60: 67,
  accent5: 68,
  accent5_20: 69,
  accent5_40: 70,
  accent5_60: 71,
  accent6: 72,
  accent6_20: 73,
  accent6_40: 74,
  accent6_60: 75,
} as const;

type StyleName = keyof typeof STYLES;

const STYLE_NAMES = Object.keys(STYLES) as [StyleName, ...StyleName[]];

export const applyCellStyle = defineTool({
  name: 'apply_cell_style',
  displayName: 'Apply Cell Style',
  description:
    "Apply a built-in named cell style to a range — Excel's one-click Cell Styles gallery (Normal, Good/Bad/Neutral, " +
    'Titles and Headings like title/heading_1..heading_4/total, the data styles input/output/calculation/check_cell/' +
    'note/warning_text/explanatory_text/linked_cell/hyperlink/followed_hyperlink, and the themed accents accent1..' +
    'accent6 with 20/40/60% tints as accent1_20/accent1_40/accent1_60). A named style sets font, fill, and borders ' +
    'together and stays linked to the theme. For number formatting (currency, percent, comma) use set_number_format. ' +
    "Not available through the standard workbook API — driven through Excel's internal service via the frame bridge.",
  summary: 'Apply a built-in named cell style',
  icon: 'palette',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation to style (e.g., "A1:E1")'),
    style: z
      .enum(STYLE_NAMES)
      .describe('Built-in cell style name (e.g., "good", "heading_1", "total", "accent1", "accent1_20")'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge(
      'ApplyNamedCellStyle',
      {
        styleIndex: STYLES[params.style],
        selectedRanges: selectedRanges(params.worksheet, params.address),
      },
      { contextPatch: viewportSelection(params.worksheet, params.address) },
    ),
});
