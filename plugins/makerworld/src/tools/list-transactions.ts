import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { mapTransaction, type RawTransaction, transactionSchema } from './schemas.js';

interface RawTransactionList {
  total?: number;
  totalIncome?: number;
  totalExpense?: number;
  totalRegularIncome?: number;
  totalRegularExpense?: number;
  totalExclusiveIncome?: number;
  totalExclusiveExpense?: number;
  hits?: RawTransaction[];
}

export const listTransactions = defineTool({
  name: 'list_transactions',
  displayName: 'List Point Transactions',
  description:
    'List the point ledger — every point-earning and point-spending event, newest first. Each entry carries the model or print profile that produced it, the regular/exclusive split, and the calendar date the reward was earned for, which makes this the source for per-model earnings attribution and for projecting future income. Lifetime income and expense totals are returned alongside the page. Paginate with offset and limit; the total field reports how many entries exist.',
  summary: 'List point earning and spending history',
  icon: 'receipt',
  group: 'Points',
  input: z.object({
    filter: z.enum(['all', 'income', 'expenses']).optional().describe('Which entries to return (default "all")'),
    offset: z.number().int().min(0).optional().describe('Number of entries to skip (default 0)'),
    limit: z.number().int().min(1).max(100).optional().describe('Entries per page (default 20, max 100)'),
  }),
  output: z.object({
    transactions: z.array(transactionSchema).describe('Ledger entries, newest first'),
    total: z.number().describe('Total number of ledger entries available'),
    total_income: z.number().describe('Lifetime points earned'),
    total_expense: z.number().describe('Lifetime points spent'),
    total_exclusive_income: z.number().describe('Lifetime exclusive points earned'),
    total_exclusive_expense: z.number().describe('Lifetime exclusive points spent'),
  }),
  handle: async params => {
    const data = await api<RawTransactionList>('point-service', '/point-bill/my', {
      query: {
        filter: params.filter ?? 'all',
        offset: params.offset ?? 0,
        limit: params.limit ?? 20,
      },
    });

    return {
      transactions: (data.hits ?? []).map(mapTransaction),
      total: data.total ?? 0,
      total_income: data.totalIncome ?? 0,
      total_expense: data.totalExpense ?? 0,
      total_exclusive_income: data.totalExclusiveIncome ?? 0,
      total_exclusive_expense: data.totalExclusiveExpense ?? 0,
    };
  },
});
