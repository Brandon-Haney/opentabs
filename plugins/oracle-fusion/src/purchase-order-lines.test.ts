import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import {
  chooseActionEvent,
  confirmCloseEvent,
  expectedQuantities,
  findCloseLineCommand,
  findOrderLinesTable,
  judgeCloseAnswer,
  type OrderLine,
  parseOrderLines,
  parseRenderedOrderLines,
  readCloseLineDialog,
  refusalFor,
  selectLineEvent,
} from './purchase-order-lines.js';

const PAGE = 'r:app:MAt5:0:pt1:viewl1:0:AP2';
const TABLE = `${PAGE}:AT1:_ATp:table1`;
const POPUP = `${PAGE}:CA_Popup`;
const DIALOG = `${PAGE}:d13`;

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

/** A lines row as the page renders it: the row header, then an icon cell and the values in an inner table. */
const lineRow = (key: string, values: string[]): string =>
  `<tr _afrRK="${key}"><td _afrRH="true">&nbsp;</td><td><div><table _afrIT="1"><tr><td></td>` +
  values.map(value => `<td>${value}</td>`).join('') +
  '</tr></table></div></td></tr>';

const HEADINGS = ['Line', 'Item', 'Description', 'Quantity', 'Status'];

const linesTable = (rows: string, headings = HEADINGS, rowCount = 2): string =>
  `<table><tr><th id="${TABLE}:c108" _afrRH="true">&nbsp;</th><th id="${TABLE}:c108a">&nbsp;</th>` +
  headings.map((heading, index) => `<th id="${TABLE}:c${index}">${heading}</th>`).join('') +
  `</tr></table><div id="${TABLE}::db"><table _rowCount="${rowCount}">${rows}</table></div>`;

const menu = (cancelHidden: boolean) =>
  `<table><tr id="${TABLE.replace(':table1', ':CA_LINES_CANCEL_LINE')}" role="menuitem"` +
  `${cancelHidden ? ' style="display:none"' : ''}><td>Cancel Line</td></tr>` +
  `<tr id="${TABLE.replace(':table1', ':CA_LINES_CLOSE')}" role="menuitem"><td>Close</td></tr></table>`;

const orderPage = respond(
  linesTable(
    lineRow('24', ['152', '124245-MOB', 'Motor Oil', '6', 'Open']) +
      lineRow('26', ['183', '19431551-AC', 'Wire Kit', '1,200', 'Closed for Receiving']),
  ) + menu(true),
  `new AdfRichTable('${PAGE}:AT1:_ATp:table1',{})`,
);

describe('order lines', () => {
  test('finds the lines table of the page', () => {
    expect(findOrderLinesTable(orderPage)).toBe(TABLE);
  });

  test('reads each line with its row key, past the untitled icon column', () => {
    expect(parseOrderLines(orderPage, TABLE)).toEqual({
      lines: [
        { rowKey: '24', line: 152, item: '124245-MOB', quantity: 6, status: 'Open' },
        { rowKey: '26', line: 183, item: '19431551-AC', quantity: 1200, status: 'Closed for Receiving' },
      ],
      rowCount: 2,
    });
  });

  test('refuses a table that hides a column the checks rely on', () => {
    const hidden = respond(
      linesTable(lineRow('0', ['1', 'X-1', 'x', '1']), ['Line', 'Item', 'Description', 'Quantity']),
    );
    expect(() => parseOrderLines(hidden, TABLE)).toThrow(/does not show the Status column/);
  });

  test('refuses a response that did not redraw the table', () => {
    expect(() => parseRenderedOrderLines(respond('<div></div>'), TABLE)).toThrow(/did not redraw/);
  });

  test('selects a line and asks for every line to be rendered', () => {
    expect(selectLineEvent(TABLE, '24')).toEqual({
      source: TABLE,
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>selection</s></k></m>',
      render: TABLE,
      deltas: `{${TABLE}={selectedRowKeys=24,viewportSize=10000}}`,
    });
  });
});

describe('findCloseLineCommand', () => {
  test('finds the lines toolbar’s Close command', () => {
    expect(findCloseLineCommand(orderPage)).toBe(`${PAGE}:AT1:_ATp:CA_LINES_CLOSE`);
  });

  test('treats a hidden or missing command as not offered', () => {
    const hidden = respond(
      `<table><tr id="${PAGE}:AT1:_ATp:CA_LINES_CLOSE" role="menuitem" style="display:none"><td>Close</td></tr></table>`,
    );
    expect(findCloseLineCommand(hidden)).toBeNull();
    expect(findCloseLineCommand(respond('<div></div>'))).toBeNull();
  });
});

