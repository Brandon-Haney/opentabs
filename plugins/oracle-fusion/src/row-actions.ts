import { elementText, type RichResponse, richEvent } from './adf-protocol.js';
import type { RichEvent } from './adf-window.js';

/**
 * Commands a results table runs on its selected row, such as View → About This Record: the
 * row is selected, a menu item of the table's toolbar is clicked, and the answer is a dialog
 * that has to be closed again before the next row.
 */

/** Key of the row a link inside a table belongs to; the link's id reads `<table>:<row key>:<link>`. */
export const rowKeyOfLink = (linkId: string): string | null => linkId.match(/:(\d+):[^:]+$/)?.[1] ?? null;

/**
 * Event that selects one row of a table. The selection travels as client state; the event
 * tells the server to apply it.
 */
export const selectRowEvent = (tableId: string, rowKey: string, fields: Record<string, string>): RichEvent => ({
  source: tableId,
  payload: richEvent('selection'),
  fields,
  deltas: `{${tableId}={selectedRowKeys=${rowKey}}}`,
});

/** Finds a menu item of the page by the text it shows. */
export const findMenuItem = (response: RichResponse, label: string): string | null =>
  [...response.document.querySelectorAll('[role="menuitem"][id]')].find(item => elementText(item) === label)?.id ??
  null;

/** Event that clicks a menu item. It is processed under the toolbar that holds the menu. */
export const menuItemEvent = (itemId: string, fields: Record<string, string>): RichEvent => ({
  source: itemId,
  payload: richEvent('action'),
  fields,
  process: itemId.slice(0, itemId.lastIndexOf(':')),
});

/** A dialog a command opened, and the popup that holds it. */
export interface OpenDialog {
  popupId: string;
  dialogId: string;
}

/** Finds the dialog a response opened, or returns null when it opened none. */
export const findDialog = (response: RichResponse): OpenDialog | null => {
  const dialogId = response.scripts.match(/new AdfRichDialog\('([^']+)'/)?.[1];
  if (!dialogId) return null;
  const content = response.document.getElementById(dialogId)?.closest('[id$="::content"]');
  if (!content) return null;
  return { dialogId, popupId: content.id.slice(0, -'::content'.length) };
};

/** Event that closes a dialog with its OK button. */
export const closeDialogEvent = (dialog: OpenDialog, fields: Record<string, string>): RichEvent => ({
  source: dialog.dialogId,
  payload: richEvent('dialog', { outcome: 'ok' }),
  fields,
  process: dialog.popupId,
  deltas: `{${dialog.popupId}={_shown=${dialog.popupId}}}`,
});

/**
 * Reads a table inside a dialog whose rows each start with a label, such as a quantity
 * type, followed by values under the table's column headings. Returns the values of each
 * row keyed by heading, and each row keyed by its label.
 */
export const parseLabelledTable = (
  response: RichResponse,
  dialog: OpenDialog,
): Record<string, Record<string, string>> => {
  const root = response.document.getElementById(dialog.dialogId);
  if (!root) return {};
  // The first leaf heading belongs to the label column.
  const [, ...headings] = [...root.querySelectorAll('th[_afrleaf]')].map(elementText);
  const rows: Record<string, Record<string, string>> = {};
  for (const row of root.querySelectorAll('tr[_afrrk]')) {
    const label = row.querySelector(':scope > td');
    if (!label) continue;
    const values = [...row.querySelectorAll('table[_afrit] td')].map(elementText);
    rows[elementText(label)] = Object.fromEntries(headings.map((heading, index) => [heading, values[index] ?? '']));
  }
  return rows;
};

/**
 * Event that closes a dialog through its Done button, for dialogs that have one in place of
 * OK. The button's action is processed under the popup that holds the dialog.
 */
const doneButtonEvent = (dialog: OpenDialog, button: string, fields: Record<string, string>): RichEvent => ({
  source: button,
  payload: richEvent('action'),
  fields,
  process: dialog.popupId,
  deltas: `{${dialog.popupId}={_shown=${dialog.popupId}}}`,
});

/** Event that closes a dialog the way its own button does: Done when it has one, otherwise OK. */
export const dismissDialogEvent = (
  response: RichResponse,
  dialog: OpenDialog,
  fields: Record<string, string>,
): RichEvent => {
  const done = [...(response.document.getElementById(dialog.dialogId)?.querySelectorAll('button[id]') ?? [])].find(
    button => elementText(button) === 'Done',
  );
  return done ? doneButtonEvent(dialog, done.id, fields) : closeDialogEvent(dialog, fields);
};
