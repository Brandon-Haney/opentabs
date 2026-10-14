import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { dashboardCounts } from '../rgn.js';

const count = (tile: string) => z.number().nullable().describe(`${tile}; null when the dashboard showed no count`);

export const getRgnDashboard = defineTool({
  name: 'get_rgn_dashboard',
  displayName: 'Get RGN Dashboard',
  description:
    'Read the RGN Reconciliation Dashboard’s counts: parts in the return bank, RGNs at each reconciliation ' +
    'stage, and unmatched DC credits. A quick health check of a store’s returns, optionally for one part or ' +
    'return type; use search_rgns, search_return_bank and search_unidentified_credits for the rows behind a count.',
  summary: 'Count RGNs and credits at each reconciliation stage',
  icon: 'layout-dashboard',
  group: 'Returns',
  input: z.object({
    store: z.string().optional().describe('Store number (e.g., "ATL081"). Omit for every store the user can see'),
    part_number: z.string().optional().describe('Fusion item number (e.g., "8229CORE-BAT")'),
    return_type: z.string().optional().describe('Return type, by code or name (e.g., "CH")'),
  }),
  output: z.object({
    return_bank: count('Parts waiting in the return bank'),
    pending_store_manager_review: count('RGNs waiting for store manager review'),
    pending_credit: count('RGNs sent, waiting for DC credit'),
    osd_variance: count('RGNs whose credit differs from the request (OS&D variance)'),
    unidentified_credit: count('DC credits not matched to an RGN'),
    reconciled: count('RGNs reconciled in the last 60 days'),
    reconciled_with_financial_adjustment: count('Reconciled RGNs with a financial adjustment, last 60 days'),
    reconciled_without_financial_adjustment: count('Reconciled RGNs without a financial adjustment, last 60 days'),
  }),
  handle: async (params, context) => dashboardCounts(params, message => context?.reportProgress({ message })),
});
