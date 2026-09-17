import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const {
  addTableRowAction,
  blockOwnerFromSeed,
  buildAddTableRowBody,
  buildDeleteTableRowBody,
  deleteTableRowAction,
  locateTableRow,
  resolveAddTableRowContext,
  rowIdentityFromSeed,
} = await import('./pods-action-table-row.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { PodsModel, PodsObject } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const CREATED = '1789652638665';
const DESCRIPTOR = '{"ActionId":"1","ActionName":"InsertRowBelow","ActionTime":"1789652638645"}';
const IDENTITY = { rowId: '33f26867-0000-0000-0000-000000000000', rowUniqueId: 'fe34c689-0000-0000-0000-000000000000' };
const OWNERS = ['a971e3b3-a0c1-439d-a80d-9496cb84607a', '77431dc3-e9fc-4ac0-bd0c-e65a85182b80'];

const TABLE = '3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829|5';
const ROW_1 = '{3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829}{164}';
const ROW_2 = '{3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829}{181}';
const RUN_BOLD = '{97eb75ae-8f48-4b46-a3fb-ad6a2d6eee7c}{70}';
const RUN_PLAIN = '{97eb75ae-8f48-4b46-a3fb-ad6a2d6eee7c}{72}';
const ROW_1_ID = '11111111-0000-0000-0000-000000000000';
const COLUMNS = ['2e7456a1-0000-0000-0000-000000000000', '94cebd43-0000-0000-0000-000000000000'];

/** A cell with one block holding one paragraph, as the captured table's cells are built. */
const cellObjects = (row: number, column: number, text: string, runRef: string, runSegments = 1): PodsObject[] => {
  const g = `c${row}${column}`;
  return [
    {
      classId: 393252,
      objectId: `${g}|1`,
      properties: [
        469769234,
        '0.5,0,0.75,0.75',
        469780485,
        row === 1 ? ROW_1_ID : 'row2',
        469780486,
        COLUMNS[column] as string,
        603986976,
        `{${g}}{2}`,
      ],
    },
    { classId: 393229, objectId: `${g}|2`, properties: [335562753, '5', 603986975, `{${g}}{3}`] },
    {
      classId: 393230,
      objectId: `${g}|3`,
      properties: [
        335562753,
        '5',
        335562805,
        '2147482948',
        469769250,
        text,
        ...(runSegments > 1 ? [469769746, '3', 469769819, '11'] : []),
        469780485,
        row === 1 ? ROW_1_ID : 'row2',
        469780486,
        COLUMNS[column] as string,
        603987475,
        Array(runSegments).fill(runRef).join(','),
      ],
    },
  ];
};

const model = (): PodsModel => ({
  totalObjects: 0,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{s}{1}'],
    },
    {
      classId: 393250,
      objectId: TABLE,
      properties: [335551831, '2', 335551832, '2', 469780712, COLUMNS.join(','), 603986976, `${ROW_1},${ROW_2}`],
    },
    {
      classId: 393251,
      objectId: '3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829|164',
      properties: [335562771, '1', 469780485, ROW_1_ID, 469780523, 'aaaaaaaa-0000', 603986976, '{c10}{1},{c11}{1}'],
    },
    {
      classId: 393251,
      objectId: '3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829|181',
      properties: [469780485, 'row2', 603986976, '{c20}{1},{c21}{1}'],
    },
    ...cellObjects(1, 0, '8', RUN_BOLD),
    ...cellObjects(1, 1, 'Staff lose Fusion', RUN_PLAIN, 2),
    ...cellObjects(2, 0, '9', RUN_BOLD),
    ...cellObjects(2, 1, 'Truck receiving', RUN_PLAIN),
    { classId: 1179725, objectId: '97eb75ae-8f48-4b46-a3fb-ad6a2d6eee7c|70', properties: [268442635, '18'] },
    { classId: 1179725, objectId: '97eb75ae-8f48-4b46-a3fb-ad6a2d6eee7c|72', properties: [268442635, '18'] },
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const objectsOf = (body: Record<string, unknown>): Obj[] => {
  const request = (body.srs as [number, Record<string, unknown>][])[0]?.[1] as Record<string, unknown>;
  const revisions = request.Revisions as Array<Record<string, unknown>>;
  expect(revisions).toHaveLength(1);
  return (revisions[0]?.ObjectGroups as Array<{ Objects: Obj[] }>)[0]?.Objects ?? [];
};
const props = (o: Obj | undefined): Map<number, string> => {
  const map = new Map<number, string>();
  for (let i = 0; o && i + 1 < o.Properties.length; i += 2) {
    map.set(Number(o.Properties[i]), String(o.Properties[i + 1]));
  }
  return map;
};
const build = (after = 'Staff lose Fusion', cells: string[] = []) =>
  objectsOf(
    buildAddTableRowBody(
      resolveAddTableRowContext(model(), after),
      cells,
      GUID,
      HEAD,
      IDENTITY,
      DESCRIPTOR,
      CREATED,
      OWNERS,
    ),
  );

describe('resolveAddTableRowContext', () => {
  test('walks from a cell’s text to its row and table, with every column’s formatting', () => {
    const ctx = resolveAddTableRowContext(model(), 'Staff lose Fusion');
    expect(ctx.table.objectId).toBe(TABLE);
    expect(ctx.sourceRowRef).toBe(ROW_1);
    expect(ctx.rowRefs).toEqual([ROW_1, ROW_2]);
    expect(ctx.sourceCells.map(c => c.paragraph.endMarkRef)).toEqual([RUN_BOLD, RUN_PLAIN]);
  });

  test('refuses text that is not in a table', () => {
    const outside = model();
    outside.objects.push(
      { classId: 1074135132, objectId: 'aa|1', properties: [603986976, '{bb}{1}'] },
      { classId: 393229, objectId: 'bb|1', properties: [603986975, '{dd}{1}'] },
      { classId: 393230, objectId: 'dd|1', properties: [469769250, 'Title', 603987475, RUN_PLAIN] },
    );
    expect(() => resolveAddTableRowContext(outside, 'Title')).toThrow(/not inside a table cell/);
  });
});

describe('buildAddTableRowBody', () => {
  test('inserts the new row directly below the source row and raises the row count', () => {
    const table = build().find(o => o.ClassId === 393250);
    expect(props(table).get(603986976)).toBe(`${ROW_1},{${GUID}}{3},${ROW_2}`);
    expect(props(table).get(335551831)).toBe('3');
    expect(props(table).get(469780712)).toBe(COLUMNS.join(','));
  });

  test('the new row copies the source row with fresh identities and one cell per column', () => {
    const row = build().find(o => o.ClassId === 393251);
    expect(row?.ObjectId).toBe(`${GUID}|3`);
    expect(props(row).get(469780485)).toBe(IDENTITY.rowId);
    expect(props(row).get(469780523)).toBe(IDENTITY.rowUniqueId);
    expect(props(row).get(335562771)).toBe('1');
    expect(props(row).get(603986976)).toBe(`{${GUID}}{10},{${GUID}}{15}`);
  });

  test('each cell copies its column’s cell and holds a new block carrying the row and column ids', () => {
    const objects = build();
    const cells = objects.filter(o => o.ClassId === 393252);
    expect(cells.map(c => c.ObjectId)).toEqual([`${GUID}|10`, `${GUID}|15`]);
    expect(props(cells[1]).get(469780485)).toBe(IDENTITY.rowId);
    expect(props(cells[1]).get(469780486)).toBe(COLUMNS[1]);
    expect(props(cells[1]).get(469769234)).toBe('0.5,0,0.75,0.75');
    expect(props(cells[1]).get(603986976)).toBe(`{${GUID}}{16}`);

    const body = objects.find(o => o.ObjectId === `${GUID}|16`);
    expect(body?.ClassId).toBe(393229);
    expect(props(body).get(469780485)).toBe(IDENTITY.rowId);
    expect(props(body).get(469780486)).toBe(COLUMNS[1]);
    expect(props(body).get(469780482)).toBe(OWNERS[1]);
    expect(props(body).get(603986975)).toBe(`{${GUID}}{17}`);
  });

  test('new cells are empty by default, formatted like the cell above with a single-run layout', () => {
    const paragraph = build().find(o => o.ObjectId === `${GUID}|17`);
    const p = props(paragraph);
    expect(p.get(469769250)).toBe('');
    expect(p.get(603987475)).toBe(RUN_PLAIN);
    expect(p.has(469769746)).toBe(false);
    expect(p.get(469769819)).toBe('1');
    expect(p.get(469780485)).toBe(IDENTITY.rowId);
  });

  test('fills cells left to right from `cells`', () => {
    const objects = build('Staff lose Fusion', ['10', 'Inventory adjustments']);
    expect(props(objects.find(o => o.ObjectId === `${GUID}|12`)).get(469769250)).toBe('10');
    expect(props(objects.find(o => o.ObjectId === `${GUID}|17`)).get(469769250)).toBe('Inventory adjustments');
  });

  test('names the action InsertRowBelow', () => {
    expect(props(build().find(o => o.ClassId === 131140)).get(469780989)).toBe('InsertRowBelow');
  });
});

describe('seeded identities', () => {
  test('row ids use the editor’s 8-hex-digit form and differ from each other', () => {
    const identity = rowIdentityFromSeed('0123abcd-4567-89ef-0123-456789abcdef');
    expect(identity.rowId).toBe('0123abcd-0000-0000-0000-000000000000');
    expect(identity.rowUniqueId).toBe('456789ef-0000-0000-0000-000000000000');
  });

  test('block owners are distinct per column and stable for one seed', () => {
    const seed = '0123abcd-4567-89ef-0123-456789abcdef';
    expect(blockOwnerFromSeed(seed, 0)).not.toBe(blockOwnerFromSeed(seed, 1));
    expect(blockOwnerFromSeed(seed, 1)).toBe(blockOwnerFromSeed(seed, 1));
    expect(blockOwnerFromSeed(seed, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('addTableRowAction', () => {
  test('parseArgs requires the anchor text and accepts optional string cells', () => {
    expect(() => addTableRowAction.parseArgs({})).toThrow(FrameBridgeValidationError);
    expect(() => addTableRowAction.parseArgs({ after: 'x', cells: [1] })).toThrow(/list of strings/);
    expect(() => addTableRowAction.parseArgs({ after: 'x', cells: ['a\nb'] })).toThrow(/line breaks/);
    expect(addTableRowAction.parseArgs({ after: 'x' })).toEqual({ after: 'x', cells: [] });
  });

  test('resolve refuses more cell texts than the table has columns', () => {
    expect(() => addTableRowAction.resolve(model(), { after: '9', cells: ['a', 'b', 'c'] })).toThrow(/2 columns/);
  });

  test('confirms only a new row directly below the source whose cells carry the texts', () => {
    const args = { after: 'Staff lose Fusion', cells: ['10'] };
    const first = resolveAddTableRowContext(model(), args.after);
    expect(addTableRowAction.isApplied(model(), first, args)).toBe(false);

    const after = model();
    const table = after.objects.find(o => o.objectId === TABLE);
    if (table) table.properties = [603986976, `${ROW_1},{ee}{1},${ROW_2}`];
    after.objects.push(
      { classId: 393251, objectId: 'ee|1', properties: [603986976, '{c30}{1},{c31}{1}'] },
      ...cellObjects(3, 0, '10', RUN_BOLD),
      ...cellObjects(3, 1, '', RUN_PLAIN),
    );
    expect(addTableRowAction.isApplied(after, first, args)).toBe(true);
    expect(addTableRowAction.isApplied(after, first, { ...args, cells: ['11'] })).toBe(false);
  });

  test('is not idempotent — a repeat would insert a second row', () => {
    expect(addTableRowAction.idempotent).toBe(false);
  });
});

describe('delete_table_row', () => {
  test('finds the listed row when a deleted row left a cell with the same text behind', () => {
    const withGhost = model();
    // A deleted row's cells stay in the model; the table simply stops listing the row.
    withGhost.objects.unshift(
      { classId: 393251, objectId: 'fade|1', properties: [603986976, '{c90}{1}'] },
      ...cellObjects(9, 0, 'Truck receiving', RUN_PLAIN),
    );
    expect(locateTableRow(withGhost, 'Truck receiving').rowRef).toBe(ROW_2);
  });

  test('resubmits only the table, without the row and with the row count lowered', () => {
    const objects = objectsOf(
      buildDeleteTableRowBody(locateTableRow(model(), 'Truck receiving'), GUID, HEAD, DESCRIPTOR, CREATED),
    );
    expect(objects).toHaveLength(2);
    expect(props(objects[0]).get(469780989)).toBe('DeleteRow');
    expect(objects[1]?.ObjectId).toBe(TABLE);
    expect(props(objects[1]).get(603986976)).toBe(ROW_1);
    expect(props(objects[1]).get(335551831)).toBe('1');
    expect(props(objects[1]).get(335551866)).toBe(CREATED);
    expect(props(objects[1]).get(469780712)).toBe(COLUMNS.join(','));
  });

  test('refuses to remove a table’s only row', () => {
    const single = model();
    const table = single.objects.find(o => o.objectId === TABLE);
    if (table) table.properties = [603986976, ROW_1];
    expect(() => deleteTableRowAction.resolve(single, { row: '8' })).toThrow(/only row/);
  });

  test('confirms only once the table stops listing the row', () => {
    const first = locateTableRow(model(), 'Truck receiving');
    expect(deleteTableRowAction.isApplied(model(), first, { row: 'Truck receiving' })).toBe(false);
    const after = model();
    const table = after.objects.find(o => o.objectId === TABLE);
    if (table) table.properties = [603986976, ROW_1];
    expect(deleteTableRowAction.isApplied(after, first, { row: 'Truck receiving' })).toBe(true);
  });
});
