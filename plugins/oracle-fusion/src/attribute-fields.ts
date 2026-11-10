import { ToolError } from '@opentabs-dev/plugin-sdk';
import {
  type AdfMessage,
  elementText,
  findRegionAround,
  type RichResponse,
  richEvent,
  VIEWPORT_ROWS,
} from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import { findTableIds, parseFlatTable, recordsOf } from './flat-table.js';
import { controlValues, findDialog, type OpenDialog, selectRowEvent } from './row-actions.js';
import type { QueryPanel } from './search-page.js';
import { disclosureEvent, nextFetchId, parseTreeRows, parseTreeTable, type TreeRow } from './tree-table.js';

/**
 * The Add Fields dialog some query panels open instead of a menu ("Select and Add:
 * Attributes", as on Manage Items). Its left side is a tree of attributes, grouped by entity
 * and then attribute group; Move copies the attributes selected there to the list of chosen
 * attributes on the right, and OK adds the chosen ones to the panel as criteria.
 */

/** Where an attribute sits in the dialog's tree: entity, attribute group, attribute. */
export type AttributePath = readonly string[];

/** Toolbar button between the two sides that copies the selected attributes to the chosen ones. */
const MOVE_BUTTON_TITLE = 'Move';

/** Event that opens the dialog from the panel's Add Fields button. */
export const openAttributeDialogEvent = (panel: QueryPanel): RichEvent => ({
  source: `${panel.id}:addFldsCmd`,
  payload: richEvent('action'),
  fields: panel.values,
  process: panel.id,
});

/** The dialog as it opened. */
export interface AttributeDialog {
  dialog: OpenDialog;
  /** Tree of the attributes the panel can add. */
  treeId: string;
  /** Rows of the tree the dialog rendered. */
  rows: TreeRow[];
  /**
   * Position in the tree of the first row rendered. The tree opens scrolled where it was last
   * left in the session, so the rows above it may not be rendered.
   */
  startRow: number;
  /** Keys of the tree's expanded rows. */
  disclosedKeys: string[];
  /** Move button. */
  moveButton: string;
  /** Region holding both sides of the dialog and the buttons between them. */
  shuttle: string;
  okButton: string;
  /** Controls of the dialog, as a browser submits them. */
  fields: Record<string, string>;
}

/**
 * Reads the dialog a response to Add Fields opened. A response without the dialog, or a
 * dialog without its tree, Move button or OK button, is an error.
 */
export const readAttributeDialog = (response: RichResponse): AttributeDialog => {
  const dialog = findDialog(response);
  const root = dialog ? response.document.getElementById(dialog.dialogId) : null;
  const content = dialog ? response.document.getElementById(`${dialog.popupId}::content`) : null;
  if (!(dialog && root && content)) throw ToolError.internal('The Oracle Fusion Add Fields button opened no dialog.');

  const tree = parseTreeTable(response);
  const moveButton = [...root.querySelectorAll(`[id][title="${MOVE_BUTTON_TITLE}"]`)].find(
    button => !button.id.includes('::'),
  )?.id;
  const shuttle = moveButton ? findRegionAround(response, moveButton) : null;
  const okButton = [...root.querySelectorAll('button[id]')].find(button => elementText(button) === 'OK')?.id;
  if (!(tree && root.querySelector(`[id="${tree.id}"]`) && moveButton && shuttle && okButton)) {
    throw ToolError.internal('The Oracle Fusion Add Fields dialog has no attribute tree, Move button or OK button.');
  }
  return {
    dialog,
    treeId: tree.id,
    rows: tree.rows,
    startRow: renderedStartRow(response, tree.id) ?? 0,
    disclosedKeys: tree.disclosedKeys,
    moveButton,
    shuttle,
    okButton,
    fields: controlValues(content),
  };
};

/**
 * Position in the tree of the first row a response rendered: the rows of the tree's body, or
 * the rows a fetch returned, which arrive in a hidden copy of the body.
 */
export const renderedStartRow = (response: RichResponse, treeId: string): number | null => {
  const rows = response.document.querySelector(
    `[id="${treeId}::db"] table[_startrow], [id="${treeId}::dataW"] table[_startrow]`,
  );
  const start = Number(rows?.getAttribute('_startrow'));
  return rows && Number.isInteger(start) && start >= 0 ? start : null;
};

/**
 * Event that fetches the rows above the first one rendered, as the browser does when the
 * tree is scrolled up. It names the position and key of the first row rendered.
 */
export const earlierRowsEvent = (
  treeId: string,
  startRow: number,
  firstKey: string,
  fields: Record<string, string>,
): RichEvent => ({
  source: treeId,
  payload: richEvent('fetch', {
    id: nextFetchId(),
    subtype: 1,
    index: startRow,
    clientKey: firstKey,
    suppressMessageClear: 'true',
  }),
  fields,
  deltas: `{${treeId}={viewportSize=${VIEWPORT_ROWS},_afrFstVbl=${startRow},scrollTopRowKey|p=${firstKey}}}`,
});

