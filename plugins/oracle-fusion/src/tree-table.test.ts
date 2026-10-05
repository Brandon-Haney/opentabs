import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse, viewportDeltas } from './adf-protocol.js';
import {
  disclosureEvent,
  findTreeTableId,
  inTreeOrder,
  parseTreeRowCount,
  parseTreeRows,
  parseTreeTable,
  type TreeRow,
} from './tree-table.js';

const TABLE = 'r:app:tt1';

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<?Adf-Rich-Response-Type ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const row = (key: string, ancestors: string, label: string, cells: string[], expandable = true): string =>
  `<tr _afrRK="${key}"${ancestors ? ` _afrAP="${ancestors}"` : ''}><td _afrRH="true">&nbsp;</td>` +
  `<td _afrNdCol="1"><div>${expandable ? `<span _afrDisImg="1"><a id="${TABLE}:${key}::di" title="Expand"></a></span>` : ''}` +
  `<span>${label}</span></div></td>` +
  `<td><table _afrIT="1"><tr>${cells.map(cell => `<td><span>${cell}</span>${cell ? '' : '&nbsp;'}</td>`).join('')}</tr></table></td></tr>`;

const headings =
  `<table><tr><th id="${TABLE}:column1" rowspan="2">&nbsp;</th><th id="${TABLE}:NodeClmId" rowspan="2">Item</th>` +
  `<th id="${TABLE}:c26" rowspan="2">Item Description</th><th id="${TABLE}:pQtyClm1" colspan="3">Quantity</th></tr>` +
  `<tr><th id="${TABLE}:column2">On Hand</th><th id="${TABLE}:column3">Receiving</th>` +
  `<th id="${TABLE}:column5">UOM Name</th></tr></table>` +
  // A dialog left open on the page brings headings of its own.
  '<table><tr><th id="r:app:table3:c34">Quantity Type</th><th id="r:app:table3:column26">Total</th></tr></table>';

const setup = (disclosed: string): string =>
  `AdfPage.PAGE.addComponents(new AdfRichTreeTable('${TABLE}',{'fetchSize':16,'disclosedRowKeys':{${disclosed}},'x':1}));`;

const searched = respond(
  `${headings}<table summary="Results" _rowCount="2" _startRow="0">` +
    row('4', '', 'Item A-1', ['Widget', '3', '', 'EACH']) +
    row('5', '4', 'Organization M1', ['', '3', '', 'EACH']) +
    '</table>',
  setup(`'0':true,'4':true`),
);

describe('parseTreeTable', () => {
  test('returns null when the response set up no tree table', () => {
    expect(parseTreeTable(respond('<div></div>'))).toBeNull();
    expect(findTreeTableId(respond('<div></div>'))).toBeNull();
  });

  test('reads the table id, value columns, row count and expanded keys', () => {
    const table = parseTreeTable(searched);
    expect(table?.id).toBe(TABLE);
    expect(findTreeTableId(searched)).toBe(TABLE);
    expect(table?.columns).toEqual(['Item Description', 'On Hand', 'Receiving', 'UOM Name']);
    expect(table?.rowCount).toBe(2);
    expect(table?.disclosedKeys).toEqual(['0', '4']);
  });

  test('reads rows with their ancestors, label and cells', () => {
    expect(parseTreeTable(searched)?.rows).toEqual([
      { key: '4', ancestors: [], label: 'Item A-1', expandable: true, cells: ['Widget', '3', '', 'EACH'] },
      { key: '5', ancestors: ['4'], label: 'Organization M1', expandable: true, cells: ['', '3', '', 'EACH'] },
    ]);
  });

  test('reads an empty result', () => {
    const empty = respond(`${headings}<div>No results found.</div>`, setup(''));
    expect(parseTreeTable(empty)).toMatchObject({ rows: [], rowCount: null, disclosedKeys: [] });
  });
});

describe('parseTreeRows', () => {
  const inserted = respond(
    '<table summary="Results" totalInserted="1" _rowCount="4" _startRow="2">' +
      row('6', '4_5', 'Subinventory S1', ['', '3', '', 'EACH']) +
      row('7', '4_5_6', 'Locator B1', ['', '3', '', 'EACH'], false) +
      '</table>',
  );

  test('reads the rows a disclosure inserted', () => {
    expect(parseTreeRows(inserted).map(({ key, ancestors, expandable }) => ({ key, ancestors, expandable }))).toEqual([
      { key: '6', ancestors: ['4', '5'], expandable: true },
      { key: '7', ancestors: ['4', '5', '6'], expandable: false },
    ]);
    expect(parseTreeRowCount(inserted)).toBe(4);
  });

  test('ignores the rows and row count of a dialog table left on the page', () => {
    const withDialog = respond(
      '<div id="d"><table _rowCount="3"><tr _afrRK="1"><td><span>Total</span></td>' +
        '<td><table _afrIT="1"><tr><td>4</td></tr></table></td></tr></table></div>' +
        '<table summary="Results" _rowCount="1">' +
        row('6', '4_5', 'Subinventory S1', ['', '3', '', 'EACH']) +
        '</table>',
    );
    expect(parseTreeRows(withDialog).map(treeRow => treeRow.key)).toEqual(['6']);
    expect(parseTreeRowCount(withDialog)).toBe(1);
  });

  test('treats an unknown row count as absent', () => {
    expect(parseTreeRowCount(respond('<table _rowCount="-1"></table>'))).toBeNull();
    expect(parseTreeRowCount(respond('<span></span>'))).toBeNull();
  });
});

describe('inTreeOrder', () => {
  const node = (key: string, ancestors: string[]): TreeRow => ({
    key,
    ancestors,
    label: key,
    expandable: false,
    cells: [],
  });

  test('places each row before its descendants and keeps sibling order', () => {
    const levelByLevel = [node('1', []), node('2', []), node('3', ['1']), node('4', ['2']), node('5', ['1', '3'])];
    expect(inTreeOrder(levelByLevel).map(item => item.key)).toEqual(['1', '3', '5', '2', '4']);
  });
});

describe('events', () => {
  test('asks for a large viewport with the search', () => {
    expect(viewportDeltas(TABLE)).toBe(`{${TABLE}={viewportSize=10000}}`);
  });

  test('sends the expanded keys as component state alongside a disclosure and a fetch', () => {
    const event = disclosureEvent(TABLE, ['0', '4', '5'], 3, { 'r:app:q1::saveSearch': 'All' });
    expect(event.source).toBe(TABLE);
    expect(event.process).toBe(`${TABLE},${TABLE}`);
    expect(event.deltas).toBe(`{${TABLE}={viewportSize=10000,disclosedRowKeys=0$afr$4$afr$5}}`);
    expect(event.fields).toEqual({ 'r:app:q1::saveSearch': 'All' });
    expect(event.payload).toBe(
      '<a xmlns="http://oracle.com/richClient/comm" n="2"><m><k v="type"><s>rowDisclosure</s></k></m>' +
        '<m><k v="id"><n>3</n></k><k v="subtype"><n>5</n></k><k v="suppressMessageClear"><s>true</s></k>' +
        '<k v="type"><s>fetch</s></k></m></a>',
    );
  });
});
