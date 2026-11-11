import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import {
  everyRowEvent,
  findTableId,
  pageEvent,
  parseFlatTable,
  parsePageSize,
  parseRowKeys,
  parseTableState,
  recordsOf,
  rendersEveryRow,
  showAllColumnsEvent,
} from './flat-table.js';

const TABLE = 'r:app:AT1:_ATp:rcv';

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const row = (key: string, cells: string[]): string =>
  `<tr _afrRK="${key}"><td _afrRH="true">&nbsp;</td><td><div><table _afrIT="1"><tr>` +
  cells.map(cell => `<td><span>${cell}</span></td>`).join('') +
  '</tr></table></div></td></tr>';

/** A document number cell as the page renders it: the link beside a notes icon, in a table of its own. */
const documentCell = (number: string): string =>
  `<table id="${TABLE}:0:docNumNote"><tbody><tr><td><a id="${TABLE}:0:cl3">${number}</a></td>` +
  `<td><a title="Notes to Receiver"></a></td></tr></tbody></table>`;

const searched = respond(
  `<table><tr><th id="${TABLE}:rh" _afrRH="true">&nbsp;</th><th id="${TABLE}:c1">Organization</th>` +
    `<th id="${TABLE}:c2">Item</th>` +
    `<th id="${TABLE}:c3">Document Number</th><th id="${TABLE}:grp" colspan="2">Quantity</th>` +
    `<th id="${TABLE}:c4">Quantity</th></tr></table>` +
    '<table><tr><th id="r:app:other:c9">Elsewhere</th></tr></table>' +
    `<div id="${TABLE}::db"><table _rowCount="2">` +
    row('0', ['GA0001', '380007-NSE', documentCell('ATL001-ZZZ08257'), '1']) +
    row('1', ['GA0001', '4885667-NB', documentCell('ATL001-ZZZ08797'), '2']) +
    '</table></div>' +
    '<div id="r:app:dialog::db"><table><tr _afrRK="9"><td></td><td><table _afrIT="1"><tr><td>x</td></tr></table></td></tr></table></div>',
  `new AdfRichTable('r:app:q1:value00_afrLovInternalTableId',{}),new AdfRichTable('${TABLE}',{})`,
);

describe('flat tables', () => {
  test('finds a table by the pattern of its id', () => {
    expect(findTableId(searched, /:_ATp:[^:]+$/)).toBe(TABLE);
    expect(findTableId(searched, /nothing/)).toBeNull();
  });

  test('reads the table’s own headings and rows, one value per column', () => {
    expect(parseFlatTable(searched, TABLE)).toEqual({
      headings: ['Organization', 'Item', 'Document Number', 'Quantity'],
      rows: [
        ['GA0001', '380007-NSE', 'ATL001-ZZZ08257', '1'],
        ['GA0001', '4885667-NB', 'ATL001-ZZZ08797', '2'],
      ],
      rowCount: 2,
    });
  });

  test('keys each row by heading', () => {
    expect(recordsOf(parseFlatTable(searched, TABLE))[1]).toEqual({
      Organization: 'GA0001',
      Item: '4885667-NB',
      'Document Number': 'ATL001-ZZZ08797',
      Quantity: '2',
    });
  });

  test('reads frozen columns, which sit outside the inner table, in heading order', () => {
    const frozen = respond(
      `<table><tr><th id="${TABLE}:c1">Movement Request</th><th id="${TABLE}:c2">Line Number</th>` +
        `<th id="${TABLE}:c3">Item</th><th id="${TABLE}:c4">Destination Subinventory</th></tr></table>` +
        `<div id="${TABLE}::db"><table><tr _afrRK="0"><td _afrRH="true">&nbsp;</td>` +
        `<td><a id="${TABLE}:0:commandLink2">ATL001-100001</a></td><td><span>1</span></td>` +
        '<td><div><table _afrIT="1"><tr><td>48881470-GRT</td><td>STAGING</td></tr></table></div></td></tr></table></div>',
    );
    expect(parseFlatTable(frozen, TABLE).rows).toEqual([['ATL001-100001', '1', '48881470-GRT', 'STAGING']]);
  });

  test('keeps an untitled column in place so the columns after it keep their headings', () => {
    const withIcon = respond(
      `<table><tr><th id="${TABLE}:c108" _afrRH="true">&nbsp;</th><th id="${TABLE}:c108a">&nbsp;</th>` +
        `<th id="${TABLE}:c3">Line</th><th id="${TABLE}:c4">Item</th></tr></table>` +
        `<div id="${TABLE}::db"><table>${row('24', ['', '152', '124245-MOB'])}</table></div>`,
    );
    const table = parseFlatTable(withIcon, TABLE);
    expect(table.headings).toEqual(['', 'Line', 'Item']);
    expect(recordsOf(table)).toEqual([{ Line: '152', Item: '124245-MOB' }]);
  });

  test('leaves out the disclosure cell of a row that expands, which has no heading', () => {
    const expandable = respond(
      `<table><tr><th id="${TABLE}:c8" _afrRH="true">&nbsp;</th><th id="${TABLE}:cl6">GTIN</th>` +
        `<th id="${TABLE}:cl9">UOM</th></tr></table>` +
        `<div id="${TABLE}::db"><table _rowCount="1"><tr _afrRK="0"><td _afrRH="true">&nbsp;</td>` +
        `<td _afrDetCol="true"><a id="${TABLE}:0::di" title="Expand"></a></td>` +
        '<td><span>00087295141151</span></td><td><span>EACH</span></td></tr></table></div>',
    );
    expect(recordsOf(parseFlatTable(expandable, TABLE))).toEqual([{ GTIN: '00087295141151', UOM: 'EACH' }]);
  });

  test('reads the key of each rendered row', () => {
    expect(parseRowKeys(searched, TABLE)).toEqual(['0', '1']);
    expect(parseRowKeys(searched, 'r:missing')).toEqual([]);
  });

  test('tells a table rendered whole from one rendered in part or uncounted', () => {
    expect(rendersEveryRow({ headings: [], rows: [['a'], ['b']], rowCount: 2 })).toBe(true);
    expect(rendersEveryRow({ headings: [], rows: [], rowCount: 0 })).toBe(true);
    expect(rendersEveryRow({ headings: [], rows: [['a']], rowCount: 2 })).toBe(false);
    expect(rendersEveryRow({ headings: [], rows: [['a']], rowCount: null })).toBe(false);
  });

  test('reads an absent table as empty', () => {
    expect(parseFlatTable(respond('<div></div>'), TABLE)).toEqual({ headings: [], rows: [], rowCount: null });
  });
});

