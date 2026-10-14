import { ToolError } from '@opentabs-dev/plugin-sdk';
import {
  parseReportLabels,
  parseReportRowValue,
  parseReportTable,
  type ReportForm,
  type ReportParams,
  type ReportRow,
  runReport,
} from './bi-publisher.js';
import { formatDate } from './search-page.js';
import type { StatusReporter } from './search-screen.js';

/**
 * RGNs (return goods notices): store returns to the DC and the credit the DC issues for
 * them, read from the custom BI Publisher reports behind the RGN Reconciliation Dashboard
 * (R-077) and the RGN print report (R-442).
 */

const R077 = '/Custom/Reports/GLOBAL/AP/R-077 RGN RECONCILIATION DASHBOARD REPORT/Reports/';

/** The dashboard's detail reports that list RGNs, by the stage of reconciliation they show. */
export const RGN_STAGES = {
  pending_credit: { path: `${R077}Pending Credit Issuance Report.xdo`, label: 'Pending Credit Issuance' },
  osd_variance: { path: `${R077}RGN OSD Variance Report.xdo`, label: 'RGN / OS&D Variance' },
  reconciled: { path: `${R077}Reconciled RGN (0-60 Days) Report.xdo`, label: 'Reconciled RGN (0-60 Days)' },
  reconciled_with_financial_adjustment: {
    path: `${R077}Reconciled RGN With Financial Adj (0-60 Days) Report.xdo`,
    label: 'Reconciled RGN With Financial Adj. (0-60 Days)',
  },
  reconciled_without_financial_adjustment: {
    path: `${R077}Reconciled RGN With No Financial Adj (0-60 Days) Report.xdo`,
    label: 'Reconciled RGN With No Financial Adj. (0-60 Days)',
  },
} as const;

export type RgnStage = keyof typeof RGN_STAGES;
export const RGN_STAGE_NAMES = Object.keys(RGN_STAGES) as [RgnStage, ...RgnStage[]];

const UNIDENTIFIED_CREDITS = `${R077}Unidentified Credit Issuance Report.xdo`;
const RETURN_BANK = `${R077}Return Bank Report.xdo`;
const DASHBOARD = `${R077}RGN Reconciliation Dashboard.xdo`;
const PRINT_RGN = '/Custom/Reports/GLOBAL/AP/R-442 Print RGN Report/R-442 Print RGN Report.xdo';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Finds the value of a list parameter's choice. Return types are listed as "CH - Battery
 * Core Return", so a choice can also be named by the code before the dash.
 */
const choose = (form: ReportForm, param: string, wanted: string | undefined, what: string): string | undefined => {
  if (wanted === undefined || wanted.trim() === '') return undefined;
  const options = form.choices.get(param);
  if (!options) return wanted;
  const target = wanted.trim().toLowerCase();
  for (const [label, value] of options) {
    const lower = label.toLowerCase();
    if (lower === target || lower.startsWith(`${target} - `)) return value;
  }
  throw ToolError.validation(`The report has no ${what} "${wanted}". Choices: ${[...options.keys()].join(', ')}.`);
};

const date = (form: ReportForm, param: string, isoDate: string | undefined): string | undefined =>
  isoDate ? formatDate(isoDate, form.datePatterns.get(param) ?? 'MM/dd/yyyy') : undefined;

/** Criteria shared by the reports that list RGNs or credits. */
export interface RgnCriteria {
  store?: string;
  part_number?: string;
  rgn_number?: string;
  return_type?: string;
  date_from?: string;
  date_to?: string;
}

const rgnParams =
  (criteria: RgnCriteria) =>
  (form: ReportForm): ReportParams => ({
    P_Store_Number: choose(form, 'P_Store_Number', criteria.store, 'store'),
    P_Part_Number: criteria.part_number || undefined,
    P_RGN_Number: criteria.rgn_number || undefined,
    P_Return_Type: choose(form, 'P_Return_Type', criteria.return_type, 'return type'),
    P_From_Date: date(form, 'P_From_Date', criteria.date_from),
    P_To_Date: date(form, 'P_To_Date', criteria.date_to),
  });

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** An amount or quantity as a report shows it ("1,292.00", "-657.72"); null when blank. */
export const reportNumber = (text: string | undefined): number | null => {
  const cleaned = (text ?? '').replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === 'NA') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

