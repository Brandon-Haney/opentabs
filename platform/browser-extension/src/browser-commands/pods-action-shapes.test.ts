import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const {
  buildDuplicateShapeBody,
  buildMoveShapeBody,
  buildResizeShapeBody,
  buildSetShapeFillBody,
  buildSetTableHeightBody,
  duplicateShapeAction,
  locateShape,
  moveShapeAction,
  readSlideLayout,
  resizeShapeAction,
  resolveDuplicateShapeContext,
  resolveTableHeightContext,
  setShapeFillAction,
} = await import('./pods-action-shapes.js');
const { resolveRunFormatTarget } = await import('./pods-action-run-format.js');

import type { PodsMint } from './pods-actions.js';
import type { PodsModel, PodsObject } from './pods-model.js';

const MINT: PodsMint = {
  guidToken: '__OTB_PODS_GUID__',
  headToken: '__OTB_PODS_HEAD__',
  seed: '0123abcd-4567-89ef-0123-456789abcdef',
  actionTime: '1789657036957',
};
const G = MINT.guidToken;

/** Slide identity: slide 1 is the original, slide 2 a copy carrying the same text. */
const SLIDE_1 = [335562805, '2147482944', 335562806, '2294394031'];
const SLIDE_2 = [335562805, '2147483524', 335562806, '546048923'];

/** One slide with a table frame, its table and two rows, and two status dots. */
const slideObjects = (prefix: string, identity: (string | number)[], text: string): PodsObject[] => [
  {
    classId: 393227,
    objectId: `${prefix}0|1`,
    properties: [...identity, 603986976, `{${prefix}1}{1},{${prefix}2}{1},{${prefix}3}{1}`],
  },
  // The table frame: it lists an empty text body of its own, and its table records the frame's origin.
  {
    classId: 1074135132,
    objectId: `${prefix}1|1`,
    properties: [
      ...identity,
      335551508,
      '1.5',
      335551509,
      '3',
      335551515,
      '22.6',
      335551516,
      '11.4',
      469780826,
      'Content Placeholder 4',
      603986976,
      `{${prefix}4}{1}`,
    ],
  },
  { classId: 393229, objectId: `${prefix}4|1`, properties: [...identity, 603986975, `{${prefix}5}{1}`] },
  { classId: 393230, objectId: `${prefix}5|1`, properties: [...identity, 469769250, ''] },
  {
    classId: 393250,
    objectId: `${prefix}6|1`,
    properties: [...identity, 469780522, '1.5,3', 603986976, `{${prefix}7}{1},{${prefix}7}{2}`],
  },
  {
    classId: 393251,
    objectId: `${prefix}7|1`,
    properties: [...identity, 335562771, '0.68', 603986976, `{${prefix}8}{1}`],
  },
  {
    classId: 393251,
    objectId: `${prefix}7|2`,
    properties: [...identity, 335562771, '1.2', 603986976, `{${prefix}8}{2}`],
  },
  { classId: 393252, objectId: `${prefix}8|1`, properties: [...identity, 603986976, `{${prefix}9}{1}`] },
  { classId: 393252, objectId: `${prefix}8|2`, properties: [...identity, 603986976, `{${prefix}9}{2}`] },
  { classId: 393229, objectId: `${prefix}9|1`, properties: [...identity, 603986975, `{${prefix}a}{1}`] },
  { classId: 393229, objectId: `${prefix}9|2`, properties: [...identity, 603986975, `{${prefix}a}{2}`] },
  { classId: 393230, objectId: `${prefix}a|1`, properties: [...identity, 469769250, 'Area', 603987475, '{c1}{1}'] },
  { classId: 393230, objectId: `${prefix}a|2`, properties: [...identity, 469769250, text, 603987475, '{c1}{1}'] },
  // A status dot with a text body, a paragraph and one paragraph-level style.
  {
    classId: 1074135132,
    objectId: `${prefix}2|1`,
    properties: [
      ...identity,
      335551508,
      '7.838',
      335551509,
      '12.83',
      335551515,
      '0.548',
      335551516,
      '0.572',
      335563037,
      '12.83',
      335563038,
      '7.838',
      469780706,
      '{"userNameField":"someone"}',
      469780718,
      '{"solidFillField":{"srgbClrField":{"valField":[0,176,80]}}}',
      469780826,
      'Status 6',
      469780944,
      '{8A5D2E55-D7A6-01BA-3D18-88EFE8C90F2C}',
      603986976,
      `{${prefix}b}{1}`,
      603995142,
      `{${prefix}d}{1}`,
    ],
  },
  {
    classId: 393229,
    objectId: `${prefix}b|1`,
    properties: [...identity, 469780482, 'owner', 603986975, `{${prefix}c}{1}`],
  },
  { classId: 393230, objectId: `${prefix}c|1`, properties: [...identity, 469769250, '', 469780482, 'owner'] },
  { classId: 131073, objectId: `${prefix}d|1`, properties: [268442635, '36', 335559685, '0'] },
  {
    classId: 1074135132,
    objectId: `${prefix}3|1`,
    properties: [...identity, 335551508, '7.838', 335551509, '5', 469780826, 'Status 6', 603986976, `{${prefix}e}{1}`],
  },
  { classId: 393229, objectId: `${prefix}e|1`, properties: [...identity, 603986975, `{${prefix}f}{1}`] },
  { classId: 393230, objectId: `${prefix}f|1`, properties: [...identity, 469769250, ''] },
];

