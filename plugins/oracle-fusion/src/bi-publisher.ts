import { fetchFromPage, fetchText, ToolError } from '@opentabs-dev/plugin-sdk';
import { elementText } from './adf-protocol.js';
import type { StatusReporter } from './search-screen.js';

/**
 * Oracle Analytics Publisher (BI Publisher) reports, run through the signed-in session.
 *
 * A report page (`/xmlpserver/<catalog path>.xdo`) holds a form of its parameters. Posting
 * that form to `/xmlpserver/servlet/xdo` with an output format starts the report and
 * answers with a loading page; the loading page names a status URL that is polled until the
 * report is ready, then posted once more for the output. This is what the report viewer
 * does in its frame. Each report allows only some output formats; HTML is the one parsed
 * here.
 */

const CONTEXT_PATH = '/xmlpserver';
const POLL_INTERVAL_MS = 1_000;
const MAX_WAIT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** URL of a report page, from its catalog path such as `/Custom/Reports/…/Report.xdo`. */
export const reportPageUrl = (path: string): string => CONTEXT_PATH + path.split('/').map(encodeURIComponent).join('/');

/** A report's parameter form as its page renders it. */
export interface ReportForm {
  /** Every field of the form, in order, as a browser submits it. */
  fields: [string, string][];
  /** Display pattern of each date parameter (e.g. `MM/dd/yyyy`), keyed by parameter name. */
  datePatterns: Map<string, string>;
  /** Value of each choice of a list parameter, keyed by parameter name and then by label. */
  choices: Map<string, Map<string, string>>;
}

const PARAM_PREFIX = '_params';

/** Reads a report page's parameter form, or returns null when the page has none. */
export const parseReportPage = (html: string): ReportForm | null => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const form = doc.forms.namedItem('xdoRptForm');
  if (!form) return null;

  const fields: [string, string][] = [];
  for (const element of form.elements) {
    const control = element as HTMLInputElement;
    if (control.name) fields.push([control.name, control.value ?? '']);
  }

  const datePatterns = new Map<string, string>();
  for (const input of doc.querySelectorAll<HTMLInputElement>('input[data-paramtype="date"][name]')) {
    const pattern = input.getAttribute('data-datepattern');
    if (pattern) datePatterns.set(input.name.slice(PARAM_PREFIX.length), pattern);
  }

  // List parameters are set up by script: new MultiChoiceList('<div>', '_paramsP_X', [['value', 'label'], …]
  const choices = new Map<string, Map<string, string>>();
  const pair = String.raw`\['(?:[^'\\]|\\.)*',\s*'(?:[^'\\]|\\.)*'\]`;
  const listPattern = new RegExp(
    String.raw`new MultiChoiceList\('[^']*',\s*'_params([^']+)',\s*\[((?:${pair},?\s*)*)\]`,
    'g',
  );
  for (const [, name, list] of html.matchAll(listPattern)) {
    if (!name || list === undefined) continue;
    const options = new Map<string, string>();
    for (const [, value, label] of list.matchAll(/\['((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'\]/g)) {
      options.set(label ?? '', value ?? '');
    }
    choices.set(name, options);
  }
  return { fields, datePatterns, choices };
};

/** Reads the status URL a loading page polls, or returns null when the page is not a loading page. */
export const parseStatusUrl = (html: string): string | null =>
  html.match(/function runStatusCheck\(\)\s*\{\s*var url = "([^"]+)"/)?.[1] ?? null;

/** Reads the error a report answered with, or returns null when it answered with output. */
export const parseReportError = (html: string): string | null => {
  const detail = new DOMParser().parseFromString(html, 'text/html').getElementById('errordetailtable');
  return detail ? elementText(detail) || 'The report could not be rendered.' : null;
};

/**
 * Raised when a report refuses the parameter values it was given. A list parameter refuses
 * a value that is not among its choices for the user, so for a lookup by number this means
 * the record does not exist or is not visible to the user.
 */
export class ReportParametersRejectedError extends ToolError {
  constructor(path: string) {
    super(`The Oracle Fusion report ${path} did not accept the parameter values given.`, 'VALIDATION_ERROR', {
      category: 'validation',
    });
    this.name = 'ReportParametersRejectedError';
  }
}

const PARAMETERS_REJECTED = /^Invalid parameters requested/i;

/** Values for a report's parameters, keyed by parameter name (e.g. `P_Part_Number`); omitted means all. */
export type ReportParams = Record<string, string | string[] | undefined>;

/**
 * Builds a run's parameter values from the report's form, which gives each date parameter's
 * pattern and each list parameter's choices.
 */
export type ReportParamsBuilder = (form: ReportForm) => ReportParams;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs a report and returns its output. The parameter form is read from the report page
 * each time, because it carries the session token the run must present.
 */