/** Finds the row of the tree with this label under the given parent row; a root row has no parent. */
const childRow = (rows: TreeRow[], parent: string | undefined, label: string): TreeRow | undefined =>
  rows.find(row => row.label === label && row.ancestors.at(-1) === parent);

/** Event that copies the attributes selected in the tree to the chosen ones. */
export const moveAttributeEvent = (dialog: AttributeDialog, fields: Record<string, string>): RichEvent => ({
  source: dialog.moveButton,
  payload: richEvent('action'),
  fields,
  process: dialog.shuttle,
});

/** Event that closes the dialog with OK, adding the chosen attributes to the panel. */
export const confirmAttributesEvent = (dialog: AttributeDialog, fields: Record<string, string>): RichEvent => ({
  source: dialog.okButton,
  payload: richEvent('action'),
  fields,
  process: dialog.dialog.popupId,
});

/**
 * Whether the list of chosen attributes, as a response rendered it, holds the attribute.
 * The list is the table inside the dialog's shuttle; its columns name the entity, the
 * attribute group and the attribute.
 */
export const isAttributeChosen = (response: RichResponse, shuttle: string, path: AttributePath): boolean => {
  const tableId = findTableIds(response).find(id => id.startsWith(`${shuttle}:`));
  if (!tableId) return false;
  const [entity, group, attribute] = path;
  return recordsOf(parseFlatTable(response, tableId)).some(
    record => record.Entity === entity && record['Attribute Group'] === group && record.Attribute === attribute,
  );
};

const describeProblems = (messages: AdfMessage[]): string =>
  messages
    .filter(message => message.severity !== 'info' && message.severity !== 'confirmation')
    .map(message => message.text)
    .join(' ');

/** Submits one step of the dialog, failing on any error or warning Fusion answers it with. */
const step = async (adfWindow: AdfWindow, event: RichEvent, what: string): Promise<RichResponse> => {
  const response = await adfWindow.submit(event);
  const problems = describeProblems(response.messages);
  if (problems) throw ToolError.internal(`Oracle Fusion answered ${what} in the Add Fields dialog with: ${problems}`);
  return response;
};

/**
 * Adds one attribute to a query panel through the dialog, as a user does: opens Add Fields,
 * expands the tree down to the attribute, selects it, moves it to the chosen attributes and
 * answers OK. Returns the response to OK, which renders the panel with the new criterion.
 *
 * The tree keeps its expanded rows and its scroll position across the session's windows, so
 * it can open scrolled down with the rows above unrendered: those are fetched first, and the
 * tree is expanded only where the path is not already shown.
 */
export const addAttributeField = async (
  adfWindow: AdfWindow,
  panel: QueryPanel,
  path: AttributePath,
): Promise<RichResponse> => {
  const dialog = readAttributeDialog(await step(adfWindow, openAttributeDialogEvent(panel), 'Add Fields'));
  const fields = { ...panel.values, ...dialog.fields };
  const rows = [...dialog.rows];
  const disclosed = [...dialog.disclosedKeys];

  let start = dialog.startRow;
  while (start > 0) {
    const first = rows[0];
    if (!first) throw ToolError.internal('The Oracle Fusion Add Fields dialog rendered no attributes.');
    const earlier = await step(adfWindow, earlierRowsEvent(dialog.treeId, start, first.key, fields), 'scrolling up');
    const fetched = parseTreeRows(earlier);
    const fetchedStart = renderedStartRow(earlier, dialog.treeId);
    if (fetched.length === 0 || fetchedStart === null || fetchedStart >= start) {
      throw ToolError.internal(
        'The Oracle Fusion Add Fields dialog did not return the attributes above the ones shown.',
      );
    }
    rows.unshift(...fetched);
    start = fetchedStart;
  }

  let parent: TreeRow | undefined;
  for (const label of path) {
    let row = childRow(rows, parent?.key, label);
    if (!row && parent && !disclosed.includes(parent.key)) {
      disclosed.push(parent.key);
      const expanded = await step(
        adfWindow,
        disclosureEvent(dialog.treeId, disclosed, nextFetchId(), fields),
        `expanding ${parent.label}`,
      );
      rows.push(...parseTreeRows(expanded));
      row = childRow(rows, parent.key, label);
    }
    if (!row) {
      throw ToolError.internal(
        `The Oracle Fusion Add Fields dialog lists no "${label}"${parent ? ` under "${parent.label}"` : ''}.`,
      );
    }
    parent = row;
  }
  if (!parent) throw ToolError.internal('An Add Fields attribute path names no attribute.');

  await step(adfWindow, selectRowEvent(dialog.treeId, parent.key, fields), `selecting ${parent.label}`);
  const moved = await step(adfWindow, moveAttributeEvent(dialog, fields), `moving ${parent.label}`);
  if (!isAttributeChosen(moved, dialog.shuttle, path)) {
    throw ToolError.internal(`The Oracle Fusion Add Fields dialog did not take the ${path.join(' → ')} attribute.`);
  }
  return step(adfWindow, confirmAttributesEvent(dialog, fields), 'OK');
};
