import { describe, expect, test } from 'vitest';
import { parseRichResponse, type RichResponse } from './adf-protocol.js';
import { categoryChangeEvent, findTasksTab, parseHomeTiles } from './work-area.js';

const tasksPanel = (selected: string): RichResponse => {
  const options = ['Inventory', 'Counts', 'Receipts']
    .map((label, index) => `<option value="${index}"${label === selected ? ' selected' : ''}>${label}</option>`)
    .join('');
  const response = parseRichResponse(
    `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[<select name="r:tasks:soc1">${options}</select>]]></fragment></content>`,
  );
  if (!response) throw new Error('fixture is not a rich response');
  return response;
};

describe('categoryChangeEvent', () => {
  test('switches the panel to the named category', () => {
    const event = categoryChangeEvent(tasksPanel('Counts'), 'Inventory');
    expect(event?.source).toBe('r:tasks:soc1');
    expect(event?.fields).toEqual({ 'r:tasks:soc1': '0' });
    expect(event?.payload).toContain('<s>valueChange</s>');
  });

  test('leaves a panel that already lists the category', () => {
    expect(categoryChangeEvent(tasksPanel('Receipts'), 'Receipts')).toBeNull();
  });

  test('names the categories when the one asked for is missing', () => {
    expect(() => categoryChangeEvent(tasksPanel('Inventory'), 'Shipments')).toThrow(
      /no "Shipments" category.*Inventory, Counts, Receipts/,
    );
  });
});

describe('findTasksTab', () => {
  const workArea = (icons: string): RichResponse => {
    const response = parseRichResponse(
      `<?xml version="1.0" ?>\n<content action="/x"><fragment><![CDATA[${icons}]]></fragment></content>`,
    );
    if (!response) throw new Error('fixture is not a rich response');
    return response;
  };
  const icon = (id: string, title: string) => `<img id="pt1:_FOr1:1:_FONSr2:0:${id}::icon" title="${title}">`;

  test('finds the drawer tab whose icon is titled Tasks, whatever the work area calls it', () => {
    const inventory = workArea(
      icon('_FOTsdiScmInvOverviewPage_itemNode_InvTasksList', 'Tasks') + icon('_FOTsdiregionalArea2', 'Quick Search'),
    );
    expect(findTasksTab(inventory)).toBe('pt1:_FOr1:1:_FONSr2:0:_FOTsdiScmInvOverviewPage_itemNode_InvTasksList');
    const products = workArea(icon('_FOTsdiItemWorkareaSearch', 'Search') + icon('_FOTsdiItemRegionalArea', 'Tasks'));
    expect(findTasksTab(products)).toBe('pt1:_FOr1:1:_FONSr2:0:_FOTsdiItemRegionalArea');
  });

  test('returns null for a work area without a Tasks tab', () => {
    expect(findTasksTab(workArea(icon('_FOTsdiItemWorkareaSearch', 'Search')))).toBeNull();
  });
});

describe('parseHomeTiles', () => {
  test('reads the tiles handed to the home page layout script', () => {
    const html =
      `<script>homeLayoutManager.handleDocumentLoad('false', [` +
      `{"id":"c_1","label":"Inventory Management","icon":"box","visible":true,"type":"subcluster","group":"g_1"},` +
      `{"id":"c_2","label":"Purchase \\"Orders\\"","icon":"cart","visible":true,"type":"subcluster","group":"g_1"}]);</script>`;
    expect(parseHomeTiles(html)).toEqual([
      { id: 'c_1', label: 'Inventory Management', group: 'g_1' },
      { id: 'c_2', label: 'Purchase "Orders"', group: 'g_1' },
    ]);
  });

  test('skips objects that are not tiles and text that is not JSON', () => {
    const html = `{"id":"c_1","label":"No group"} {"id":"broken, {"id":"c_3","label":"Tile","group":"g_2"}`;
    expect(parseHomeTiles(html)).toEqual([{ id: 'c_3', label: 'Tile', group: 'g_2' }]);
  });

  test('returns no tiles for a page without any', () => {
    expect(parseHomeTiles('<html><body></body></html>')).toEqual([]);
  });
});