/** The Close Line dialog as the server renders it, cut down to one control of each kind. */
const dialogHtml = (title = 'Close Line') =>
  `<div id="${POPUP}::content"><div id="${DIALOG}"><div id="${DIALOG}::_ttxt">${title}</div>` +
  `<table><tr><td><label for="${PAGE}:soc1::content">Action</label></td><td>` +
  `<select id="${PAGE}:soc1::content" name="${PAGE}:soc1"><option value="0" selected>Close</option>` +
  '<option value="1">Close for Receiving</option><option value="2">Close for Invoicing</option></select></td></tr>' +
  `<tr><td><label for="${PAGE}:it4::content">Reason</label></td><td>` +
  `<textarea id="${PAGE}:it4::content" name="${PAGE}:it4"></textarea></td></tr>` +
  `<tr style="display:none"><td><label for="${PAGE}:soc2::content">Cancel Unfulfilled Demand</label></td><td>` +
  `<select id="${PAGE}:soc2::content" name="${PAGE}:soc2"><option value="0">No</option>` +
  '<option value="1" selected>Yes</option></select></td></tr>' +
  `<tr><td><input type="hidden" name="${PAGE}:date::lcId" id="${PAGE}:date::lcId"></td></tr>` +
  `<tr><td><input type="radio" name="${PAGE}:sor1" value="0"><input type="radio" name="${PAGE}:sor1" value="1"></td></tr>` +
  `<tr><td><input type="radio" name="${PAGE}:sor2" value="0" checked></td></tr>` +
  `</table><button id="${DIALOG}::ok">OK</button></div></div>`;

const DIALOG_SCRIPT = `AdfPage.PAGE.addComponents(new AdfRichPopup('${POPUP}',{'contentDelivery':'lazyUncached'}),new AdfRichDialog('${DIALOG}'))`;

const confirmation = (type: string, text: string) =>
  `AdfPage.PAGE.addMessage(null,new AdfFacesMessage(AdfFacesMessage.TYPE_${type},'${text}',null,null))`;

describe('readCloseLineDialog', () => {
  const closing = readCloseLineDialog(respond(dialogHtml(), DIALOG_SCRIPT));

  test('reads every control as a browser would submit it', () => {
    expect(closing.dialog).toEqual({ dialogId: DIALOG, popupId: POPUP });
    expect(closing.fields).toEqual({
      [`${PAGE}:soc1`]: '0',
      [`${PAGE}:it4`]: '',
      [`${PAGE}:soc2`]: '1',
      [`${PAGE}:date::lcId`]: '',
      [`${PAGE}:sor2`]: '0',
    });
  });

  test('finds the Action choice with its options and the Reason box by their labels', () => {
    expect(closing.actionField).toBe(`${PAGE}:soc1`);
    expect(closing.actions).toEqual(
      new Map([
        ['Close', '0'],
        ['Close for Receiving', '1'],
        ['Close for Invoicing', '2'],
      ]),
    );
    expect(closing.reasonField).toBe(`${PAGE}:it4`);
  });

  test('refuses another dialog, a message, or no dialog at all', () => {
    expect(() => readCloseLineDialog(respond(dialogHtml('Cancel Line'), DIALOG_SCRIPT))).toThrow(
      'Oracle Fusion opened "Cancel Line" instead of the Close Line dialog.',
    );
    expect(() =>
      readCloseLineDialog(respond(dialogHtml(), `${DIALOG_SCRIPT};${confirmation('ERROR', 'Line is on hold.')}`)),
    ).toThrow('Oracle Fusion answered Close with: Line is on hold.');
    expect(() => readCloseLineDialog(respond('<div></div>'))).toThrow('Oracle Fusion opened no dialog for Close.');
  });

  test('chooses an action through the dropdown, which submits itself', () => {
    expect(chooseActionEvent(closing, { a: '1' })).toEqual({
      source: `${PAGE}:soc1`,
      payload:
        '<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k>' +
        '<k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>',
      fields: { a: '1' },
      deltas: `{${POPUP}={_shown=${POPUP}}}`,
    });
  });

  test('answers the dialog with OK under its popup', () => {
    expect(confirmCloseEvent(closing, { a: '1' })).toEqual({
      source: DIALOG,
      payload:
        '<m xmlns="http://oracle.com/richClient/comm"><k v="outcome"><s>ok</s></k><k v="type"><s>dialog</s></k></m>',
      fields: { a: '1' },
      process: POPUP,
      deltas: `{${POPUP}={_shown=${POPUP}}}`,
    });
  });
});

