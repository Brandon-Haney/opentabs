import { z } from 'zod';
import { RGN_STAGE_NAMES } from '../rgn.js';
import { isoDateSchema } from './schemas.js';

const AMOUNT = 'in US dollars; null when blank';

export const rgnStageSchema = z
  .enum(RGN_STAGE_NAMES)
  .describe(
    'Reconciliation stage: pending_credit (sent, no credit yet), osd_variance (credit differs from request, ' +
      'with the DC reason), reconciled, reconciled_with_financial_adjustment, ' +
      'reconciled_without_financial_adjustment (the reconciled stages cover the last 60 days)',
  );

export const rgnCriteriaShape = {
  store: z.string().optional().describe('Store number (e.g., "ATL081"). Omit for every store the user can see'),
  part_number: z
    .string()
    .optional()
    .describe('Fusion item number (e.g., "8229CORE-BAT"); returns whole RGNs that contain the part'),
  rgn_number: z.string().optional().describe('RGN number (e.g., "ATL081-100310")'),
  return_type: z
    .string()
    .optional()
    .describe('Return type, by its code (e.g., "CH") or full name (e.g., "CH - Battery Core Return")'),
  date_from: isoDateSchema.optional().describe('First RGN date to include, YYYY-MM-DD'),
  date_to: isoDateSchema.optional().describe('Last RGN date to include (inclusive), YYYY-MM-DD'),
};

export const rgnSchema = z.object({
  stage: rgnStageSchema,
  rgn_number: z.string().describe('RGN number; also the number of its Payables debit memo'),
  rgn_date: z.string().describe('RGN date, YYYY-MM-DD'),
  return_type: z.string().describe('Return type (e.g., "CH - Battery Core Return")'),
  store: z.string().describe('Store number'),
  division: z.string().describe('Division'),
  store_dc: z.string().describe('DC the store returns to'),
  quantity: z.number().nullable().describe('Units on the RGN in total (whole RGN, not one part)'),
  age_days: z.number().nullable().describe('Days since the RGN date'),
  credit_requested: z.number().nullable().describe(`Credit requested for the whole RGN, ${AMOUNT}`),
  credit_received: z.number().nullable().describe(`Credit received from the DC, ${AMOUNT}`),
  variance: z.number().nullable().describe(`Requested minus received, ${AMOUNT}`),
  variance_percent: z.number().nullable().describe('Variance as a percentage of the request'),
  overage_shortage: z
    .string()
    .describe('Overage or Shortage when the DC counted a different quantity; empty otherwise'),
  last_credit_received_date: z.string().describe('Date of the last credit received, YYYY-MM-DD; empty when none'),
  storefront_status: z
    .string()
    .describe('Storefront status or the DC’s reason (e.g., a decline reason); empty when none'),
  status: z.string().describe('Stage as the report names it'),
  invoice_id: z.string().describe('Internal id of the RGN’s Payables debit memo; empty when the report gave none'),
});

export const unidentifiedCreditSchema = z.object({
  credit_issue_number: z.string().describe('Number of the DC credit'),
  credit_issue_date: z.string().describe('Date the credit was issued, YYYY-MM-DD'),
  return_type: z.string().describe('Return type the credit is for'),
  store: z.string().describe('Store number'),
  division: z.string().describe('Division'),
  store_dc: z.string().describe('DC that issued the credit'),
  quantity: z.number().nullable().describe('Units credited'),
  age_days: z.number().nullable().describe('Days since the credit was issued'),
  credit_received: z.number().nullable().describe(`Credit amount, ${AMOUNT}`),
  credit_applied: z.number().nullable().describe(`Amount applied to RGNs so far, ${AMOUNT}`),
  variance: z.number().nullable().describe(`Amount not yet applied, ${AMOUNT}`),
  variance_percent: z.number().nullable().describe('Unapplied share as a percentage'),
  last_credit_received_date: z.string().describe('As the report shows it; often NA'),
  storefront_status: z.string().describe('Storefront status or reason; empty when none'),
  status: z.string().describe('Stage as the report names it'),
  invoice_id: z.string().describe('Internal id of the credit’s Payables document; empty when the report gave none'),
});

export const returnBankPartSchema = z.object({
  return_type: z.string().describe('Return type the part is held for'),
  store: z.string().describe('Store number'),
  line_abbreviation: z.string().describe('Product line abbreviation (e.g., BAT)'),
  part_number: z.string().describe('Part number without the line (e.g., 6551RCORE)'),
  item: z.string().describe('Fusion item number: part number and line (e.g., 6551RCORE-BAT)'),
  description: z.string().describe('Part description'),
  quantity: z.number().nullable().describe('Units held'),
  unit_cost: z.number().nullable().describe(`Unit cost, ${AMOUNT}`),
  core_cost: z.number().nullable().describe(`Core cost, ${AMOUNT}`),
  extended_amount: z.number().nullable().describe(`Quantity times cost, ${AMOUNT}`),
});

export const rgnLineSchema = z.object({
  line_abbreviation: z.string().describe('Product line abbreviation (e.g., BAT, BAV)'),
  part_number: z.string().describe('Part number without the line (e.g., 8229CORE)'),
  item: z.string().describe('Fusion item number: part number and line (e.g., 8229CORE-BAT)'),
  description: z.string().describe('Part description'),
  requested_quantity: z.number().nullable().describe('Units requested on the RGN'),
  requested_cost: z.number().nullable().describe(`Requested unit cost, ${AMOUNT}`),
  requested_core_cost: z.number().nullable().describe(`Requested unit core cost, ${AMOUNT}`),
  requested_amount: z.number().nullable().describe(`Requested total for the line, ${AMOUNT}`),
  overage_shortage: z.string().describe('Overage or Shortage the DC counted; empty when none'),
  credited_quantity: z.number().nullable().describe('Units the DC credited'),
  credited_cost: z.number().nullable().describe(`Credited unit cost, ${AMOUNT}`),
  credited_core_cost: z.number().nullable().describe(`Credited unit core cost, ${AMOUNT}`),
  credited_amount: z.number().nullable().describe(`Credited total for the line, ${AMOUNT}`),
  variance: z.number().nullable().describe(`Requested minus credited, ${AMOUNT}`),
});

export const rgnTotalsSchema = z.object({
  requested_quantity: z.number().nullable(),
  requested_amount: z.number().nullable(),
  credited_quantity: z.number().nullable(),
  credited_amount: z.number().nullable(),
  variance: z.number().nullable(),
});

export const printedRgnSchema = z.object({
  rgn_number: z.string().describe('RGN number'),
  rgn_date: z.string().describe('RGN date, YYYY-MM-DD'),
  store: z.string().describe('Store number'),
  return_type: z.string().describe('Return type'),
  reference: z.string().describe('Reference on the RGN; empty when none'),
  notes: z.string().describe('Notes on the RGN; empty when none'),
  description: z.string().describe('Description on the RGN; empty when none'),
  lines: z
    .array(rgnLineSchema)
    .describe('Every part on the RGN, in the order the print report lists them (not the debit memo’s line order)'),
  totals: rgnTotalsSchema.nullable().describe('Totals row of the RGN; null when the report gave none'),
});
