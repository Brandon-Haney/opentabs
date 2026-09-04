import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { addParagraphAction, buildAddParagraphBody, resolveAddParagraphContext } = await import(
  './pods-action-add-paragraph.js'
);
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { AddParagraphContext } from './pods-action-add-paragraph.js';
import type { PodsModel, PodsObject } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const OWNER = '85b1274a-b449-4c31-9f71-5d0660470f84';
const ACTION_JSON = '{"ActionId":"1","ActionName":"Enter","ActionTime":"1788439883559"}';
const CREATED = '1788439883560';

/** Object ids and values taken from the captured NewLine so the fixture matches the wire. */
const SHAPE_ID = '9d6d4a29-58d3-4c6f-bdb7-70296063d69b|87';
const TEXT_BODY_ID = '9d6d4a29-58d3-4c6f-bdb7-70296063d69b|88';
const PARAGRAPH_ID = '9d6d4a29-58d3-4c6f-bdb7-70296063d69b|89';
const RUN_ID = '4efeeb47-de77-4081-a870-b0e9ad47aabf|58';
const RUN_REF = '{4efeeb47-de77-4081-a870-b0e9ad47aabf}{58}';
const TITLE = ' Fusion Pilot Timeline: Key Milestones';

const sourceParagraphProperties = (): (string | number)[] => [
  335559683,
  '0',
  335562753,
  '58',
  335562805,
  '2147483523',
  335562806,
  '857146763',
  469769250,
  TITLE,
  469780482,
  'b3cb2d09-cf2b-4699-8281-27dd37ad07c0',
  469780757,
  '{"Lines":[39]}',
  469780968,
  'Slide',
  603987475,
  RUN_REF,
];

const runObject = (withText: boolean): PodsObject => ({
  classId: 1179725,
  objectId: RUN_ID,
  properties: withText ? [268442635, '4400', 469769250, TITLE] : [268442635, '4400'],
});

const model = (withRunText = false): PodsModel => ({
  totalObjects: 5,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{x}{1}'],
    },
    {
      classId: 1074135132,
      objectId: SHAPE_ID,
      properties: [469780826, 'Title 1', 603986976, `{9d6d4a29-58d3-4c6f-bdb7-70296063d69b}{88}`],
    },
    {
      classId: 393229,
      objectId: TEXT_BODY_ID,
      properties: [603986975, `{9d6d4a29-58d3-4c6f-bdb7-70296063d69b}{89}`],
    },
    {
      classId: 393230,
      objectId: PARAGRAPH_ID,
      properties: sourceParagraphProperties(),
      cellId: '23069e19-9218-5ae4-9815-d8ceaade97df|3',
    },
    runObject(withRunText),
  ],
});

const ctx = (withRunText = false): AddParagraphContext => resolveAddParagraphContext(model(withRunText), TITLE);

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const revisionsOf = (body: Record<string, unknown>) => {
  const srs = body.srs as [number, Record<string, unknown>][];
  const request = srs[0]?.[1] as Record<string, unknown>;
  return request.Revisions as Array<Record<string, unknown>>;
};
const objectsOf = (revision: Record<string, unknown>): Obj[] =>
  (revision.ObjectGroups as Array<{ Objects: Obj[] }>)[0]?.Objects ?? [];
const propsOf = (o: Obj): Map<number, string> => {
  const map = new Map<number, string>();
  for (let i = 0; i + 1 < o.Properties.length; i += 2) map.set(o.Properties[i] as number, String(o.Properties[i + 1]));
  return map;
};
const build = (withRunText = false, text = 'Next milestone') =>
  buildAddParagraphBody(ctx(withRunText), text, GUID, HEAD, OWNER, ACTION_JSON, CREATED);

