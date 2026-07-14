import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges } from '../bridge.js';

/**
 * Bitmask the web client sends with `ApplyHyperlink` describing which cell modes
 * the operation may set. Captured constant from the live UI — the server rejects
 * the call without it.
 */
const ALLOWED_SET_CELL_MODES = 123;

/**
 * Build the `ApplyHyperlink` options. `location` is the link target; `displayText`
 * is the text shown in the cell (falls back to the URL). `isDelete: true` removes
 * an existing hyperlink from the range instead of adding one.
 */
export const buildSetHyperlinkOptions = (
  worksheet: string,
  address: string,
  url: string,
  displayText: string | undefined,
  remove: boolean,
): Record<string, unknown> => ({
  selectedRanges: selectedRanges(worksheet, address),
  displayText: displayText ?? url,
  location: url,
  isDelete: remove,
  isFill: false,
  allowedSetCellModes: ALLOWED_SET_CELL_MODES,
});

export const setHyperlink = defineTool({
  name: 'set_hyperlink',
  displayName: 'Set Hyperlink',
  description:
    'Add or remove a native hyperlink on a range. Provide the target url and optional display text (the ' +
    'text shown in the cell; defaults to the url). Set remove=true to delete an existing hyperlink from the ' +
    "range. Native hyperlinks are not available through the standard workbook API — driven through Excel's " +
    'internal service via the frame bridge.',
  summary: 'Add or remove a native cell hyperlink',
  icon: 'link',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation to hyperlink (e.g., "A1" or "A1:A5")'),
    url: z.string().describe('The hyperlink target URL'),
    display_text: z.string().optional().describe('Text shown in the cell (defaults to the URL)'),
    remove: z.boolean().optional().describe('Remove an existing hyperlink from the range instead of adding one'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge(
      'ApplyHyperlink',
      buildSetHyperlinkOptions(
        params.worksheet,
        params.address,
        params.url,
        params.display_text,
        params.remove ?? false,
      ),
    ),
});