export const runReport = async (
  path: string,
  buildParams: ReportParamsBuilder,
  report: StatusReporter,
  format = 'html',
): Promise<string> => {
  const page = await fetchText(reportPageUrl(path), { timeout: REQUEST_TIMEOUT_MS });
  const form = parseReportPage(page);
  if (!form)
    throw ToolError.internal(
      `The Oracle Fusion report ${path} did not open; it may not exist or be visible to this user.`,
    );

  const body = new URLSearchParams(form.fields);
  body.set('_xf', format);
  body.set('_xpt', '0');
  body.set('_xautorun', 'true');
  for (const [name, value] of Object.entries(buildParams(form))) {
    if (value === undefined) continue;
    body.delete(PARAM_PREFIX + name);
    for (const one of Array.isArray(value) ? value : [value]) body.append(PARAM_PREFIX + name, one);
  }

  report('Running report');
  const loading = await fetchText(`${CONTEXT_PATH}/servlet/xdo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const statusUrl = parseStatusUrl(loading);
  if (!statusUrl) {
    throw ToolError.internal(
      `The Oracle Fusion report ${path} did not start: ${parseReportError(loading) ?? 'no status page'}`,
    );
  }

  const started = Date.now();
  for (;;) {
    const status = await fetchText(statusUrl, { method: 'POST', timeout: REQUEST_TIMEOUT_MS });
    if (status.trim() !== '') break;
    // A tool call that stays silent too long is ended, so a long run reports as it waits.
    report(`Waiting for the report (${Math.round((Date.now() - started) / 1000)} s)`);
    if (Date.now() - started > MAX_WAIT_MS) {
      throw ToolError.timeout(`The Oracle Fusion report ${path} did not finish within ${MAX_WAIT_MS / 1000} seconds.`);
    }
    await wait(POLL_INTERVAL_MS);
  }

  const output = await fetchFromPage(statusUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'fromLoadingPage=true&finalRequest=true',
    timeout: REQUEST_TIMEOUT_MS,
  });
  const text = await output.text();
  const error = parseReportError(text);
  if (error && PARAMETERS_REJECTED.test(error)) throw new ReportParametersRejectedError(path);
  if (error) throw ToolError.internal(`The Oracle Fusion report ${path} failed: ${error}`);
  return text;
};

/** One row of a report table: its cells by heading, and the links its cells carry. */
export interface ReportRow {
  values: Record<string, string>;
  links: string[];
}

/** A table of a report's HTML output. */
export interface ReportTable {
  headings: string[];
  rows: ReportRow[];
  /** The totals row under the table, keyed by heading; null when the table has none. */
  totals: Record<string, string> | null;
}

const cellsOf = (row: Element): Element[] => [...row.children];

/**
 * Reads the table of a report's HTML output whose heading row starts with `firstHeading`.
 * The rows under it run to the end of the table, or to a row labelled Total, which is
 * returned as the totals.
 */
export const parseReportTable = (html: string, firstHeading: string): ReportTable => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [...doc.querySelectorAll('tr')];
  const headingIndex = rows.findIndex(row => elementText(cellsOf(row)[0] ?? row) === firstHeading);
  if (headingIndex === -1) return { headings: [], rows: [], totals: null };

  const headingRow = rows[headingIndex] as Element;
  const headings = cellsOf(headingRow).map(elementText);
  const table = headingRow.closest('table');
  const record = (row: Element) =>
    Object.fromEntries(headings.map((heading, index) => [heading, elementText(cellsOf(row)[index] ?? row)]));

  const result: ReportRow[] = [];
  let totals: Record<string, string> | null = null;
  for (const row of rows.slice(headingIndex + 1)) {
    if (row.closest('table') !== table) break;
    const texts = cellsOf(row).map(elementText);
    if (texts.every(text => text === '')) continue;
    if (texts.includes('Total')) {
      totals = record(row);
      break;
    }
    result.push({
      values: record(row),
      links: [...row.querySelectorAll('a[href]')].map(a => a.getAttribute('href') ?? ''),
    });
  }
  return { headings, rows: result, totals };
};

/**
 * Reads the label and value pairs of a report's header, such as "RGN Date: | 08/26/2026".
 * A label is a cell ending in a colon; its value is the next non-empty cell of the row,
 * unless that cell is the next label, in which case the value is empty.
 */
export const parseReportLabels = (html: string): Record<string, string> => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const values: Record<string, string> = {};
  for (const row of doc.querySelectorAll('tr')) {
    const texts = cellsOf(row).map(elementText);
    texts.forEach((text, index) => {
      if (!text.endsWith(':') || text.length < 2) return;
      const label = text.slice(0, -1).trim();
      const next = texts.slice(index + 1).find(cell => cell !== '') ?? '';
      if (!(label in values)) values[label] = next.endsWith(':') ? '' : next;
    });
  }
  return values;
};

/** Reads the value beside a row label without a colon, such as "Notes | …"; empty when absent. */
export const parseReportRowValue = (html: string, label: string): string => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const row of doc.querySelectorAll('tr')) {
    const [first, ...rest] = cellsOf(row).map(elementText);
    if (first === label) return rest.find(cell => cell !== '') ?? '';
  }
  return '';
};
