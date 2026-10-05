import { ToolError } from '@opentabs-dev/plugin-sdk';
import { type RichResponse, richEvent } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * A Fusion search page: a query panel of labelled criteria above a results table whose
 * toolbar can export every matching row.
 */

/** The query panel as the server last rendered it. */
export interface QueryPanel {
  /** Client id of the panel. */
  id: string;
  /** The panel folds itself away after a search; a folded panel has no criteria to submit. */
  collapsed: boolean;
  /** Current value of every control in the panel, keyed by form field name. */
  values: Record<string, string>;
  /** Form field name of each criterion, keyed by the label shown beside it. */
  fieldsByLabel: Map<string, string>;
  /** Display pattern of each date criterion (e.g. `M/d/yy`), keyed by form field name. */
  datePatterns: Map<string, string>;
  /** Value each checkbox submits when ticked, keyed by form field name. */
  checkboxValues: Map<string, string>;
  /** Value each dropdown submits for each option, keyed by form field name and then by option text. */
  choices: Map<string, Map<string, string>>;
}

type PanelControl = HTMLInputElement | HTMLSelectElement;

const isCheckbox = (control: PanelControl): control is HTMLInputElement =>
  control instanceof HTMLInputElement && control.type === 'checkbox';

const DATE_INPUT_PATTERN =
  /new AdfRichInputDate\('([^']+)',\{(?:(?!new Adf)[\s\S])*?new TrDateTimeConverter\('([^']+)'/g;

/** What a response rendered of a panel: all of it, or only the criteria a change refreshed. */
interface RenderedControls {
  /** Form field name of every control the response rendered, submitted or not. */
  rendered: string[];
  values: Record<string, string>;
  fieldsByLabel: Map<string, string>;
  datePatterns: Map<string, string>;
  checkboxValues: Map<string, string>;
  choices: Map<string, Map<string, string>>;
}

/**
 * A component nested inside one of a panel's fields, such as the query panel of a field's
 * lookup dialog, is named `<field>::<component>:<control>`. Its controls share the panel's
 * prefix but belong to the nested panel.
 */
const NESTED_COMPONENT = /::[^:]+:/;

const readControls = (response: RichResponse, panelId: string): RenderedControls => {
  const prefix = `${panelId}:`;
  const belongsToPanel = (name: string | null | undefined): name is string =>
    name?.startsWith(prefix) === true && !NESTED_COMPONENT.test(name.slice(prefix.length));

  const rendered: string[] = [];
  const values: Record<string, string> = {};
  const checkboxValues = new Map<string, string>();
  const choices = new Map<string, Map<string, string>>();
  for (const control of response.document.querySelectorAll<PanelControl>('input[name], select[name]')) {
    if (!belongsToPanel(control.name)) continue;
    rendered.push(control.name);
    if (isCheckbox(control)) checkboxValues.set(control.name, control.value);
    if (control instanceof HTMLSelectElement) {
      choices.set(control.name, new Map([...control.options].map(option => [option.text.trim(), option.value])));
    }
    // A browser leaves an unticked checkbox out of the submission.
    if (!isCheckbox(control) || control.checked) values[control.name] = control.value;
  }

  const fieldsByLabel = new Map<string, string>();
  for (const label of response.document.querySelectorAll('label[for]')) {
    const name = response.document.getElementById(label.getAttribute('for') ?? '')?.getAttribute('name');
    if (belongsToPanel(name)) fieldsByLabel.set(label.textContent?.trim() ?? '', name);
  }

  const datePatterns = new Map<string, string>();
  for (const [, name, pattern] of response.scripts.matchAll(DATE_INPUT_PATTERN)) {
    if (belongsToPanel(name) && pattern) datePatterns.set(name, pattern);
  }

  return { rendered, values, fieldsByLabel, datePatterns, checkboxValues, choices };
};

/**
 * Reads a query panel out of a response that rendered it, or returns null when the response
 * has none. Without an id, the first panel is read; a page can hold more than one, such as
 * the panel of a lookup dialog, so a known panel is read by its id.
 */
export const parseQueryPanel = (response: RichResponse, panelId?: string): QueryPanel | null => {
  const root = panelId ? response.document.getElementById(panelId) : response.document.querySelector('[role="search"]');
  if (!root) return null;

  const { values, fieldsByLabel, datePatterns, checkboxValues, choices } = readControls(response, root.id);
  const toggle = response.document.getElementById(`${root.id}::_afrDscl`);
  return {
    id: root.id,
    collapsed: toggle?.getAttribute('aria-expanded') === 'false',
    values,
    fieldsByLabel,
    datePatterns,
    checkboxValues,
    choices,
  };
};

/**
 * Applies a response that re-rendered only some of the panel's criteria, as the server does
 * after a value change. Controls the response did not render keep their known values.
 */
export const refreshQueryPanel = (panel: QueryPanel, response: RichResponse): QueryPanel => {
  const fresh = readControls(response, panel.id);
  const kept = Object.entries(panel.values).filter(([name]) => !fresh.rendered.includes(name));
  return {
    ...panel,
    values: { ...Object.fromEntries(kept), ...fresh.values },
    fieldsByLabel: new Map([...panel.fieldsByLabel, ...fresh.fieldsByLabel]),
    datePatterns: new Map([...panel.datePatterns, ...fresh.datePatterns]),
    checkboxValues: new Map([...panel.checkboxValues, ...fresh.checkboxValues]),
    choices: new Map([...panel.choices, ...fresh.choices]),
  };
};

/**
 * Event that unfolds a collapsed panel. The `disclosed` delta tells the server the panel
 * is open on the client; without it the server keeps the criteria unrendered and ignores
 * any values submitted for them.
 */
export const expandPanelEvent = (panel: QueryPanel): RichEvent => ({
  source: panel.id,
  payload: richEvent('disclosure', { expand: true }),
  fields: panel.values,
  render: panel.id,
  deltas: `{${panel.id}={disclosed=true}}`,
});

/**
 * A value for one criterion, addressed by the label the page shows beside it.
 *
 * A `leading` criterion is one whose change the page reacts to by re-rendering other
 * criteria: the organization the rest of the panel is scoped to, or the operator of a
 * compared field. It cannot be changed in the same request as the search — a changed
 * organization resets the values submitted alongside it, and a changed operator is ignored
 * outright, so the search runs with the previous one. Leading criteria are committed one at
 * a time, in the order given, before the search.
 */
export type Criterion =
  | { label: string; text: string; leading?: boolean }
  | { label: string; date: string | null; timeOfDay?: TimeOfDay }
  | { label: string; checked: boolean }
  | { label: string; option: string };

/**
 * Time a date criterion stands for when its field also takes a time: the first or the last
 * minute of the day, so a range of dates covers each day in full.
 */
type TimeOfDay = 'start' | 'end';

const pad = (value: number, length: number): string => String(value).padStart(length, '0');

/**
 * Renders an ISO date (`YYYY-MM-DD`) in the numeric display pattern a date field expects,
 * at the start or end of the day when the pattern includes a time. The pattern follows the
 * user's regional preferences, so it is read from the page rather than assumed.
 */
export const formatDate = (isoDate: string, pattern: string, timeOfDay: TimeOfDay = 'start'): string => {
  const [year = 0, month = 0, day = 0] = isoDate.split('-').map(Number);
  const [hour, minute, second] = timeOfDay === 'start' ? [0, 0, 0] : [23, 59, 59];
  return pattern.replace(/([A-Za-z])\1*/g, token => {
    if (token === 'yy') return pad(year % 100, 2);
    if (token === 'yyyy') return pad(year, 4);
    if (token === 'M' || token === 'MM') return pad(month, token.length);
    if (token === 'd' || token === 'dd') return pad(day, token.length);
    if (token === 'H' || token === 'HH') return pad(hour, token.length);
    if (token === 'h' || token === 'hh') return pad(hour % 12 || 12, token.length);
    if (token === 'm' || token === 'mm') return pad(minute, token.length);
    if (token === 's' || token === 'ss') return pad(second, token.length);
    if (token === 'a') return hour < 12 ? 'AM' : 'PM';
    throw ToolError.internal(`Oracle Fusion uses the date pattern "${pattern}", which this plugin cannot write.`);
  });
};

const fieldFor = (panel: QueryPanel, label: string): string => {
  const name = panel.fieldsByLabel.get(label);
  if (!name) {
    throw ToolError.internal(
      `The Oracle Fusion search panel has no "${label}" field. The plugin reads the panel by its English ` +
        `labels; fields on this page: ${[...panel.fieldsByLabel.keys()].join(', ')}.`,
    );
  }
  return name;
};

/**
 * Event that commits a leading criterion on its own, the way the page does when the user
 * leaves the field. Returns null when the criterion is not leading or already holds the value.
 */
export const leadingChangeEvent = (panel: QueryPanel, criterion: Criterion): RichEvent | null => {
  if (!('text' in criterion) || !criterion.leading) return null;
  const name = fieldFor(panel, criterion.label);
  if (panel.values[name] === criterion.text) return null;

  return {
    source: name,
    payload: richEvent('valueChange', { autoSubmit: true, suppressMessageShow: 'true' }),
    fields: { ...panel.values, [name]: criterion.text },
  };
};

/**
 * Event that runs the search with the given criteria. Every control of the panel is
 * submitted, as a browser would, with the named criteria overriding their current values.
 *
 * ADF pairs each date input with a hidden `::lcId` field, which the page submits empty for
 * a typed date.
 */
export const searchEvent = (panel: QueryPanel, criteria: Criterion[]): RichEvent => {
  const fields = { ...panel.values };
  for (const criterion of criteria) {
    const name = fieldFor(panel, criterion.label);
    if ('text' in criterion) {
      fields[name] = criterion.text;
      continue;
    }
    if ('option' in criterion) {
      const options = panel.choices.get(name);
      if (!options) throw ToolError.internal(`The Oracle Fusion field "${criterion.label}" is not a dropdown.`);
      const value = options.get(criterion.option);
      if (value === undefined) {
        throw ToolError.internal(
          `The Oracle Fusion field "${criterion.label}" has no option "${criterion.option}". ` +
            `Options: ${[...options.keys()].filter(Boolean).join(', ')}.`,
        );
      }
      fields[name] = value;
      continue;
    }
    if ('checked' in criterion) {
      const ticked = panel.checkboxValues.get(name);
      if (ticked === undefined)
        throw ToolError.internal(`The Oracle Fusion field "${criterion.label}" is not a checkbox.`);
      if (criterion.checked) fields[name] = ticked;
      else delete fields[name];
      continue;
    }

    const pattern = panel.datePatterns.get(name);
    if (!pattern) throw ToolError.internal(`The Oracle Fusion field "${criterion.label}" is not a date field.`);
    fields[name] = criterion.date ? formatDate(criterion.date, pattern, criterion.timeOfDay) : '';
    if (`${name}::lcId` in fields) fields[`${name}::lcId`] = '';
  }

  return { source: panel.id, payload: richEvent('query', { clearAll: null }), fields };
};

/** A criterion the server ran the search without: the value sent, and the value the page kept. */
export interface UnappliedCriterion {
  label: string;
  sent: string;
  shown: string;
}

const comparable = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Compares the criteria a search submitted with the values the server rendered back in the
 * panel, and returns those it did not keep. A search the server ran with other criteria
 * returns rows, or no rows, that do not answer the question asked, with nothing on the page
 * to say so. The panel folds away after a search that found rows, leaving nothing to
 * compare; it stays open after one that found none, which is when a dropped criterion would
 * otherwise pass for an empty result.
 */
export const unappliedCriteria = (sent: RichEvent, panel: QueryPanel, criteria: Criterion[]): UnappliedCriterion[] => {
  if (panel.collapsed) return [];
  return criteria.flatMap(({ label }) => {
    const name = fieldFor(panel, label);
    const submitted = sent.fields?.[name] ?? '';
    const shown = panel.values[name] ?? '';
    return comparable(submitted) === comparable(shown) ? [] : [{ label, sent: submitted, shown }];
  });
};

/** Finds the results table's Export to Excel button. */
export const findExportButton = (response: RichResponse): string | null =>
  response.document.querySelector('[id$=":ATex"]')?.id ?? null;

/** Finds the results table the export button belongs to; both sit in the same table toolbar. */
export const findResultsTable = (response: RichResponse): string | null => {
  const exportButton = findExportButton(response);
  if (!exportButton) return null;
  const toolbar = exportButton.slice(0, exportButton.lastIndexOf(':') + 1);
  return (
    [...response.scripts.matchAll(/new AdfRichTable\('([^']+)'/g)]
      .map(match => match[1] ?? '')
      .find(id => id.startsWith(toolbar)) ?? null
  );
};

/** Event that exports every row of the current results. */
export const exportEvent = (panel: QueryPanel, exportButton: string): RichEvent => ({
  source: exportButton,
  payload: richEvent('action'),
  fields: panel.values,
});

/**
 * Reads the heading of each column from an export's heading rows. A column group spans
 * several columns in an upper row, with the columns' own headings in the row below; a
 * column outside any group spans every heading row. Each column takes the heading of the
 * lowest row it has one in.
 */
const leafHeadings = (headingRows: Element[]): string[] => {
  const grid: string[][] = headingRows.map(() => []);
  headingRows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.children) {
      while (grid[rowIndex]?.[column] !== undefined) column++;
      const text = cell.textContent?.trim() ?? '';
      const rowSpan = Number(cell.getAttribute('rowspan') ?? 1);
      const colSpan = Number(cell.getAttribute('colspan') ?? 1);
      for (let r = rowIndex; r < Math.min(rowIndex + rowSpan, grid.length); r++) {
        for (let c = column; c < column + colSpan; c++) (grid[r] as string[])[c] = text;
      }
      column += colSpan;
    }
  });
  return grid.at(-1) ?? [];
};

/** Media type of the exported file: an HTML table served as a spreadsheet. */
export const EXPORT_CONTENT_TYPE = 'application/vnd.ms-excel';

/**
 * Parses an exported results table into one record per row, keyed by column heading.
 * Columns without a heading, such as the row-selection column, are dropped.
 */
export const parseExport = (html: string): Record<string, string>[] => {
  const rows = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('tr')];
  // Heading rows are the leading rows made of heading cells; a table with column groups has
  // more than one. Without heading cells, the first row holds the headings.
  const firstRecord = rows.findIndex(row => [...row.children].some(cell => cell.tagName !== 'TH'));
  const headingRowCount = firstRecord === -1 ? rows.length : Math.max(1, firstRecord);
  const headings = leafHeadings(rows.slice(0, headingRowCount));
  const records = rows.slice(headingRowCount).map(row => [...row.children].map(cell => cell.textContent?.trim() ?? ''));

  return records.map(cells =>
    Object.fromEntries(
      headings.flatMap((heading, index): [string, string][] => (heading ? [[heading, cells[index] ?? '']] : [])),
    ),
  );
};