const model = (): PodsModel => ({
  totalObjects: 0,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{a0}{1},{b0}{1}'],
    },
    ...slideObjects('a', SLIDE_1, 'Receiving and scanning'),
    ...slideObjects('b', SLIDE_2, 'Receiving and scanning'),
    { classId: 1179725, objectId: 'c1|1', properties: [268442635, '28'] },
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const objectsOf = (body: Record<string, unknown>): Obj[] => {
  const request = (body.srs as [number, Record<string, unknown>][])[0]?.[1] as Record<string, unknown>;
  return (
    ((request.Revisions as Array<Record<string, unknown>>)[0]?.ObjectGroups as Array<{ Objects: Obj[] }>)[0]?.Objects ??
    []
  );
};
const props = (o: Obj | undefined): Map<number, string> => {
  const map = new Map<number, string>();
  for (let i = 0; o && i + 1 < o.Properties.length; i += 2) {
    map.set(Number(o.Properties[i]), String(o.Properties[i + 1]));
  }
  return map;
};

describe('read_slide_layout', () => {
  test('reports positions in inches and recognises the table frame by its recorded origin', () => {
    const layout = readSlideLayout(model(), 2) as { shapes: Array<Record<string, unknown>> };
    const frame = layout.shapes[0] as Record<string, unknown>;
    expect(frame).toMatchObject({ name: 'Content Placeholder 4', kind: 'table', left: 0.75, top: 1.5, width: 11.3 });
    expect(frame.rows).toEqual([
      { height: 0.34, firstCell: 'Area' },
      { height: 0.6, firstCell: 'Receiving and scanning' },
    ]);
  });

  test('a shape without the table’s origin is a shape, and duplicate names get occurrences', () => {
    const layout = readSlideLayout(model(), 2) as { shapes: Array<Record<string, unknown>> };
    expect(layout.shapes[1]).toMatchObject({
      name: 'Status 6',
      occurrence: 1,
      kind: 'shape',
      fillHex: '00B050',
      top: 6.415,
    });
    expect(layout.shapes[2]).toMatchObject({ name: 'Status 6', occurrence: 2, kind: 'shape' });
  });
});

describe('locateShape', () => {
  test('finds the named shape on the requested slide, not its twin on the other', () => {
    expect(locateShape(model(), 2, 'Status 6').shape.objectId).toBe('b2|1');
    expect(locateShape(model(), 1, 'Status 6').shape.objectId).toBe('a2|1');
  });

  test('names the slide’s shapes on a miss, and rejects an occurrence past the count', () => {
    expect(() => locateShape(model(), 2, 'Status 9')).toThrow(/Its shapes: "Content Placeholder 4", "Status 6"/);
    expect(() => locateShape(model(), 2, 'Status 6', 3)).toThrow(/2 shape\(s\) named "Status 6"/);
  });
});

describe('move_shape', () => {
  test('writes the new left and top, in half-inches, to both position pairs', () => {
    const ctx = locateShape(model(), 2, 'Status 6');
    const [descriptor, shape] = objectsOf(
      buildMoveShapeBody(ctx, { slideIndex: 2, shape: 'Status 6', occurrence: 1, top: 5.962 }, MINT),
    );
    expect(props(descriptor).get(469780989)).toBe('MoveShapes');
    expect(props(shape).get(335551509)).toBe('11.924');
    expect(props(shape).get(335563037)).toBe('11.924');
    expect(props(shape).get(335551508)).toBe('7.838');
  });

  test('confirms on the geometry read back, within rounding', () => {
    const first = locateShape(model(), 2, 'Status 6');
    const after = model();
    const dot = after.objects.find(o => o.objectId === 'b2|1') as PodsObject;
    dot.properties = dot.properties.map((v, i, all) => (all[i - 1] === 335551509 ? '11.93' : v));
    const args = { slideIndex: 2, shape: 'Status 6', occurrence: 1, top: 5.962 };
    expect(moveShapeAction.isApplied(after, first, args)).toBe(true);
    expect(moveShapeAction.isApplied(model(), first, args)).toBe(false);
  });

  test('requires a position', () => {
    expect(() => moveShapeAction.parseArgs({ slideIndex: 2, shape: 'Status 6' })).toThrow(/left` and\/or `top/);
  });
});

describe('resize_shape', () => {
  test('sends an edge delta in 90-dpi pixels and leaves the size properties alone', () => {
    const ctx = locateShape(model(), 2, 'Status 6');
    const shape = objectsOf(
      buildResizeShapeBody(ctx, { slideIndex: 2, shape: 'Status 6', occurrence: 1, width: 0.5 }, MINT),
    )[1];
    const delta = JSON.parse(props(shape).get(469780600) as string);
    expect(delta.EastDelta).toBeCloseTo((0.5 - 0.274) * 90, 6);
    expect(delta).toMatchObject({ NorthDelta: 0, SouthDelta: 0, WestDelta: 0 });
    expect(props(shape).get(335551515)).toBe('0.548');
  });

  test('refuses a table frame, pointing at set_table_height', () => {
    expect(() =>
      resizeShapeAction.resolve(model(), { slideIndex: 2, shape: 'Content Placeholder 4', occurrence: 1, height: 5 }),
    ).toThrow(/set_table_height/);
  });
});

describe('duplicate_shape', () => {
  const build = () => {
    const args = { slideIndex: 2, shape: 'Status 6', occurrence: 1, left: 3.919, top: 5.962 };
    return objectsOf(buildDuplicateShapeBody(resolveDuplicateShapeContext(model(), args), args, MINT));
  };

  test('appends the copy to the slide’s shape list', () => {
    const slide = build().find(o => o.ClassId === 393227);
    expect(props(slide).get(603986976)).toBe(`{b1}{1},{b2}{1},{b3}{1},{${G}}{1}`);
  });

  test('writes the copy at the requested position with a fresh identity and back-references', () => {
    const copy = build().find(o => o.ObjectId === `${G}|1`);
    const p = props(copy);
    expect(p.get(335551508)).toBe('7.838');
    expect(p.get(335551509)).toBe('11.924');
    expect(p.get(335562753)).toBe('0');
    expect(p.get(469780944)).toMatch(/^\{[0-9A-F-]{36}\}$/);
    expect(p.get(469780944)).not.toBe('{8A5D2E55-D7A6-01BA-3D18-88EFE8C90F2C}');
    expect(p.get(536889494)).toBe('{b0}{1}');
    expect(p.get(536889495)).toBe('{b2}{1}');
    expect(p.has(469780706)).toBe(false);
    expect(p.get(469780718)).toContain('[0,176,80]');
  });

  test('copies the text body, paragraphs and paragraph-level styles under the write guid', () => {
    const objects = build();
    const copy = props(objects.find(o => o.ObjectId === `${G}|1`));
    expect(copy.get(603986976)).toBe(`{${G}}{10}`);
    expect(copy.get(603995142)).toBe(`{${G}}{60}`);
    const body = props(objects.find(o => o.ObjectId === `${G}|10`));
    expect(body.get(603986975)).toBe(`{${G}}{20}`);
    expect(body.get(536889495)).toBe(`{${G}}{1}`);
    expect(objects.find(o => o.ObjectId === `${G}|20`)?.ClassId).toBe(393230);
    expect(objects.find(o => o.ObjectId === `${G}|60`)?.ClassId).toBe(131073);
  });

  test('confirms on a new shape with the source’s name at the position, and is never re-issued', () => {
    const args = { slideIndex: 2, shape: 'Status 6', occurrence: 1, top: 5.962 };
    const first = resolveDuplicateShapeContext(model(), args);
    const after = model();
    const slide = after.objects.find(o => o.objectId === 'b0|1') as PodsObject;
    slide.properties = [...SLIDE_2, 603986976, '{b1}{1},{b2}{1},{b3}{1},{ee}{1}'];
    after.objects.push({
      classId: 1074135132,
      objectId: 'ee|1',
      properties: [335551509, '11.924', 469780826, 'Status 6'],
    });
    expect(duplicateShapeAction.isApplied(after, first, args)).toBe(true);
    expect(duplicateShapeAction.isApplied(model(), first, args)).toBe(false);
    expect(duplicateShapeAction.idempotent).toBe(false);
  });
});

describe('set_table_height', () => {
  test('scales every row of the table on the named slide, not the copy’s', () => {
    const ctx = resolveTableHeightContext(model(), 2, 'Receiving and scanning');
    expect(ctx.table.objectId).toBe('b6|1');
    const rows = objectsOf(
      buildSetTableHeightBody(ctx, { slideIndex: 2, table: 'Receiving and scanning', height: 1.88 }, MINT),
    ).filter(o => o.ClassId === 393251);
    expect(rows.map(r => r.ObjectId)).toEqual(['b7|1', 'b7|2']);
    // 1.88" is 3.76 half-inches: twice the current 0.68 + 1.2, so each row doubles.
    expect(Number(props(rows[0]).get(335562771))).toBeCloseTo(1.36, 6);
    expect(Number(props(rows[1]).get(335562771))).toBeCloseTo(2.4, 6);
  });
});

describe('text lookups scoped to a slide', () => {
  test('run formatting resolves the paragraph on the named slide', () => {
    expect(resolveRunFormatTarget(model(), 'Receiving and scanning', { slideIndex: 2 }).paragraphId).toBe('ba|2');
    expect(resolveRunFormatTarget(model(), 'Receiving and scanning', { slideIndex: 1 }).paragraphId).toBe('aa|2');
  });
});

describe('set_shape_fill', () => {
  const args = { slideIndex: 2, shape: 'Status 6', occurrence: 1, colorHex: 'FFC72C' };
  const revisionsOf = (body: Record<string, unknown>) =>
    ((body.srs as [number, Record<string, unknown>][])[0]?.[1] as Record<string, unknown>).Revisions as Array<
      Record<string, unknown>
    >;

  test('sends two chained revisions, the second carrying the picker record and the action label', () => {
    const revisions = revisionsOf(buildSetShapeFillBody(locateShape(model(), 2, 'Status 6'), args, MINT));
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.BaseId).toBe(revisions[0]?.Id);
    const [first, second] = revisions.map(r => (r.ObjectGroups as Array<{ Objects: Obj[] }>)[0]?.Objects ?? []);
    expect(props(first?.[0]).get(469780989)).toBe('');
    expect(props(second?.[0]).get(469780989)).toBe('ApplyShapeFillColor');
    for (const shape of [first?.[1], second?.[1]]) {
      expect(JSON.parse(props(shape).get(469780718) as string)).toEqual({
        solidFillField: { srgbClrField: { valField: [255, 199, 44] } },
      });
      expect(props(shape).get(469780771)).toBe('');
    }
    expect(props(first?.[1]).has(469780594)).toBe(false);
    expect(JSON.parse(props(second?.[1]).get(469780594) as string)).toMatchObject({
      RGBColor: 'FFC72C',
      ThemeColor: -1,
    });
  });

  test('confirms when the shape reads back with the colour', () => {
    const first = locateShape(model(), 2, 'Status 6');
    expect(setShapeFillAction.isApplied(model(), first, args)).toBe(false);
    expect(setShapeFillAction.isApplied(model(), first, { ...args, colorHex: '00B050' })).toBe(true);
  });

  test('accepts a leading # and rejects anything but six hex digits', () => {
    expect(setShapeFillAction.parseArgs({ slideIndex: 2, shape: 'Status 6', colorHex: '#ffc72c' }).colorHex).toBe(
      'FFC72C',
    );
    expect(() => setShapeFillAction.parseArgs({ slideIndex: 2, shape: 'Status 6', colorHex: 'yellow' })).toThrow(
      /RRGGBB/,
    );
  });
});
