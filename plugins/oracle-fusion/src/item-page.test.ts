import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import {
  cancelItemEvent,
  findItemLink,
  findRelationshipLink,
  findShownPopup,
  openItemEvent,
  parseRelationshipTable,
  readItemPage,
  showRelationshipEvent,
  showRelationshipsEvent,
  showsItemPage,
  withControlsOf,
} from './item-page.js';

const SEARCH_REGION = 'r:MAt2:0:pt1:ItemC1:0:sp1:region2';
const RESULTS = `${SEARCH_REGION}:0:rstab:_ATp:table1`;
const TAB = 'r:MAt3';
const A = `${TAB}:0:pt1:ap1:`;
const GTIN_TABLE = `${A}GTIN:1:GTINXrefsResults:_ATp:t1`;

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const taskPage = respond(
  '<div></div>',
  `new AdfRichRegion('r:MAt2'),new AdfRichRegion('${SEARCH_REGION}'),new AdfRichRegion('${SEARCH_REGION}:0:muC')`,
);

const results = respond(
  `<div id="${RESULTS}::db"><table>` +
    `<tr _afrRK="0"><td><a id="${RESULTS}:0:itmNoLnkForSearch">4115-NGK</a></td></tr>` +
    `<tr _afrRK="1"><td><a id="${RESULTS}:1:itmNoLnkForSearch">4115-NGK</a></td></tr></table></div>`,
);

/** The item page as Manage Items opens it, in edit mode. */
const itemPage = (title = 'Edit Item: 4115-NGK (100000)') =>
  respond(
    `<div id="${TAB}"><h1>${title}</h1><h1>Unit of Measure</h1>` +
      `<div id="${A}panelTabbed1"><a id="${A}sover::disAcr">Overview</a><a id="${A}srel::disAcr">Relationships</a></div>` +
      `<input name="${A}it3" value="Spark Plug"><input name="r:MAt2:0:pt1:other" value="x">` +
      `<div id="${A}csavebtn"><a role="button">Save</a></div><div id="${A}canb"><a role="button">Cancel</a></div></div>`,
    `new AdfRichRegion('r:_FOr1'),new AdfRichRegion('${TAB}'),new AdfRichRegion('${A}r10'),` +
      `new AdfRichPanelTabbed('r:MAtbs',{}),new AdfRichPanelTabbed('${A}panelTabbed1',{}),` +
      `new AdfRichCommandToolbarButton('${A}csavebtn',{}),new AdfRichCommandToolbarButton('${A}canb',{})`,
  );

const relationships = respond(
  `<div id="${A}np1"><a id="${A}np1:cni1">Related Items</a><a id="${A}np1:cni2">Trading Partner Items</a>` +
    `<a id="${A}np1:cni3">GTIN</a><a id="${A}np1:cni4">Cross-References</a></div>` +
    `<input name="${A}r10:0:inputText1" value="">`,
  `new AdfRichNavigationPane('${A}np1',{})`,
);

const gtinRow = (key: string, cells: string[]) =>
  `<tr _afrRK="${key}"><td _afrRH="true">&nbsp;</td><td _afrDetCol="true"><a title="Expand"></a></td>` +
  `${cells.map(cell => `<td><span>${cell}</span></td>`).join('')}</tr>`;

const gtins = (rowCount: number) =>
  respond(
    `<table><tr><th id="${GTIN_TABLE}:c8" _afrRH="true">&nbsp;</th><th id="${GTIN_TABLE}:cl6">GTIN</th>` +
      `<th id="${GTIN_TABLE}:cl9">UOM</th><th id="${GTIN_TABLE}:c1">Party Type</th>` +
      `<th id="${GTIN_TABLE}:c2">Party Name</th></tr></table>` +
      `<div id="${GTIN_TABLE}::db"><table _rowCount="${rowCount}">` +
      gtinRow('0', ['00087295141151', 'EACH', 'Manufacturer', 'Manufacturer 325']) +
      gtinRow('1', ['00087295247914', 'EACH', '', '']) +
      '</table></div>',
    `new AdfRichTable('${GTIN_TABLE}',{})`,
  );

