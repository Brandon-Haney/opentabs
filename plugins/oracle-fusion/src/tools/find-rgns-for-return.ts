import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { printRgn, RGN_STAGE_NAMES, searchRgnStage } from '../rgn.js';
import { rgnLineSchema, rgnSchema } from './rgn-schemas.js';
import { isoDateSchema, shiftIsoDate } from './schemas.js';

/** RGNs one call opens to read their lines; each is a report run of a few seconds. */
const MAX_CANDIDATES = 10;

export const findRgnsForReturn = defineTool({
  name: 'find_rgns_for_return',
  displayName: 'Find RGNs for a Return',
  description:
    'Find the RGN (return goods notice) that carries an item a store returned to the DC, and whether the DC has ' +
    'credited it. The inventory return transaction (search_completed_transactions, source type "Supplier Return ' +
    'Without Receipt Reference") carries no RGN number, so this matches by item and date: it searches every ' +
    'RGN stage for RGNs containing the item dated within days of the return, then reads each candidate’s lines ' +
    'and returns the item’s line. Several returns can go out on one day and several RGNs can carry one part, so ' +
    'every candidate is returned; units are not tracked individually.',
  summary: 'Match a supplier return to the RGNs that carry it',
  icon: 'search',
  group: 'Returns',
  input: z.object({
    item: z.string().min(1).describe('Fusion item number of the returned part (e.g., "8229CORE-BAT")'),
    date: isoDateSchema.describe('Date of the return transaction, YYYY-MM-DD'),
    days: z
      .number()
      .int()
      .min(0)
      .max(14)
      .optional()
      .describe('Days either side of date to accept an RGN (default 0, the same day)'),
    store: z.string().optional().describe('Store number (e.g., "ATL081")'),
    return_type: z
      .string()
      .optional()
      .describe('Return type, by code or name (e.g., "CH"); the return’s locator usually names it (RETURN/CH)'),
  }),
  output: z.object({
    candidates: z
      .array(
        z.object({
          rgn: rgnSchema,
          lines: z.array(rgnLineSchema).describe('The RGN’s lines for the item'),
        }),
      )
      .describe('RGNs dated within the window that contain the item, nearest date first'),
    more_candidates: z
      .number()
      .int()
      .describe(`RGNs that matched but were not opened, beyond the ${MAX_CANDIDATES} nearest; narrow days to see them`),
  }),
  handle: async (params, context) => {
    const report = (message: string) => context?.reportProgress({ message });
    const days = params.days ?? 0;
    const criteria = {
      store: params.store,
      part_number: params.item,
      return_type: params.return_type,
      date_from: shiftIsoDate(params.date, -days),
      date_to: shiftIsoDate(params.date, days),
    };

    const found = [];
    for (const stage of RGN_STAGE_NAMES) {
      report(`Searching ${stage.replace(/_/g, ' ')}`);
      found.push(...(await searchRgnStage(stage, criteria, report)));
    }
    const distance = (rgnDate: string) =>
      Math.abs(Date.parse(`${rgnDate}T00:00:00Z`) - Date.parse(`${params.date}T00:00:00Z`));
    const unique = [...new Map(found.map(rgn => [rgn.rgn_number, rgn])).values()].sort(
      (a, b) => distance(a.rgn_date) - distance(b.rgn_date),
    );

    const item = params.item.trim().toUpperCase();
    const candidates = [];
    for (const [index, rgn] of unique.slice(0, MAX_CANDIDATES).entries()) {
      report(`Reading ${rgn.rgn_number} (${index + 1} of ${Math.min(unique.length, MAX_CANDIDATES)})`);
      const printed = await printRgn(rgn.rgn_number, report);
      candidates.push({ rgn, lines: printed.lines.filter(line => line.item.toUpperCase() === item) });
    }
    return { candidates, more_candidates: Math.max(0, unique.length - MAX_CANDIDATES) };
  },
});
