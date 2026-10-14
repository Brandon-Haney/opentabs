import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { searchReturnBank as searchBank } from '../rgn.js';
import { returnBankPartSchema } from './rgn-schemas.js';

export const searchReturnBank = defineTool({
  name: 'search_return_bank',
  displayName: 'Search Return Bank',
  description:
    'List parts waiting in the store’s return bank — set aside for return to the DC but not yet on an RGN — from ' +
    'the Return Bank report behind the RGN Reconciliation Dashboard. Each part comes with its return type, ' +
    'quantity and cost.',
  summary: 'List parts waiting to go out on an RGN',
  icon: 'package',
  group: 'Returns',
  input: z.object({
    store: z.string().optional().describe('Store number (e.g., "ATL081"). Omit for every store the user can see'),
    part_number: z.string().optional().describe('Part number as the report lists it (e.g., "6551RCORE")'),
    line_abbreviation: z.string().optional().describe('Product line abbreviation (e.g., "BAT")'),
    return_type: z.string().optional().describe('Return type, by code or name (e.g., "CH")'),
  }),
  output: z.object({
    parts: z.array(returnBankPartSchema).describe('Parts in the return bank, as the report lists them'),
  }),
  handle: async (params, context) => ({
    parts: await searchBank(params, message => context?.reportProgress({ message })),
  }),
});