describe('opening an item from the results', () => {
  test('finds the item link of one row among rows showing the same item', () => {
    expect(findItemLink(results, RESULTS, '1', '4115-NGK')).toBe(`${RESULTS}:1:itmNoLnkForSearch`);
    expect(findItemLink(results, RESULTS, '1', '3410-NGK')).toBeNull();
  });

  test('sends the row’s selection and the link click in one request, rendering the search region', () => {
    expect(openItemEvent(taskPage, RESULTS, '1', `${RESULTS}:1:itmNoLnkForSearch`, { f: '1' })).toEqual({
      source: `${RESULTS}:1:itmNoLnkForSearch`,
      payload: expect.stringContaining('<s>action</s>'),
      preceding: [{ source: RESULTS, payload: expect.stringContaining('<s>selection</s>') }],
      fields: { f: '1' },
      process: `${RESULTS},${SEARCH_REGION}:0:rstab:_ATp`,
      render: SEARCH_REGION,
      deltas: `{${RESULTS}={viewportSize=10000,selectedRowKeys=1}}`,
    });
  });
});

describe('readItemPage', () => {
  test('reads the page’s tab, Relationships tab, Cancel button and controls', () => {
    expect(readItemPage(itemPage(), '4115-ngk', '100000')).toEqual({
      item: '4115-NGK',
      organization: '100000',
      tab: TAB,
      relationshipsTab: `${A}srel`,
      tabSet: `${A}panelTabbed1`,
      cancelButton: `${A}canb`,
      fields: { [`${A}it3`]: 'Spark Plug' },
    });
  });

  test('accepts the page opened read-only', () => {
    expect(readItemPage(itemPage('Item: 4115-NGK (100000)'), '4115-NGK', '100000').item).toBe('4115-NGK');
  });

  test('refuses a page showing another item or organization', () => {
    expect(() => readItemPage(itemPage(), '3410-NGK', '100000')).toThrow(
      'Oracle Fusion opened item 4115-NGK (100000) instead of 3410-NGK (100000).',
    );
    expect(() => readItemPage(itemPage(), '4115-NGK', 'GA0081')).toThrow(/instead of 4115-NGK \(GA0081\)/);
    expect(() => readItemPage(respond('<h1>Manage Items</h1>'), '4115-NGK', '100000')).toThrow(
      'Oracle Fusion did not open the item page of 4115-NGK.',
    );
  });

  test('finds a popup a response shows, but not one it only sets up', () => {
    expect(findShownPopup(respond('<div></div>', "AdfPage.PAGE.findComponent('r:MAt3:0:warn').show();"))).toBe(
      'r:MAt3:0:warn',
    );
    expect(findShownPopup(respond('<div></div>', "new AdfRichDialog('r:MAt2:0:addFieldsDialog',{})"))).toBeNull();
  });

  test('tells an item page from the page Cancel returns to', () => {
    expect(showsItemPage(itemPage())).toBe(true);
    expect(showsItemPage(respond('<h1>Manage Items</h1><h1>Search Results</h1>'))).toBe(false);
  });
});

describe('the Relationships tab', () => {
  const page = readItemPage(itemPage(), '4115-NGK', '100000');

  test('shows the tab within its tab set, then a sub-tab under the page’s tab', () => {
    expect(showRelationshipsEvent(page)).toMatchObject({
      source: `${A}srel`,
      payload: expect.stringContaining('<k v="expand"><b>1</b></k>'),
      process: `${A}panelTabbed1`,
    });
    const link = findRelationshipLink(relationships, page, 'gtins');
    expect(link).toBe(`${A}np1:cni3`);
    expect(showRelationshipEvent(page, link ?? '')).toMatchObject({ process: TAB, render: TAB });
    expect(findRelationshipLink(relationships, page, 'crossReferences')).toBe(`${A}np1:cni4`);
  });

  test('keeps the controls each response adds', () => {
    expect(withControlsOf(page, relationships).fields).toEqual({
      [`${A}it3`]: 'Spark Plug',
      [`${A}r10:0:inputText1`]: '',
    });
  });

  test('reads the GTIN table by its headings, past the expand column', () => {
    expect(parseRelationshipTable(gtins(2), page, 'gtins')).toEqual([
      { GTIN: '00087295141151', UOM: 'EACH', 'Party Type': 'Manufacturer', 'Party Name': 'Manufacturer 325' },
      { GTIN: '00087295247914', UOM: 'EACH', 'Party Type': '', 'Party Name': '' },
    ]);
  });

  test('refuses a sub-tab without its table, or with rows left unrendered', () => {
    expect(() => parseRelationshipTable(gtins(2), page, 'crossReferences')).toThrow(/shows no Cross-References table/);
    expect(() => parseRelationshipTable(gtins(30), page, 'gtins')).toThrow(
      /holds 30 rows, but Oracle Fusion rendered 2/,
    );
  });

  test('closes the page with Cancel, never Save', () => {
    expect(cancelItemEvent(page)).toMatchObject({
      source: `${A}canb`,
      payload: expect.stringContaining('<s>action</s>'),
      process: TAB,
      render: TAB,
    });
  });
});