describe('paged tables', () => {
  const body = (attributes: string) =>
    respond(`<div id="${TABLE}::db"><table _rowCount="-1" ${attributes}>${row('13', ['GA0001'])}</table></div>`);

  test('reads where the rendered rows start and which row is selected', () => {
    expect(parseTableState(body(`_startRow="13" _selState="{'13':1}"`), TABLE)).toEqual({
      startRow: 13,
      selectedRowKeys: ['13'],
    });
    expect(parseTableState(body(''), TABLE)).toEqual({ startRow: 0, selectedRowKeys: [] });
    expect(parseTableState(respond('<div></div>'), TABLE)).toEqual({ startRow: 0, selectedRowKeys: [] });
  });

  test('reads the page size of a table that shows a page at a time', () => {
    const setUp = (options: string) => respond('<div></div>', `new AdfRichTable('${TABLE}',{${options}})`);
    expect(parsePageSize(setUp("'first':10,'rows':10,'fetchSize':11,'scrollPolicy':'page'"), TABLE)).toBe(10);
    expect(parsePageSize(setUp("'rows':25,'scrollPolicy':'auto'"), TABLE)).toBeNull();
    expect(parsePageSize(searched, TABLE)).toBeNull();
    expect(parsePageSize(respond('<div></div>'), TABLE)).toBeNull();
  });

  test('has every row of a scrolling table rendered by selecting the selected row again', () => {
    expect(everyRowEvent(TABLE, '0', { a: '1' })).toEqual({
      source: TABLE,
      payload: '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>selection</s></k></m>',
      fields: { a: '1' },
      render: TABLE,
      deltas: `{${TABLE}={selectedRowKeys=0,viewportSize=10000}}`,
    });
  });

  test('shows a page as the navigation bar does', () => {
    expect(pageEvent(TABLE, 10, 13, 110)).toEqual({
      source: TABLE,
      payload:
        '<m xmlns="http://oracle.com/richClient/comm"><k v="oldStart"><s>13</s></k><k v="oldEnd"><s>22</s></k>' +
        '<k v="newStart"><s>110</s></k><k v="newEnd"><s>119</s></k><k v="type"><s>rangeChange</s></k></m>',
      render: TABLE,
    });
  });
});

describe('showAllColumnsEvent', () => {
  const ATP = 'r:app:AT1:_ATp';
  const toggle = (id: string, label: string, checked: boolean) =>
    `<tr id="${ATP}:${id}" role="menuitemcheckbox" aria-checked="${checked}"><td>${label}</td></tr>`;
  const page = (sourceChecked: boolean) =>
    respond(
      `<table>${toggle('_shwClmc1', 'Item', true)}${toggle('_clmCxt_shwClmc1', 'Item', true)}` +
        `${toggle('_shwClmc2', 'Source Locator', sourceChecked)}${toggle('_clmCxt_shwClmc2', 'Source Locator', sourceChecked)}` +
        `${toggle('_clmCxt_wrpMn', 'Wrap', false)}</table>`,
    );

  test('ticks every hidden column’s menu items and re-renders every column item', () => {
    expect(showAllColumnsEvent(page(false), `${ATP}:table1`)).toEqual({
      source: `${ATP}:table1`,
      payload:
        '<m xmlns="http://oracle.com/richClient/comm"><k v="showType"><s>showAll</s></k><k v="type"><s>showColumns</s></k></m>',
      render: [
        `${ATP}:_clmCxt`,
        `${ATP}:_shwClmc1`,
        `${ATP}:_clmCxt_shwClmc1`,
        `${ATP}:_shwClmc2`,
        `${ATP}:_clmCxt_shwClmc2`,
      ].join(','),
      deltas: `{${ATP}:_shwClmc2={selected=true},${ATP}:_clmCxt_shwClmc2={selected=true}}`,
    });
  });

  test('does nothing when every column already shows', () => {
    expect(showAllColumnsEvent(page(true), `${ATP}:table1`)).toBeNull();
  });
});