describe('resolveAddParagraphContext', () => {
  test('walks paragraph to text body to shape, and finds the run', () => {
    const resolved = ctx();
    expect(resolved.sourceParagraphId).toBe(PARAGRAPH_ID);
    expect(resolved.shapeObjectId).toBe(SHAPE_ID);
    expect(resolved.shapeName).toBe('Title 1');
    expect(resolved.sourceRun.objectId).toBe(RUN_ID);
    expect(resolved.sourceRunRef).toBe(RUN_REF);
    expect(resolved.contentRefTokens).toEqual(['{9d6d4a29-58d3-4c6f-bdb7-70296063d69b}{88}']);
  });

  test("uses the paragraph's own storage cell, not the root-derived one", () => {
    expect(ctx().cellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
  });

  test('names nearby text when nothing matches', () => {
    expect(() => resolveAddParagraphContext(model(), 'Fusion Pilot Timeline')).toThrow(FrameBridgeValidationError);
    expect(() => resolveAddParagraphContext(model(), 'Fusion Pilot Timeline')).toThrow(/Nearby text/);
  });

  test('fails when no text body claims the paragraph', () => {
    const orphaned = model();
    orphaned.objects = orphaned.objects.filter(o => o.classId !== 393229);
    expect(() => resolveAddParagraphContext(orphaned, TITLE)).toThrow(/no text body/);
  });

  test('fails when no shape claims the text body', () => {
    const orphaned = model();
    orphaned.objects = orphaned.objects.filter(o => o.classId !== 1074135132);
    expect(() => resolveAddParagraphContext(orphaned, TITLE)).toThrow(/No shape/);
  });

  test('fails when the paragraph references no run', () => {
    const runless = model();
    runless.objects = runless.objects.filter(o => o.classId !== 1179725);
    expect(() => resolveAddParagraphContext(runless, TITLE)).toThrow(/references no formatting run/);
  });
});

describe('buildAddParagraphBody', () => {
  test('sends three revisions chained base-to-id in one request', () => {
    const revisions = revisionsOf(build());
    expect(revisions).toHaveLength(3);
    expect(revisions[0]?.BaseId).toBe(HEAD);
    expect(revisions[1]?.BaseId).toBe(revisions[0]?.Id);
    expect(revisions[2]?.BaseId).toBe(revisions[1]?.Id);
    expect(new Set(revisions.map(r => r.Id)).size).toBe(3);
  });

  test('every revision names the target paragraph’s own cell', () => {
    for (const revision of revisionsOf(build())) {
      expect(revision.CellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    }
  });

  test('appends one block to the shape and changes nothing else about it', () => {
    const shape = objectsOf(revisionsOf(build())[0] as Record<string, unknown>).find(o => o.ClassId === 1074135132);
    expect(shape?.ObjectId).toBe(SHAPE_ID);
    const props = propsOf(shape as Obj);
    expect(props.get(603986976)).toBe(`{9d6d4a29-58d3-4c6f-bdb7-70296063d69b}{88},{${GUID}}{6}`);
    expect(props.get(469780826)).toBe('Title 1');
    expect(props.size).toBe(2);
  });

  test('resubmits the source paragraph unchanged', () => {
    const objects = objectsOf(revisionsOf(build())[0] as Record<string, unknown>);
    const source = objects.find(o => o.ObjectId === PARAGRAPH_ID);
    expect(propsOf(source as Obj).get(469769250)).toBe(TITLE);
    expect(propsOf(source as Obj).get(469780757)).toBe('{"Lines":[39]}');
  });

  test('creates a text body that owns the new paragraph and inherits the slide identity', () => {
    const body = objectsOf(revisionsOf(build())[0] as Record<string, unknown>).find(o => o.ClassId === 393229);
    expect(body?.ObjectId).toBe(`${GUID}|6`);
    const props = propsOf(body as Obj);
    expect(props.get(603986975)).toBe(`{${GUID}}{1}`);
    expect(props.get(469780482)).toBe(OWNER);
    expect(props.get(201333763)).toBe('1');
    expect(props.get(335551753)).toBe(CREATED);
    expect(props.get(335551866)).toBe(CREATED);
    // Inherited from the paragraph already in the shape.
    expect(props.get(335562753)).toBe('58');
    expect(props.get(335562805)).toBe('2147483523');
    expect(props.get(335562806)).toBe('857146763');
    expect(props.get(469780968)).toBe('Slide');
    expect(props.get(335559683)).toBe('0');
  });

  test("inherits the source's own end-mark when it has one, over its run reference", () => {
    const withEndMark = model();
    const paragraph = withEndMark.objects.find(o => o.objectId === PARAGRAPH_ID);
    if (paragraph) paragraph.properties = [...sourceParagraphProperties(), 536886591, '{4efeeb47}{60}'];
    const resolved = resolveAddParagraphContext(withEndMark, TITLE);
    expect(resolved.sourceEndMarkRef).toBe('{4efeeb47}{60}');
    const created = objectsOf(
      revisionsOf(buildAddParagraphBody(resolved, 'x', GUID, HEAD, OWNER, ACTION_JSON, CREATED))[0] as Record<
        string,
        unknown
      >,
    ).find(o => o.ObjectId === `${GUID}|1`);
    expect(propsOf(created as Obj).get(536886591)).toBe('{4efeeb47}{60}');
    // The body-text run is still the source's, which the capture shows directly.
    expect(propsOf(created as Obj).get(603987475)).toBe(RUN_REF);
  });

  test("falls back to the source's run when it carries no end-mark, as the capture did", () => {
    expect(ctx().sourceEndMarkRef).toBe(RUN_REF);
  });

  test('creates an empty paragraph owned by the new block, inheriting the source run', () => {
    const objects = objectsOf(revisionsOf(build())[0] as Record<string, unknown>);
    const created = objects.find(o => o.ObjectId === `${GUID}|1`);
    const props = propsOf(created as Obj);
    expect(created?.ClassId).toBe(393230);
    expect(props.get(469769250)).toBe('');
    expect(props.get(469780482)).toBe(OWNER);
    expect(props.get(603987475)).toBe(RUN_REF);
    // endOfParagraphFormatting — the caret at the end inherits the source run.
    expect(props.get(536886591)).toBe(RUN_REF);
    expect(props.get(335559732)).toBe('0');
  });

  test('second revision corrects the inherited line lengths to a single empty line', () => {
    const objects = objectsOf(revisionsOf(build())[1] as Record<string, unknown>);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.ObjectId).toBe(`${GUID}|1`);
    expect(propsOf(objects[0] as Obj).get(469780757)).toBe('{"Lines":[1]}');
  });

  test('third revision types the text into the created paragraph', () => {
    const objects = objectsOf(revisionsOf(build()).at(-1) as Record<string, unknown>);
    expect(objects).toHaveLength(1);
    const props = propsOf(objects[0] as Obj);
    expect(props.get(469769250)).toBe('Next milestone');
    // The shared run carries no text of its own, so it stays shared.
    expect(props.get(603987475)).toBe(RUN_REF);
  });

  test('mints a replacement run when the shared run carries its own text', () => {
    const objects = objectsOf(revisionsOf(build(true)).at(-1) as Record<string, unknown>);
    expect(objects).toHaveLength(2);
    const paragraph = objects.find(o => o.ClassId === 393230);
    const run = objects.find(o => o.ClassId === 1179725);
    expect(run?.ObjectId).toBe(`${GUID}|9`);
    expect(propsOf(run as Obj).get(469769250)).toBe('Next milestone');
    expect(propsOf(run as Obj).get(268442635)).toBe('4400');
    // The paragraph points at the replacement, so its text and its run's cannot diverge.
    expect(propsOf(paragraph as Obj).get(603987475)).toBe(`{${GUID}}{9}`);
  });

  test('names the action NewLine, and only on the first revision', () => {
    const revisions = revisionsOf(build());
    const descriptor = objectsOf(revisions[0] as Record<string, unknown>).find(o => o.ClassId === 131140);
    expect(propsOf(descriptor as Obj).get(469780989)).toBe('NewLine');
    for (const revision of revisions.slice(1)) {
      expect(objectsOf(revision).some(o => o.ClassId === 131140)).toBe(false);
    }
  });

  test('sorts every property list ascending by id, as the wire carries them', () => {
    for (const revision of revisionsOf(build(true))) {
      for (const object of objectsOf(revision)) {
        const ids = object.Properties.filter((_, i) => i % 2 === 0);
        expect(ids).toEqual([...ids].sort((a, b) => Number(a) - Number(b)));
      }
    }
  });
});

describe('addParagraphAction', () => {
  test('requires both the anchor text and the new text', () => {
    expect(() => addParagraphAction.parseArgs({ text: 'x' })).toThrow(/needs `after`/);
    expect(() => addParagraphAction.parseArgs({ after: 'x' })).toThrow(/needs `text`/);
    expect(() => addParagraphAction.parseArgs({ after: 'x', text: '' })).toThrow(/needs `text`/);
  });

  test('rejects line breaks rather than silently writing one paragraph', () => {
    expect(() => addParagraphAction.parseArgs({ after: 'x', text: 'a\nb' })).toThrow(/cannot carry line breaks/);
  });

  test('accepts a well-formed call', () => {
    expect(addParagraphAction.parseArgs({ after: 'x', text: 'y' })).toEqual({ after: 'x', text: 'y' });
  });

  test('is not idempotent — a repeat would append a second paragraph', () => {
    expect(addParagraphAction.idempotent).toBe(false);
  });

  /** The live model as it looks after a write: a new block whose paragraph carries `text`. */
  const applied = (text: string): PodsModel => {
    const after = model();
    const shape = after.objects.find(o => o.objectId === SHAPE_ID);
    if (shape) {
      shape.properties = [
        469780826,
        'Title 1',
        603986976,
        '{9d6d4a29-58d3-4c6f-bdb7-70296063d69b}{88},{aaaaaaaa-1111-2222-3333-444444444444}{1}',
      ];
    }
    after.objects.push(
      {
        classId: 393229,
        objectId: 'aaaaaaaa-1111-2222-3333-444444444444|1',
        properties: [603986975, '{aaaaaaaa-1111-2222-3333-444444444444}{2}'],
      },
      { classId: 393230, objectId: 'aaaaaaaa-1111-2222-3333-444444444444|2', properties: [469769250, text] },
    );
    return after;
  };

  test('confirms when the new block holds a paragraph carrying the text', () => {
    expect(addParagraphAction.isApplied(applied('Cutover'), ctx(), { after: TITLE, text: 'Cutover' })).toBe(true);
  });

  test('does not confirm on a new block whose paragraph is still empty', () => {
    // The chained revisions are accepted individually, so a dropped typing
    // revision leaves the block in place with nothing in it.
    expect(addParagraphAction.isApplied(applied(''), ctx(), { after: TITLE, text: 'Cutover' })).toBe(false);
  });

  test('does not confirm when no block was added', () => {
    expect(addParagraphAction.isApplied(model(), ctx(), { after: TITLE, text: 'Cutover' })).toBe(false);
  });

  test('does not confirm when the shape has gone', () => {
    const gone = model();
    gone.objects = gone.objects.filter(o => o.objectId !== SHAPE_ID);
    expect(addParagraphAction.isApplied(gone, ctx(), { after: TITLE, text: 'x' })).toBe(false);
  });
});
