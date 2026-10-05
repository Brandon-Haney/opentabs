import { elementText, type RichResponse, richEvent } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * The read-only page a results row opens: every attribute of one record as a label beside
 * its value, with a Done button back to the results.
 */

/**
 * Finds the link that opens a results row, by the text it shows (typically the record's
 * number). Row links carry the row index in their id, which is how they are told apart from
 * other links on the page.
 */
export const findRowLink = (response: RichResponse, linkText: string): string | null =>
  [...response.document.querySelectorAll('a[id]')].find(
    link => /:\d+:[^:]+$/.test(link.id) && elementText(link) === linkText,
  )?.id ?? null;

/**
 * Reads every labelled value on a detail page. Each value sits in the cell after its label;
 * rows whose value is a dropdown are navigation, not data, and are skipped. A label that
 * appears more than once keeps its first value.
 */
export const parseDetailFields = (response: RichResponse): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const row of response.document.querySelectorAll('tr')) {
    const [labelCell, valueCell, ...rest] = [...row.children];
    const label = labelCell?.querySelector(':scope > label');
    if (!label || !valueCell || rest.length > 0 || valueCell.querySelector('select')) continue;
    const name = elementText(label);
    if (name && !(name in fields)) fields[name] = elementText(valueCell);
  }
  return fields;
};

/** Finds the Done button that closes a detail page. */
export const findDoneButton = (response: RichResponse): string | null =>
  response.document.querySelector('[id$=":SPb"]')?.id ?? null;

/** Event that clicks a link or button. */
export const clickEvent = (source: string, fields?: Record<string, string>): RichEvent => ({
  source,
  payload: richEvent('action'),
  fields,
});

/**
 * Finds a collapsed section of a detail page by its title, returning its client id, or null
 * when the page has no such section or shows it already. A collapsed section has an
 * "Expand <title>" control and renders none of its fields.
 */
export const findCollapsedSection = (response: RichResponse, title: string): string | null => {
  const control = [...response.document.querySelectorAll('a[id$="::_afrDscl"]')].find(
    link => link.getAttribute('aria-label') === `Expand ${title}`,
  );
  return control ? control.id.slice(0, -'::_afrDscl'.length) : null;
};

/** Event that expands a section, which the server answers by rendering its fields. */
export const expandSectionEvent = (sectionId: string, fields?: Record<string, string>): RichEvent => ({
  source: sectionId,
  payload: richEvent('disclosure', { expand: true }),
  fields,
  render: sectionId,
  deltas: `{${sectionId}={disclosed=true}}`,
});

/**
 * The warning the tabbed work-area shell shows when a record's tab closes: "You have not
 * saved your changes. If you close this tab, then your changes will be lost." The plugin
 * never changes a record, so leaving the tab loses nothing.
 */
const CLOSE_TAB_WARNING = /:MAwarn$/;

/** Finds the close-tab warning a response asked the page to show, or returns null when it showed none. */
export const findCloseTabWarning = (response: RichResponse): string | null =>
  [...response.scripts.matchAll(/findComponent\('([^']+)'\)\.show\(\)/g)]
    .map(match => match[1] ?? '')
    .find(id => CLOSE_TAB_WARNING.test(id)) ?? null;

/** Event that fetches the content of a popup the page was asked to show. */
export const fetchPopupEvent = (popupId: string): RichEvent => ({
  source: popupId,
  payload: richEvent('fetch', { suppressMessageClear: 'true' }),
});

/** Finds a button of a popup's content by the text it shows. */
export const findPopupButton = (response: RichResponse, label: string): string | null =>
  [...response.document.querySelectorAll('button[id], a[id], div[id][role="button"]')].find(
    button => elementText(button) === label,
  )?.id ?? null;

/**
 * Event that answers the close-tab warning with its confirming button. The shell then closes
 * the record's tab and shows the tab the record was opened from.
 */
export const confirmCloseTabEvent = (popupId: string, button: string): RichEvent => ({
  source: button,
  payload: richEvent('action'),
  process: popupId,
  render: popupId.slice(0, popupId.lastIndexOf(':0:')),
  deltas: `{${popupId}={_shown=${popupId}}}`,
});
