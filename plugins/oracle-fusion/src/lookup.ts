import { richEvent, VIEWPORT_ROWS } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * The lookup dialog of a search field ("Search and Select"): a query panel of its own
 * whose results list the values the field accepts. It finds values by part of their text,
 * which the search field itself does not; the field then takes the full value found.
 *
 * Its components are named after the field: `<field>::_afrLovInternalQueryId` is its query
 * panel and `<field>_afrLovInternalTableId` its results table.
 */

export const lookupPanelId = (field: string): string => `${field}::_afrLovInternalQueryId`;
export const lookupTableId = (field: string): string => `${field}_afrLovInternalTableId`;

/**
 * Events that open a field's lookup dialog, in order: the field's "Search..." command and
 * the popup launch that renders the dialog.
 */
export const openLookupEvents = (field: string, fields: Record<string, string>): RichEvent[] => [
  {
    source: field,
    payload: richEvent('lovInternal', { action: 'click' }),
    fields,
    deltas: `{${field}lovPopupId={_shown=}}`,
  },
  {
    source: field,
    payload: richEvent('launchPopup'),
    fields,
    deltas: `{${field}::dropdownPopup={_shown=},${field}::dropdownPopup::dropDownContent={viewportSize=2,rows=1}}`,
  },
];

/**
 * Event that switches the dialog's query panel to its advanced mode, which adds an operator
 * to each criterion so a value can be matched by the text it contains.
 */
export const advancedLookupEvent = (field: string, fields: Record<string, string>): RichEvent => ({
  source: lookupPanelId(field),
  payload: richEvent('queryOperation', { operation: 'MODE_CHANGE' }),
  fields,
  deltas: `{${field}={_shown=${field}},${field}lovPopupId={_shown=${field}lovPopupId}}`,
});

/** Client state that makes the dialog's results table render every match at once. */
export const lookupViewportDeltas = (field: string): string =>
  `{${lookupTableId(field)}={viewportSize=${VIEWPORT_ROWS}}}`;

/** Event that closes the dialog without choosing a value, leaving the field as it was. */
export const closeLookupEvent = (field: string, fields: Record<string, string>): RichEvent => ({
  source: field,
  payload: richEvent('lovInternalpopupclosed', { operation: 'CANCEL' }),
  fields,
  deltas: `{${field}={_shown=},${field}lovPopupId={_shown=}}`,
});
