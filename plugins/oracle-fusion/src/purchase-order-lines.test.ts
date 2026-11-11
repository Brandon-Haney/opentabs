import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import { pageEvent } from './flat-table.js';
import {
  chooseActionEvent,
  confirmCloseEvent,
  expectedQuantities,
  findCloseLineCommand,
  findOrderLines,
  findOrderLinesTable,
  judgeCloseAnswer,
  type LinesTable,
  type OrderLine,
  parseOrderLines,
  parseRenderedOrderLines,
  readCloseLineDialog,
  refusalFor,
  selectLine,
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

interface TableOptions {
  headings?: string[];
  /** Lines the order has; -1 while Fusion has not counted them. */
  rowCount?: number;
  startRow?: number;
  /** Key of the selected row. */
  selected?: string;
}

const linesTable = (
  rows: string,
  { headings = HEADINGS, rowCount = 2, startRow = 0, selected }: TableOptions = {},
): string =>
  `<table><tr><th id="${TABLE}:c108" _afrRH="true">&nbsp;</th><th id="${TABLE}:c108a">&nbsp;</th>` +
  headings.map((heading, index) => `<th id="${TABLE}:c${index}">${heading}</th>`).join('') +
  `</tr></table><div id="${TABLE}::db"><table _rowCount="${rowCount}" _startRow="${startRow}"` +
  `${selected === undefined ? '' : ` _selState="{'${selected}':1}"`}>${rows}</table></div>`;

/** Set-up script of the lines table, which shows ten lines a page. */
const PAGED_TABLE = `new AdfRichTable('${TABLE}',{'first':10,'rows':10,'fetchSize':11,'scrollPolicy':'page'})`;

const menu = (cancelHidden: boolean) =>
  `<table><tr id="${TABLE.replace(':table1', ':CA_LINES_CANCEL_LINE')}" role="menuitem"` +
  `${cancelHidden ? ' style="display:none"' : ''}><td>Cancel Line</td></tr>` +
  `<tr id="${TABLE.replace(':table1', ':CA_LINES_CLOSE')}" role="menuitem"><td>Close</td></tr></table>`;

const orderPage = respond(
  linesTable(
    lineRow('24', ['152', '124245-MOB', 'Motor Oil', '6', 'Open']) +
      lineRow('26', ['183', '19431551-AC', 'Wire Kit', '1,200', 'Closed for Receiving']),
    { startRow: 151, selected: '24' },
  ) + menu(true),
  PAGED_TABLE,
);

describe('order lines', () => {
  test('finds the lines table of the page with the lines it shows per page', () => {
    expect(findOrderLinesTable(orderPage, 'ATL001-1')).toEqual({ id: TABLE, pageSize: 10 });
  });

  test('refuses a page without a lines table, or one that does not page', () => {
    expect(() => findOrderLinesTable(respond('<div></div>'), 'ATL001-1')).toThrow(
      'The Oracle Fusion page for ATL001-1 has no lines table.',
    );
    const scrolling = respond(linesTable(''), `new AdfRichTable('${TABLE}',{'rows':25,'scrollPolicy':'auto'})`);
    expect(() => findOrderLinesTable(scrolling, 'ATL001-1')).toThrow(
      'The Oracle Fusion lines table of ATL001-1 does not show its lines a page at a time.',
    );
  });

  test('reads each line with its row key and position, past the untitled icon column', () => {
    expect(parseOrderLines(orderPage, TABLE)).toEqual({
      lines: [
        { rowKey: '24', index: 151, line: 152, item: '124245-MOB', quantity: 6, status: 'Open' },
        { rowKey: '26', index: 152, line: 183, item: '19431551-AC', quantity: 1200, status: 'Closed for Receiving' },
      ],
      start: 151,
      end: 153,
      rowCount: 2,
      selectedKey: '24',
    });
  });

  test('refuses a table that hides a column the checks rely on', () => {
    const hidden = respond(
      linesTable(lineRow('0', ['1', 'X-1', 'x', '1']), { headings: ['Line', 'Item', 'Description', 'Quantity'] }),
    );
    expect(() => parseOrderLines(hidden, TABLE)).toThrow(/does not show the Status column/);
  });

  test('refuses a response that did not redraw the table', () => {
    expect(() => parseRenderedOrderLines(respond('<div></div>'), TABLE)).toThrow(/did not redraw/);
  });

  test('selects a line, which redraws the table from that line on', () => {
    expect(selectLineEvent(TABLE, '24')).toEqual({
      source: TABLE,
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>selection</s></k></m>',
      render: TABLE,
      deltas: `{${TABLE}={selectedRowKeys=24}}`,
    });
  });
});

/** A window that answers each event with the next of the responses given, keeping the events. */
const scriptedWindow = (...responses: RichResponse[]) => {
  const events: RichEvent[] = [];
  const adfWindow: AdfWindow = {
    homeHtml: '',
    submit: async event => {
      events.push(event);
      const next = responses.shift();
      if (!next) throw new Error('no response scripted for this event');
      return next;
    },
    download: async () => {
      throw new Error('no download scripted');
    },
  };
  return { adfWindow, events };
};

const LINES: LinesTable = { id: TABLE, pageSize: 3 };

/** A page of open lines, each row keyed by its position and numbered as given. */
const linesPage = (start: number, numbers: number[], options: TableOptions = {}): RichResponse =>
  respond(
    linesTable(
      numbers
        .map((number, position) => lineRow(`k${start + position}`, [String(number), `P-${number}`, 'x', '1', 'Open']))
        .join(''),
      { rowCount: -1, startRow: start, ...options },
    ),
  );

const opened = parseOrderLines(linesPage(0, [1, 2, 3]), TABLE);

describe('findOrderLines', () => {
  test('reads no further once every wanted line is found', async () => {
    const { adfWindow, events } = scriptedWindow();
    const found = await findOrderLines(adfWindow, LINES, opened, [2]);
    expect([...found.lines.keys()]).toEqual([1, 2, 3]);
    expect(found.shownStart).toBe(0);
    expect(events).toEqual([]);
  });

  test('pages on until every wanted line is found', async () => {
    const { adfWindow, events } = scriptedWindow(linesPage(3, [4, 5, 6]), linesPage(6, [7, 8, 9]));
    const found = await findOrderLines(adfWindow, LINES, opened, [5, 8]);
    expect(events).toEqual([pageEvent(TABLE, 3, 0, 3), pageEvent(TABLE, 3, 3, 6)]);
    expect(found.lines.get(8)).toMatchObject({ rowKey: 'k7', index: 7, line: 8 });
    expect(found.shownStart).toBe(6);
  });

  test('stops at the last page, leaving out a line the order does not have', async () => {
    const counted = scriptedWindow(linesPage(3, [4, 5], { rowCount: 5 }));
    const found = await findOrderLines(counted.adfWindow, LINES, opened, [9]);
    expect([...found.lines.keys()]).toEqual([1, 2, 3, 4, 5]);
    expect(counted.events).toHaveLength(1);

    const short = scriptedWindow(linesPage(3, [4]));
    expect((await findOrderLines(short.adfWindow, LINES, opened, [9])).lines.has(9)).toBe(false);
  });

  test('takes the last full page Fusion shows when asked past the end', async () => {
    const { adfWindow, events } = scriptedWindow(linesPage(3, [4, 5, 6]), linesPage(3, [4, 5, 6], { rowCount: 6 }));
    const found = await findOrderLines(adfWindow, LINES, opened, [9]);
    expect(events).toHaveLength(2);
    expect(found.lines.size).toBe(6);
    expect(found.shownStart).toBe(3);
  });

  test('refuses a page that does not move on before the last line', async () => {
    const { adfWindow } = scriptedWindow(linesPage(0, [1, 2, 3]));
    await expect(findOrderLines(adfWindow, LINES, opened, [9])).rejects.toThrow(
      "Oracle Fusion did not show the order's lines after the first 3.",
    );
  });
});

describe('selectLine', () => {
  const listed: OrderLine = { rowKey: 'k1', index: 4, line: 5, item: 'P-5', quantity: 1, status: 'Open' };

  test('shows the line’s page, selects it by the key that page gives it, and checks the selection', async () => {
    const { adfWindow, events } = scriptedWindow(linesPage(4, [5, 6, 7]), linesPage(4, [5, 6, 7], { selected: 'k4' }));
    expect(await selectLine(adfWindow, LINES, 9, listed)).toEqual({
      line: { ...listed, rowKey: 'k4' },
      shownStart: 4,
    });
    expect(events).toEqual([pageEvent(TABLE, 3, 9, 4), selectLineEvent(TABLE, 'k4')]);
  });

  test('refuses a line that is no longer where the order listed it', async () => {
    const { adfWindow, events } = scriptedWindow(linesPage(4, [6, 7, 8]));
    await expect(selectLine(adfWindow, LINES, 0, listed)).rejects.toThrow(
      'Line 5 is no longer where the order listed it.',
    );
    expect(events).toHaveLength(1);
  });

  test('refuses a selection Fusion made of another line, or did not make', async () => {
    const other = scriptedWindow(linesPage(4, [5, 6, 7]), linesPage(4, [5, 6, 7], { selected: 'k5' }));
    await expect(selectLine(other.adfWindow, LINES, 0, listed)).rejects.toThrow(
      'Oracle Fusion selected line 6 instead of line 5.',
    );
    const none = scriptedWindow(linesPage(4, [5, 6, 7]), linesPage(4, [5, 6, 7]));
    await expect(selectLine(none.adfWindow, LINES, 0, listed)).rejects.toThrow(
      'Oracle Fusion selected no line instead of line 5.',
    );
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
  const open: OrderLine = { rowKey: '24', index: 151, line: 152, item: '124245-MOB', quantity: 6, status: 'Open' };
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