describe('judgeCloseAnswer', () => {
  const closing = readCloseLineDialog(respond(dialogHtml(), DIALOG_SCRIPT));

  test('counts a confirmation with nothing else as saved', () => {
    expect(judgeCloseAnswer(respond('', confirmation('CONFIRMATION', 'Your changes were saved.')), closing)).toEqual({
      saved: true,
      text: 'Your changes were saved.',
    });
  });

  test('counts an error or warning as not saved, quoting it', () => {
    const answer = respond(
      '',
      `${confirmation('INFO', 'Your changes were saved.')};${confirmation('WARNING', 'Receipts are pending.')}`,
    );
    expect(judgeCloseAnswer(answer, closing)).toEqual({ saved: false, text: 'Receipts are pending.' });
  });

  test('counts silence or a further dialog as not saved', () => {
    expect(judgeCloseAnswer(respond(''), closing)).toEqual({
      saved: false,
      text: 'Oracle Fusion did not confirm the close.',
    });
    const asked = respond(
      `<div id="${PAGE}:warn::content"><div id="${PAGE}:warnd"><div id="${PAGE}:warnd::_ttxt">Warning</div></div></div>`,
      `new AdfRichDialog('${PAGE}:warnd')`,
    );
    expect(judgeCloseAnswer(asked, closing)).toEqual({
      saved: false,
      text: 'Oracle Fusion opened a further dialog, "Warning".',
    });
  });
});

describe('refusalFor', () => {
  const open: OrderLine = { rowKey: '24', line: 152, item: '124245-MOB', quantity: 6, status: 'Open' };
  const wanted = { line: 152, item: '124245-mob' };
  const expecting = (quantity: number, item = '124245-MOB') => new Map([[152, { item, quantity }]]);

  test('allows an open line receiving still expects in full, matching the item in any case', () => {
    expect(refusalFor(wanted, open, expecting(6))).toBeNull();
  });

  test('refuses a missing line, another item, or a line that is not open', () => {
    expect(refusalFor(wanted, undefined, expecting(6))).toBe('Line 152 is not on the order.');
    expect(refusalFor({ line: 152, item: '124245-NOL' }, open, expecting(6))).toBe(
      'Line 152 is item 124245-MOB, not 124245-NOL.',
    );
    expect(refusalFor(wanted, { ...open, status: 'Closed for Receiving' }, expecting(6))).toBe(
      'Line 152 is Closed for Receiving, not Open.',
    );
  });

  test('refuses a line receiving does not expect, or expects only part of', () => {
    expect(refusalFor(wanted, open, new Map())).toMatch(/^Receiving does not expect line 152/);
    expect(refusalFor(wanted, open, expecting(2))).toBe(
      'Receiving expects 2 of the 6 ordered on line 152, so part of it has been received.',
    );
    expect(refusalFor(wanted, open, expecting(8))).toBe('Receiving expects 8 on line 152, which orders 6.');
    expect(refusalFor(wanted, open, expecting(6, 'OTHER-1'))).toBe('Receiving lists line 152 as item OTHER-1.');
    expect(refusalFor(wanted, { ...open, quantity: null }, expecting(6))).toMatch(/shows no ordered quantity/);
  });
});

describe('expectedQuantities', () => {
  test('adds up every schedule of a line', () => {
    expect(
      expectedQuantities([
        { document_line: '152', item: '124245-MOB', quantity: 4 },
        { document_line: '152', item: '124245-MOB', quantity: 2 },
        { document_line: '183', item: '19431551-AC', quantity: 1 },
      ]),
    ).toEqual(
      new Map([
        [152, { item: '124245-MOB', quantity: 6 }],
        [183, { item: '19431551-AC', quantity: 1 }],
      ]),
    );
  });
});
