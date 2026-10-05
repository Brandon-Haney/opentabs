import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import {
  expandPanelEvent,
  exportEvent,
  findExportButton,
  findResultsTable,
  formatDate,
  leadingChangeEvent,
  parseExport,
  parseQueryPanel,
  refreshQueryPanel,
  searchEvent,
  unappliedCriteria,
} from './search-page.js';

const PANEL = 'r:app:q1';

const respond = (html: string, script = ''): RichResponse => {
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<?Adf-Rich-Response-Type ?>\n<content action="/x"><fragment><![CDATA[${html}]]></fragment>` +
      `<script><![CDATA[${script}]]></script></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

const savedSearch =
  `<label for="${PANEL}::saveSearch::content">Saved Search</label>` +
  `<select id="${PANEL}::saveSearch::content" name="${PANEL}::saveSearch"><option value="All" selected>All</option></select>`;

const expandedPanel = respond(
  `<div id="${PANEL}" role="search"><a id="${PANEL}::_afrDscl" aria-expanded="true"></a>${savedSearch}` +
    `<label for="${PANEL}:operator0::content">Organization</label>` +
    `<label for="${PANEL}:value00::content">Organization</label>` +
    `<input id="${PANEL}:value00::content" name="${PANEL}:value00" type="text" value="M1">` +
    `<label for="${PANEL}:operator2::content">Description Operator</label>` +
    `<select id="${PANEL}:operator2::content" name="${PANEL}:operator2"><option value="STARTSWITH" selected>Starts with</option><option value="CONTAINS">Contains</option></select>` +
    `<label for="${PANEL}:value30::content">From Date</label>` +
    `<input id="${PANEL}:value30::content" name="${PANEL}:value30" value="1/2/25">` +
    `<input type="hidden" name="${PANEL}:value30::lcId" value="1/2/2025">` +
    `<label for="${PANEL}:value80::content">Costed only</label>` +
    `<input id="${PANEL}:value80::content" name="${PANEL}:value80" type="checkbox" value="t">` +
    `</div><div id="r:app:AT1:_ATp:ATex"></div>`,
  `AdfPage.PAGE.addComponents(new AdfRichInputText('${PANEL}:value00',{'simple':true}),` +
    `new AdfRichInputDate('${PANEL}:value30',{'simple':true,'converter':new TrDateTimeConverter('M/d/yy',null,'1/2/25','DATE')}));`,
);

const collapsedPanel = respond(
  `<div id="${PANEL}" role="search"><a id="${PANEL}::_afrDscl" aria-expanded="false"></a>${savedSearch}</div>`,
);

const requirePanel = (response: RichResponse) => {
  const panel = parseQueryPanel(response);
  if (!panel) throw new Error('fixture has no query panel');
  return panel;
};

describe('parseQueryPanel', () => {
  test('reads a panel by its id when the page holds a lookup dialog’s panel too', () => {
    const lookup = 'r:app:q1:value00::_afrLovInternalQueryId';
    const page = respond(
      `<div id="${lookup}" role="search"><label for="${lookup}:value00::content">Purchase Order</label>` +
        `<input id="${lookup}:value00::content" name="${lookup}:value00" value="ATL"></div>` +
        `<div id="${PANEL}" role="search"><label for="${PANEL}:value10::content">Item</label>` +
        `<input id="${PANEL}:value10::content" name="${PANEL}:value10" value="A-1"></div>`,
    );
    expect(parseQueryPanel(page, PANEL)?.fieldsByLabel.get('Item')).toBe(`${PANEL}:value10`);
    expect(parseQueryPanel(page, PANEL)?.fieldsByLabel.has('Purchase Order')).toBe(false);
    expect(parseQueryPanel(page, lookup)?.values).toEqual({ [`${lookup}:value00`]: 'ATL' });
    expect(parseQueryPanel(page, 'r:missing')).toBeNull();
  });

  test('returns null when the response has no query panel', () => {
    expect(parseQueryPanel(respond('<div id="other"></div>'))).toBeNull();
  });

  test('reads the values a browser would submit, leaving out an unchecked checkbox', () => {
    expect(requirePanel(expandedPanel).values).toEqual({
      [`${PANEL}::saveSearch`]: 'All',
      [`${PANEL}:value00`]: 'M1',
      [`${PANEL}:operator2`]: 'STARTSWITH',
      [`${PANEL}:value30`]: '1/2/25',
      [`${PANEL}:value30::lcId`]: '1/2/2025',
    });
  });

  test('maps each label to its control, skipping labels whose target is not rendered', () => {
    const panel = requirePanel(expandedPanel);
    expect(panel.fieldsByLabel.get('Organization')).toBe(`${PANEL}:value00`);
    expect(panel.fieldsByLabel.get('Description Operator')).toBe(`${PANEL}:operator2`);
    expect(panel.fieldsByLabel.get('From Date')).toBe(`${PANEL}:value30`);
  });

  test('reads the display pattern of date fields only', () => {
    expect([...requirePanel(expandedPanel).datePatterns]).toEqual([[`${PANEL}:value30`, 'M/d/yy']]);
  });

  test('reports whether the panel is folded', () => {
    expect(requirePanel(expandedPanel).collapsed).toBe(false);
    expect(requirePanel(collapsedPanel).collapsed).toBe(true);
  });
});

describe('expandPanelEvent', () => {
  test('tells the server the panel is open on the client', () => {
    const event = expandPanelEvent(requirePanel(collapsedPanel));
    expect(event.source).toBe(PANEL);
    expect(event.render).toBe(PANEL);
    expect(event.deltas).toBe(`{${PANEL}={disclosed=true}}`);
    expect(event.fields).toEqual({ [`${PANEL}::saveSearch`]: 'All' });
  });
});

describe('refreshQueryPanel', () => {
  const partial = respond(
    `<label for="${PANEL}:value30::content">From Date</label><input id="${PANEL}:value30::content" name="${PANEL}:value30" value="">` +
      `<input id="${PANEL}:value90::content" name="${PANEL}:value90" type="checkbox" value="t">` +
      `<input name="other:value00" value="unrelated">`,
  );

  test('overlays the re-rendered controls and keeps the rest', () => {
    const panel = refreshQueryPanel(requirePanel(expandedPanel), partial);
    expect(panel.values[`${PANEL}:value30`]).toBe('');
    expect(panel.values[`${PANEL}:value00`]).toBe('M1');
    expect(panel.values).not.toHaveProperty('other:value00');
    expect(panel.fieldsByLabel.get('Organization')).toBe(`${PANEL}:value00`);
    expect(panel.datePatterns.get(`${PANEL}:value30`)).toBe('M/d/yy');
  });

  test('drops the value of a control re-rendered as not submitted', () => {
    const checked = { ...requirePanel(expandedPanel), values: { [`${PANEL}:value90`]: 't' } };
    expect(refreshQueryPanel(checked, partial).values).not.toHaveProperty(`${PANEL}:value90`);
  });

  test('leaves the panel unchanged when the response rendered none of it', () => {
    const panel = requirePanel(expandedPanel);
    expect(refreshQueryPanel(panel, respond('<span id="f1::postscript"></span>'))).toEqual(panel);
  });
});

describe('leadingChangeEvent', () => {
  test('commits a changed leading criterion on its own', () => {
    const event = leadingChangeEvent(requirePanel(expandedPanel), { label: 'Organization', text: 'M2', leading: true });
    expect(event?.source).toBe(`${PANEL}:value00`);
    expect(event?.payload).toContain('<k v="autoSubmit"><b>1</b></k>');
    expect(event?.payload).toContain('<k v="type"><s>valueChange</s></k>');
    expect(event?.fields?.[`${PANEL}:value00`]).toBe('M2');
    expect(event?.fields?.[`${PANEL}:value30`]).toBe('1/2/25');
  });

  test('returns null when the value is already set or the criterion is not leading', () => {
    const panel = requirePanel(expandedPanel);
    expect(leadingChangeEvent(panel, { label: 'Organization', text: 'M1', leading: true })).toBeNull();
    expect(leadingChangeEvent(panel, { label: 'Organization', text: 'M2' })).toBeNull();
    expect(leadingChangeEvent(panel, { label: 'From Date', date: '2026-09-01' })).toBeNull();
  });
});

describe('formatDate', () => {
  test.each([
    ['M/d/yy', '9/1/26'],
    ['MM/dd/yyyy', '09/01/2026'],
    ['dd.MM.yyyy', '01.09.2026'],
    ['yyyy-MM-dd', '2026-09-01'],
  ])('renders %s', (pattern, expected) => {
    expect(formatDate('2026-09-01', pattern)).toBe(expected);
  });

  test.each([
    ['start', 'M/d/yy h:mm a', '9/1/26 12:00 AM'],
    ['end', 'M/d/yy h:mm a', '9/1/26 11:59 PM'],
    ['end', 'yyyy-MM-dd HH:mm:ss', '2026-09-01 23:59:59'],
  ] as const)('renders the %s of the day in %s', (timeOfDay, pattern, expected) => {
    expect(formatDate('2026-09-01', pattern, timeOfDay)).toBe(expected);
  });

  test('refuses a pattern with month names', () => {
    expect(() => formatDate('2026-09-01', 'dd-MMM-yyyy')).toThrow(/cannot write/);
  });
});

describe('searchEvent', () => {
  test('overrides the named criteria and submits the rest unchanged', () => {
    const event = searchEvent(requirePanel(expandedPanel), [
      { label: 'Organization', text: 'M2' },
      { label: 'Description Operator', text: 'CONTAINS' },
      { label: 'From Date', date: '2026-09-01' },
    ]);
    expect(event.source).toBe(PANEL);
    expect(event.payload).toContain('<k v="clearAll"/><k v="type"><s>query</s></k>');
    expect(event.fields).toEqual({
      [`${PANEL}::saveSearch`]: 'All',
      [`${PANEL}:value00`]: 'M2',
      [`${PANEL}:operator2`]: 'CONTAINS',
      [`${PANEL}:value30`]: '9/1/26',
      [`${PANEL}:value30::lcId`]: '',
    });
  });

  test('clears a date criterion given as null', () => {
    const event = searchEvent(requirePanel(expandedPanel), [{ label: 'From Date', date: null }]);
    expect(event.fields?.[`${PANEL}:value30`]).toBe('');
  });

  test('names the fields on the page when a label is missing', () => {
    expect(() => searchEvent(requirePanel(expandedPanel), [{ label: 'Item', text: 'A' }])).toThrow(
      /no "Item" field.*Organization/,
    );
  });

  test('ticks and unticks a checkbox the way a browser submits one', () => {
    const panel = requirePanel(expandedPanel);
    const ticked = searchEvent(panel, [{ label: 'Costed only', checked: true }]);
    expect(ticked.fields?.[`${PANEL}:value80`]).toBe('t');
    const unticked = searchEvent({ ...panel, values: ticked.fields ?? {} }, [{ label: 'Costed only', checked: false }]);
    expect(unticked.fields).not.toHaveProperty(`${PANEL}:value80`);
  });

  test('picks a dropdown option by the text the page shows', () => {
    const event = searchEvent(requirePanel(expandedPanel), [{ label: 'Description Operator', option: 'Contains' }]);
    expect(event.fields?.[`${PANEL}:operator2`]).toBe('CONTAINS');
  });

  test('names the options when a dropdown has no such option', () => {
    expect(() =>
      searchEvent(requirePanel(expandedPanel), [{ label: 'Description Operator', option: 'Ends with' }]),
    ).toThrow(/no option "Ends with".*Starts with, Contains/);
    expect(() => searchEvent(requirePanel(expandedPanel), [{ label: 'Organization', option: 'M1' }])).toThrow(
      /not a dropdown/,
    );
  });

  test('refuses a tick for a field that is not a checkbox', () => {
    expect(() => searchEvent(requirePanel(expandedPanel), [{ label: 'Organization', checked: true }])).toThrow(
      /not a checkbox/,
    );
  });

  test('refuses a date for a field that is not a date field', () => {
    expect(() => searchEvent(requirePanel(expandedPanel), [{ label: 'Organization', date: '2026-09-01' }])).toThrow(
      /not a date field/,
    );
  });
});

describe('unappliedCriteria', () => {
  const criteria = [
    { label: 'Organization', text: 'm1 ' },
    { label: 'Description Operator', text: 'CONTAINS' },
    { label: 'From Date', date: '2025-01-02' },
    { label: 'Costed only', checked: false },
  ];

  test('names each criterion the page kept a different value for', () => {
    const sent = searchEvent(requirePanel(expandedPanel), criteria);
    expect(unappliedCriteria(sent, requirePanel(expandedPanel), criteria)).toEqual([
      { label: 'Description Operator', sent: 'CONTAINS', shown: 'STARTSWITH' },
    ]);
  });

  test('has nothing to compare once the panel has folded away', () => {
    const sent = searchEvent(requirePanel(expandedPanel), criteria);
    expect(unappliedCriteria(sent, requirePanel(collapsedPanel), criteria)).toEqual([]);
  });
});

describe('export', () => {
  test('finds the export button and submits the panel with the click', () => {
    const button = findExportButton(expandedPanel);
    expect(button).toBe('r:app:AT1:_ATp:ATex');
    const event = exportEvent(requirePanel(collapsedPanel), button ?? '');
    expect(event.source).toBe('r:app:AT1:_ATp:ATex');
    expect(event.fields).toEqual({ [`${PANEL}::saveSearch`]: 'All' });
  });

  test('finds the results table that shares the export button’s toolbar', () => {
    const page = respond(
      '<div id="r:app:AT1:_ATp:ATex"></div>',
      "new AdfRichTable('r:app:other:table1',{}),new AdfRichTable('r:app:AT1:_ATp:t1',{})",
    );
    expect(findResultsTable(page)).toBe('r:app:AT1:_ATp:t1');
    expect(findResultsTable(collapsedPanel)).toBeNull();
  });

  test('returns null when the page has no export button', () => {
    expect(findExportButton(collapsedPanel)).toBeNull();
  });

  test('keys each row by heading and drops columns without one', () => {
    const html =
      '<html><body><table><tr><th></th><th>Transaction</th><th>Item</th></tr>' +
      '<tr><td></td><td>1001</td><td> A-1 </td></tr><tr><td></td><td>1002</td></tr></table></body></html>';
    expect(parseExport(html)).toEqual([
      { Transaction: '1001', Item: 'A-1' },
      { Transaction: '1002', Item: '' },
    ]);
  });

  test('returns no rows for an export that has only headings', () => {
    expect(parseExport('<table><tr><th>Transaction</th></tr></table>')).toEqual([]);
  });
});

describe('parseExport with column groups', () => {
  test('takes each column’s heading from the lowest heading row it has one in', () => {
    const html =
      '<table><tr><th rowspan="2"></th><th rowspan="2">Line</th><th rowspan="2">Item</th>' +
      '<th colspan="2">Additional Information</th></tr>' +
      '<tr><th>received_qty</th><th>damaged_qty</th></tr>' +
      '<tr><td></td><td>1</td><td>85105-NHF</td><td>1</td><td></td></tr></table>';
    expect(parseExport(html)).toEqual([{ Line: '1', Item: '85105-NHF', received_qty: '1', damaged_qty: '' }]);
  });

  test('reads an export with heading rows and no records as empty', () => {
    const html = '<table><tr><th rowspan="2">Line</th><th>Group</th></tr><tr><th>received_qty</th></tr></table>';
    expect(parseExport(html)).toEqual([]);
  });
});
