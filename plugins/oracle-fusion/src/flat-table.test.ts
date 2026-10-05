import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import { findTableId, parseFlatTable, parseRowKeys, recordsOf, showAllColumnsEvent } from './flat-table.js';

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
  `<table><tr><th id="${TABLE}:rh">&nbsp;</th><th id="${TABLE}:c1">Organization</th><th id="${TABLE}:c2">Item</th>` +
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

  test('reads the key of each rendered row', () => {
    expect(parseRowKeys(searched, TABLE)).toEqual(['0', '1']);
    expect(parseRowKeys(searched, 'r:missing')).toEqual([]);
  });

  test('reads an absent table as empty', () => {
    expect(parseFlatTable(respond('<div></div>'), TABLE)).toEqual({ headings: [], rows: [], rowCount: null });
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
