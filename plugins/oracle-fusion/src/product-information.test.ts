import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import type { AdfWindow, RichEvent } from './adf-window.js';
import { gtinCriteria, itemCriteria, itemRows } from './product-information.js';
import type { QueryPanel } from './search-page.js';

const SEARCH_REGION = 'r:MAt2:0:pt1:ItemC1:0:sp1:region2';
const TOOLBAR = `${SEARCH_REGION}:0:rstab:_ATp`;
const RESULTS = `${TOOLBAR}:table1`;
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

const panel: QueryPanel = {
  id: `${SEARCH_REGION}:0:efqrp`,
  collapsed: true,
  values: { [`${SEARCH_REGION}:0:efqrp:value30`]: '00087295247914' },
  fieldsByLabel: new Map(),
  datePatterns: new Map(),
  checkboxValues: new Map(),
  choices: new Map(),
  addableFields: new Map(),
};

const taskPage = respond(
  `<div id="${TOOLBAR}:ATex"></div>`,
  `new AdfRichRegion('r:MAt2'),new AdfRichRegion('${SEARCH_REGION}'),new AdfRichTable('${RESULTS}',{})`,
);

const resultRow = (key: string, item: string, organization: string) =>
  `<tr _afrRK="${key}"><td _afrRH="true">&nbsp;</td><td _afrDetCol="true"></td><td><div><table _afrIT="1"><tr>` +
  `<td><a id="${RESULTS}:${key}:itmNoLnkForSearch">${item}</a></td><td>Spark Plug - Laser Platinum</td>` +
  `<td>Approved</td><td>${organization}</td></tr></table></div></td></tr>`;

const searched = respond(
  `<table><tr><th id="${RESULTS}:rh" _afrRH="true">&nbsp;</th><th id="${RESULTS}:ItemNumber">Item</th>` +
    `<th id="${RESULTS}:description">Description</th><th id="${RESULTS}:ApprovalStatus">Approval Status</th>` +
    `<th id="${RESULTS}:OrganizationId5">Organization</th></tr></table>` +
    `<div id="${RESULTS}::db"><table _rowCount="2">` +
    resultRow('0', '4115-NGK', '100000') +
    resultRow('1', '4115-NGK', 'GA0081') +
    '</table></div>',
);

const itemPage = respond(
  `<div id="${TAB}"><h1>Edit Item: 4115-NGK (100000)</h1>` +
    `<div id="${A}panelTabbed1"><a id="${A}srel::disAcr">Relationships</a></div>` +
    `<div id="${A}canb"><a role="button">Cancel</a></div></div>`,
  `new AdfRichRegion('${TAB}'),new AdfRichPanelTabbed('${A}panelTabbed1',{}),` +
    `new AdfRichCommandToolbarButton('${A}canb',{})`,
);

const relationshipsTab = respond(
  `<div id="${A}np1"><a id="${A}np1:cni3">GTIN</a></div>`,
  `new AdfRichNavigationPane('${A}np1',{})`,
);

const gtinTab = respond(
  `<table><tr><th id="${GTIN_TABLE}:c8" _afrRH="true">&nbsp;</th><th id="${GTIN_TABLE}:cl6">GTIN</th>` +
    `<th id="${GTIN_TABLE}:cl9">UOM</th><th id="${GTIN_TABLE}:c1">Party Type</th></tr></table>` +
    `<div id="${GTIN_TABLE}::db"><table _rowCount="1"><tr _afrRK="0"><td _afrRH="true">&nbsp;</td>` +
    '<td _afrDetCol="true"></td><td>00087295247914</td><td>EACH</td><td></td></tr></table></div>',
  `new AdfRichTable('${GTIN_TABLE}',{})`,
);

const backToResults = respond('<h1>Manage Items</h1><h1>Search Results</h1>');

