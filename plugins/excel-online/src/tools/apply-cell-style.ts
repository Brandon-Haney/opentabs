import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges, viewportSelection } from '../bridge.js';

/**
 * Built-in named cell styles mapped to the `styleIndex` the EWA
 * `ApplyNamedCellStyle` method expects. The indices are Excel Online's own
 * (not the ECMA-376 builtinId) and were confirmed from captured
 * `ApplyNamedCellStyle` requests plus the resulting cell formatting.
 * Keys are friendly names; the themed accents follow `accent{n}` /
 * `accent{n}_{20|40|60}` for the tint variants.
 *
 * The apply index equals the `GetNamedCellStylesEx` catalog `StyleIndex` for
 * every style EXCEPT the five "Number Format" styles (Comma, Comma [0],
 * Currency, Currency [0], Percent): those apply at catalog index + 1 (Comma is
 * catalog 30 but applies as 31, ... Percent catalog 34 applies as 35). The
 * apply indices below are the verified values — a captured click of each style
 * produced exactly its number format.
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
  // Number Format (apply index is catalog index + 1 — see note above)
  comma: 31,
  comma_0: 32,
  currency: 33,
  currency_0: 34,
  percent: 35,
} as const;

type StyleName = keyof typeof STYLES;

const STYLE_NAMES = Object.keys(STYLES) as [StyleName, ...StyleName[]];

export const applyCellStyle = defineTool({
  name: 'apply_cell_style',
  displayName: 'Apply Cell Style',
  description:
    "Apply a built-in named cell style to a range — Excel's one-click Cell Styles gallery (Normal, Good/Bad/Neutral, " +
    'Titles and Headings like title/heading_1..heading_4/total, the data styles input/output/calculation/check_cell/' +
    'note/warning_text/explanatory_text/linked_cell/hyperlink/followed_hyperlink, the themed accents accent1..accent6 ' +
    'with 20/40/60% tints as accent1_20/accent1_40/accent1_60, and the number styles comma/comma_0/currency/' +
    'currency_0/percent). A named style sets font, fill, borders, and/or number format together and stays linked to ' +
    "the theme. Not available through the standard workbook API — driven through Excel's internal service via the " +
    'frame bridge.',
  summary: 'Apply a built-in named cell style',
  icon: 'palette',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation to style (e.g., "A1:E1")'),
    style: z
      .enum(STYLE_NAMES)
      .describe('Built-in cell style name (e.g., "good", "heading_1", "total", "accent1_20", "currency")'),
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
