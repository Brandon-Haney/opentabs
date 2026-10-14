import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { searchUnidentifiedCredits as searchCredits } from '../rgn.js';
import { rgnCriteriaShape, unidentifiedCreditSchema } from './rgn-schemas.js';

export const searchUnidentifiedCredits = defineTool({
  name: 'search_unidentified_credits',
  displayName: 'Search Unidentified Credits',
  description:
    'Search DC credits that have not been matched to an RGN — the Unidentified Credit Issuance report behind the ' +
    'RGN Reconciliation Dashboard. A credit here is money the DC issued that is not applied to the RGN it pays ' +
    'for, so an RGN still pending credit may have its credit sitting in this list (compare return type, date and ' +
    'amount). Dates filter on the credit issue date.',
  summary: 'Search DC credits not yet matched to an RGN',
  icon: 'circle-help',
  group: 'Returns',
  input: z.object(rgnCriteriaShape),
  output: z.object({
    credits: z.array(unidentifiedCreditSchema).describe('Unmatched credits, as the report lists them'),
  }),
  handle: async (params, context) => ({
    credits: await searchCredits(params, message => context?.reportProgress({ message })),
  }),
});