const scriptedWindow = (responses: RichResponse[]) => {
  const events: RichEvent[] = [];
  const adfWindow: AdfWindow = {
    homeHtml: '',
    submit: async event => {
      events.push(event);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected event on ${event.source}`);
      return next;
    },
    download: async () => {
      throw new Error('no downloads');
    },
  };
  return { adfWindow, events };
};

const read = (adfWindow: AdfWindow, pick?: Parameters<typeof itemRows.read>[1]['pick']) =>
  itemRows.read(
    { adfWindow, taskPage, response: searched, panel, report: () => undefined },
    {
      pick,
      relationships: ['gtins'],
    },
  );

describe('Manage Items criteria', () => {
  test('search one item number exactly and clear every other criterion', () => {
    expect(itemCriteria('4115-NGK')).toEqual([
      { label: 'Item Operator', text: '=', leading: true },
      { label: 'Item', text: '4115-NGK' },
      { label: 'Description', text: '' },
      { label: 'Keyword', text: '' },
      { label: 'GTIN', text: '' },
    ]);
  });

  test('search one GTIN exactly, with no item, description or keyword', () => {
    expect(gtinCriteria('00087295247914')).toEqual([
      { label: 'Item', text: '' },
      { label: 'Description', text: '' },
      { label: 'Keyword', text: '' },
      { label: 'GTIN Operator', text: '=', leading: true },
      { label: 'GTIN', text: '00087295247914' },
    ]);
  });
});

describe('itemRows', () => {
  test('reads each result row with its key, leaving item pages closed unless picked', async () => {
    const { adfWindow, events } = scriptedWindow([]);
    const found = await read(adfWindow);
    expect(found.rows).toEqual([
      {
        rowKey: '0',
        columns: {
          Item: '4115-NGK',
          Description: 'Spark Plug - Laser Platinum',
          'Approval Status': 'Approved',
          Organization: '100000',
        },
      },
      expect.objectContaining({ rowKey: '1', columns: expect.objectContaining({ Organization: 'GA0081' }) }),
    ]);
    expect(found.relationships.size).toBe(0);
    expect(events).toEqual([]);
  });

  test('opens a picked row’s item page, reads its GTINs and closes it with Cancel', async () => {
    const { adfWindow, events } = scriptedWindow([itemPage, relationshipsTab, gtinTab, backToResults]);
    const found = await read(adfWindow, rows => rows.filter(row => row.columns.Organization === '100000'));
    expect(found.relationships.get('0')).toEqual({
      gtins: [{ GTIN: '00087295247914', UOM: 'EACH', 'Party Type': '' }],
    });
    expect(events.map(event => event.source)).toEqual([
      `${RESULTS}:0:itmNoLnkForSearch`,
      `${A}srel`,
      `${A}np1:cni3`,
      `${A}canb`,
    ]);
  });

  test('fails when Cancel leaves the item page open', async () => {
    const { adfWindow, events } = scriptedWindow([itemPage, relationshipsTab, gtinTab, itemPage]);
    await expect(read(adfWindow, rows => rows.slice(0, 1))).rejects.toThrow(
      'Cancel did not close the Oracle Fusion item page of 4115-NGK.',
    );
    expect(events.map(event => event.source).filter(source => source === `${A}canb`)).toHaveLength(1);
  });

  test('fails when Cancel answers with a question', async () => {
    const asked = respond('<h1>Manage Items</h1>', "AdfPage.PAGE.findComponent('r:MAt3:0:warn').show();");
    const { adfWindow } = scriptedWindow([itemPage, relationshipsTab, gtinTab, asked]);
    await expect(read(adfWindow, rows => rows.slice(0, 1))).rejects.toThrow(/Cancel did not close/);
  });

  test('takes the Add Fields dialog the results page sets up for no question', async () => {
    const withDialog = respond(
      `<h1>Manage Items</h1><div id="${SEARCH_REGION}:0:addFP::content"><div id="${SEARCH_REGION}:0:addFieldsDialog"></div></div>`,
      `new AdfRichDialog('${SEARCH_REGION}:0:addFieldsDialog',{})`,
    );
    const { adfWindow } = scriptedWindow([itemPage, relationshipsTab, gtinTab, withDialog]);
    await expect(read(adfWindow, rows => rows.slice(0, 1))).resolves.toMatchObject({ rows: expect.any(Array) });
  });

  test('closes the item page when reading it fails, and reports the failure', async () => {
    const { adfWindow, events } = scriptedWindow([itemPage, respond('<div></div>'), backToResults]);
    await expect(read(adfWindow, rows => rows.slice(0, 1))).rejects.toThrow(
      'The Oracle Fusion item page of 4115-NGK has no GTIN sub-tab.',
    );
    expect(events.at(-1)?.source).toBe(`${A}canb`);
  });
});
