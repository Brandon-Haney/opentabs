import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import { parseDetailFields } from './detail-page.js';
import {
  closeDialogEvent,
  dismissDialogEvent,
  findDialog,
  findMenuItem,
  menuItemEvent,
  parseLabelledTable,
  rowKeyOfLink,
  selectRowEvent,
} from './row-actions.js';

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const POPUP = 'r:app:AT1:ATwhop';
const DIALOG = 'r:app:AT1:ATwhod';

/** The About This Record dialog, laid out as the server renders it. */
const aboutAnswer = respond(
  `<div id="${POPUP}::content"><div id="${DIALOG}"><table><tbody>` +
    '<tr><td><label>Created By</label></td><td>100000</td></tr>' +
    '<tr><td><label>Last Updated By</label></td><td>SVC_FUSION_SCHEDULE_P</td></tr>' +
    '</tbody></table></div></div>',
  `AdfPage.PAGE.addComponents(new AdfRichPopup('${POPUP}',{'contentDelivery':'lazyUncached'}),new AdfRichDialog('${DIALOG}'));`,
);

describe('row selection and menu commands', () => {
  test('reads the row key out of a row link', () => {
    expect(rowKeyOfLink('r:app:AT1:_ATp:t1:9:commandLink1')).toBe('9');
    expect(rowKeyOfLink('r:app:help')).toBeNull();
  });

  test('selects a row by sending it as the selected row key', () => {
    expect(selectRowEvent('r:t1', '9', { a: '1' })).toEqual({
      source: 'r:t1',
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>selection</s></k></m>',
      fields: { a: '1' },
      deltas: '{r:t1={selectedRowKeys=9}}',
    });
  });

  test('finds a menu item by its text and clicks it under its toolbar', () => {
    const page = respond(
      '<table><tr id="r:app:AT1:_ATp:ATwho" role="menuitem"><td>About This Record</td></tr>' +
        '<tr id="r:app:AT1:_ATp:_shwAll" role="menuitem"><td>Show All</td></tr></table>',
    );
    expect(findMenuItem(page, 'About This Record')).toBe('r:app:AT1:_ATp:ATwho');
    expect(findMenuItem(page, 'Missing')).toBeNull();
    expect(menuItemEvent('r:app:AT1:_ATp:ATwho', {}).process).toBe('r:app:AT1:_ATp');
  });
});

describe('dialogs', () => {
  test('finds the dialog a command opened and the popup that holds it', () => {
    expect(findDialog(aboutAnswer)).toEqual({ popupId: POPUP, dialogId: DIALOG });
    expect(findDialog(respond('<div></div>'))).toBeNull();
  });

  test('reads a label and value dialog as detail fields', () => {
    expect(parseDetailFields(aboutAnswer)).toEqual({
      'Created By': '100000',
      'Last Updated By': 'SVC_FUSION_SCHEDULE_P',
    });
  });

  test('closes a dialog with OK', () => {
    expect(closeDialogEvent({ popupId: POPUP, dialogId: DIALOG }, {})).toEqual({
      source: DIALOG,
      payload:
        '<m xmlns="http://oracle.com/richClient/comm"><k v="outcome"><s>ok</s></k><k v="type"><s>dialog</s></k></m>',
      fields: {},
      process: POPUP,
      deltas: `{${POPUP}={_shown=${POPUP}}}`,
    });
  });

  test('reads a table of labelled rows under the leaf column headings', () => {
    const values = (cells: string[]) =>
      `<td><div><table _afrIT="1"><tr>${cells.map(cell => `<td><span>${cell}</span>&nbsp;</td>`).join('')}</tr></table></div></td>`;
    const answer = respond(
      `<div id="p::content"><div id="d"><table><tr>` +
        '<th _afrLeaf="true">Quantity Type</th><th colspan="5">Quantity</th>' +
        '<th _afrLeaf="true">On Hand</th><th _afrLeaf="true">Receiving</th><th _afrLeaf="true">Total</th>' +
        `</tr></table><table>` +
        `<tr _afrRK="1"><td><span>Total</span></td>${values(['4', '', '4'])}</tr>` +
        `<tr _afrRK="1"><td><span>Available to Reserve</span></td>${values(['0', '', '0'])}</tr>` +
        '</table></div></div>',
    );
    expect(parseLabelledTable(answer, { popupId: 'p', dialogId: 'd' })).toEqual({
      Total: { 'On Hand': '4', Receiving: '', Total: '4' },
      'Available to Reserve': { 'On Hand': '0', Receiving: '', Total: '0' },
    });
  });
});

describe('dismissDialogEvent', () => {
  test('clicks the dialog’s Done button when it has one', () => {
    const answer = respond(
      '<div id="r:AT1:viewPicks::content"><div id="r:AT1:d1"><button id="r:AT1:saveACBtn8">Done</button></div></div>',
      "new AdfRichPopup('r:AT1:viewPicks',{}),new AdfRichDialog('r:AT1:d1')",
    );
    const dialog = findDialog(answer);
    if (!dialog) throw new Error('fixture has no dialog');
    expect(dismissDialogEvent(answer, dialog, {})).toEqual({
      source: 'r:AT1:saveACBtn8',
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>',
      fields: {},
      process: 'r:AT1:viewPicks',
      deltas: '{r:AT1:viewPicks={_shown=r:AT1:viewPicks}}',
    });
  });

  test('closes with OK otherwise', () => {
    expect(dismissDialogEvent(aboutAnswer, { popupId: POPUP, dialogId: DIALOG }, {}).source).toBe(DIALOG);
  });
});