/** A report date (MM/dd/yyyy) as YYYY-MM-DD; any other text is returned as shown. */
export const reportDate = (text: string | undefined): string => {
  const match = (text ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : (text ?? '');
};

/** The Payables invoice id a row's link to its debit memo carries, or empty. */
const invoiceIdOf = (row: ReportRow): string =>
  row.links.map(link => link.match(/InvoiceId=(\d+)/)?.[1]).find(Boolean) ?? '';

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** One RGN as the reconciliation reports list it. */
export const mapRgn = (row: ReportRow, stage: RgnStage) => {
  const v = row.values;
  return {
    stage,
    rgn_number: v['RGN Number'] ?? '',
    rgn_date: reportDate(v['RGN Date']),
    return_type: v['Return Type'] ?? '',
    store: v.Store ?? '',
    division: v.Division ?? '',
    store_dc: v['Store DC'] ?? '',
    quantity: reportNumber(v.Quantity),
    age_days: reportNumber(v['Age (Days)']),
    credit_requested: reportNumber(v['Credit Requested in $']),
    credit_received: reportNumber(v['Credit Received in $']),
    variance: reportNumber(v['Variance in $']),
    variance_percent: reportNumber(v['Variance %']),
    overage_shortage: v['Overage / Shortage'] ?? '',
    last_credit_received_date: reportDate(v['Last Credit Received Date']),
    storefront_status: v['Storefront Status / Reason'] ?? '',
    status: v.Status ?? '',
    invoice_id: invoiceIdOf(row),
  };
};

/** Lists the RGNs one stage's report holds for the criteria. */
export const searchRgnStage = async (stage: RgnStage, criteria: RgnCriteria, report: StatusReporter) => {
  const html = await runReport(RGN_STAGES[stage].path, rgnParams(criteria), report);
  return parseReportTable(html, 'Return Type').rows.map(row => mapRgn(row, stage));
};

/** One DC credit that has not been matched to an RGN. */
export const mapUnidentifiedCredit = (row: ReportRow) => {
  const v = row.values;
  return {
    credit_issue_number: v['Credit Issue Number'] ?? '',
    credit_issue_date: reportDate(v['Credit Issue Date']),
    return_type: v['Return Type'] ?? '',
    store: v.Store ?? '',
    division: v.Division ?? '',
    store_dc: v['Store DC'] ?? '',
    quantity: reportNumber(v.Quantity),
    age_days: reportNumber(v['Age (Days)']),
    credit_received: reportNumber(v['Credit Received in $']),
    credit_applied: reportNumber(v['Credit Applied in $']),
    variance: reportNumber(v['Variance in $']),
    variance_percent: reportNumber(v['Variance %']),
    last_credit_received_date: reportDate(v['Last Credit Received Date']),
    storefront_status: v['Storefront Status / Reason'] ?? '',
    status: v.Status ?? '',
    invoice_id: invoiceIdOf(row),
  };
};

export const searchUnidentifiedCredits = async (criteria: RgnCriteria, report: StatusReporter) => {
  const html = await runReport(UNIDENTIFIED_CREDITS, rgnParams(criteria), report);
  return parseReportTable(html, 'Return Type').rows.map(mapUnidentifiedCredit);
};

/** Fusion item number of an RGN part: the part number and its line abbreviation (8229CORE + BAT). */
export const itemOf = (partNumber: string, lineAbbreviation: string): string =>
  partNumber && lineAbbreviation ? `${partNumber}-${lineAbbreviation}` : partNumber;

/** One part waiting in the store's return bank, not yet on an RGN. */
export const mapReturnBankPart = (row: ReportRow) => {
  const v = row.values;
  return {
    return_type: v['Return Type'] ?? '',
    store: v.Store ?? '',
    line_abbreviation: v['Line Abbreviation'] ?? '',
    part_number: v['Part Number'] ?? '',
    item: itemOf(v['Part Number'] ?? '', v['Line Abbreviation'] ?? ''),
    description: v.Description ?? '',
    quantity: reportNumber(v.Quantity),
    unit_cost: reportNumber(v['Unit Cost in $']),
    core_cost: reportNumber(v['Core Cost in $']),
    extended_amount: reportNumber(v['Extended Amount in $']),
  };
};

/** Criteria of the Return Bank report, whose parameters differ from the RGN reports'. */
export interface ReturnBankCriteria {
  store?: string;
  part_number?: string;
  line_abbreviation?: string;
  return_type?: string;
}

export const searchReturnBank = async (criteria: ReturnBankCriteria, report: StatusReporter) => {
  const html = await runReport(
    RETURN_BANK,
    form => ({
      P_STORE_NUMBER: choose(form, 'P_STORE_NUMBER', criteria.store, 'store'),
      P_PART_NUMBER: choose(form, 'P_PART_NUMBER', criteria.part_number, 'part number'),
      P_LINE_ABBRV: choose(form, 'P_LINE_ABBRV', criteria.line_abbreviation, 'line abbreviation'),
      P_DISPOSITION_CODE: choose(form, 'P_DISPOSITION_CODE', criteria.return_type, 'return type'),
    }),
    report,
  );
  return parseReportTable(html, 'Return Type').rows.map(mapReturnBankPart);
};

/** Labels of the dashboard's tiles, as the dashboard shows them, by stage. */
const DASHBOARD_TILES = {
  return_bank: 'Return Bank',
  pending_store_manager_review: 'Pending Store Manager Review RGN',
  pending_credit: 'Pending Credit Issuance',
  osd_variance: 'RGN / OS&D Variance',
  unidentified_credit: 'Unidentified Credit Issuance',
  reconciled: 'Reconciled RGN (0-60 Days)',
  reconciled_with_financial_adjustment: 'Reconciled RGN With Financial Adj.(0-60 Days)',
  reconciled_without_financial_adjustment: 'Reconciled RGN With No Financial Adj.(0-60 Days)',
} as const;

/**
 * Reads the dashboard's tile counts. The dashboard lays its tiles out as a row of labels
 * followed by a row of counts in the same columns.
 */
export const parseDashboardCounts = (html: string): Record<keyof typeof DASHBOARD_TILES, number | null> => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...doc.querySelectorAll('tr')].map(row =>
    [...row.children].map(cell => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  const counts = new Map<string, string>();
  rows.forEach((labels, index) => {
    const values = rows[index + 1];
    if (!values) return;
    labels.forEach((label, column) => {
      if (label && /^\d[\d,]*$/.test(values[column] ?? '')) counts.set(label, values[column] ?? '');
    });
  });
  return Object.fromEntries(
    Object.entries(DASHBOARD_TILES).map(([key, label]) => [key, reportNumber(counts.get(label))]),
  ) as Record<keyof typeof DASHBOARD_TILES, number | null>;
};

export const dashboardCounts = async (
  criteria: Pick<RgnCriteria, 'store' | 'part_number' | 'return_type'>,
  report: StatusReporter,
) => {
  const html = await runReport(
    DASHBOARD,
    form => ({
      P_Store_Number: choose(form, 'P_Store_Number', criteria.store, 'store'),
      P_Part_Number: criteria.part_number || undefined,
      P_Return_Type: choose(form, 'P_Return_Type', criteria.return_type, 'return type'),
    }),
    report,
  );
  return parseDashboardCounts(html);
};

/** One line of a printed RGN: a part, what was requested for it, and what the DC credited. */
export const mapRgnLine = (row: ReportRow) => {
  const v = row.values;
  return {
    line_abbreviation: v['Line Abbrv'] ?? '',
    part_number: v['Part Number'] ?? '',
    item: itemOf(v['Part Number'] ?? '', v['Line Abbrv'] ?? ''),
    description: v.Description ?? '',
    requested_quantity: reportNumber(v['Requested Quantity']),
    requested_cost: reportNumber(v['Requested Cost ($)']),
    requested_core_cost: reportNumber(v['Requested Core Cost ($)']),
    requested_amount: reportNumber(v['Requested Amount ($)']),
    overage_shortage: v['Overage / Shortage'] ?? '',
    credited_quantity: reportNumber(v['Credited Quantity']),
    credited_cost: reportNumber(v['Credited Cost ($)']),
    credited_core_cost: reportNumber(v['Credited Core Cost ($)']),
    credited_amount: reportNumber(v['Credited Amount ($)']),
    variance: reportNumber(v['Variance ($)']),
  };
};

/** Reads one RGN through the print report: its header and every line with part numbers. */
export const printRgn = async (rgnNumber: string, report: StatusReporter) => {
  const html = await runReport(PRINT_RGN, () => ({ P_RGN_NUMBER: rgnNumber }), report);
  const table = parseReportTable(html, 'Line Abbrv');
  const labels = parseReportLabels(html);
  return {
    found: table.rows.length > 0 || Boolean(labels['RGN Number']),
    rgn_number: labels['RGN Number'] ?? rgnNumber,
    rgn_date: reportDate(labels['RGN Date']),
    store: labels.Store ?? '',
    return_type: labels['Return Type'] ?? '',
    reference: labels.Reference ?? '',
    notes: parseReportRowValue(html, 'Notes'),
    description: parseReportRowValue(html, 'Description'),
    lines: table.rows.map(mapRgnLine),
    totals: table.totals ? mapRgnTotals(table.totals) : null,
  };
};

/** The totals row of a printed RGN. */
const mapRgnTotals = (totals: Record<string, string>) => {
  const line = mapRgnLine({ values: totals, links: [] });
  return {
    requested_quantity: line.requested_quantity,
    requested_amount: line.requested_amount,
    credited_quantity: line.credited_quantity,
    credited_amount: line.credited_amount,
    variance: line.variance,
  };
};
