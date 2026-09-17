import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildDeleteParagraphBody, deleteParagraphAction, resolveDeleteParagraphContext } = await import(
  './pods-action-delete-paragraph.js'
);

import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const SHAPE = 'eab8c6f5-7dd1-41ae-8919-8a456f50dc9b|202';
const BLOCKS = ['{a1}{1}', '{a2}{1}', '{a3}{1}'];

/** A bulleted placeholder holding three one-paragraph blocks, as the captured DeleteKey's shape did. */
const model = (secondBlockParagraphs = 1): PodsModel => ({
  totalObjects: 0,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{0}{1}'],
    },
    {
      classId: 1074135132,
      objectId: SHAPE,
      properties: [469780826, 'Content Placeholder 1', 603986976, BLOCKS.join(',')],
    },
    ...['First ask', 'Scratch ask', 'Last ask'].flatMap((text, i) => [
      {
        classId: 393229,
        objectId: `a${i + 1}|1`,
        properties: [
          603986975,
          i === 1 && secondBlockParagraphs > 1 ? `{a${i + 1}}{2},{a${i + 1}}{3}` : `{a${i + 1}}{2}`,
        ],
      },
      { classId: 393230, objectId: `a${i + 1}|2`, properties: [469769250, text, 603987475, '{c1}{1}'] },
    ]),
    { classId: 1179725, objectId: 'c1|1', properties: [268442635, '32'] },
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
const propOf = (o: Obj | undefined, id: number): string | undefined => {
  for (let i = 0; o && i + 1 < o.Properties.length; i += 2)
    if (o.Properties[i] === id) return String(o.Properties[i + 1]);
  return undefined;
};

describe('delete_paragraph', () => {
  test('resubmits the shape without the paragraph’s block, keeping its neighbours in order', () => {
    const objects = objectsOf(
      buildDeleteParagraphBody(resolveDeleteParagraphContext(model(), 'Scratch ask'), GUID, HEAD, '{}'),
    );
    expect(objects).toHaveLength(2);
    expect(propOf(objects[0], 469780989)).toBe('DeleteKey');
    expect(objects[1]?.ObjectId).toBe(SHAPE);
    expect(propOf(objects[1], 603986976)).toBe('{a1}{1},{a3}{1}');
    expect(propOf(objects[1], 469780826)).toBe('Content Placeholder 1');
  });

  test('refuses a paragraph whose block holds others, and the last paragraph in a shape', () => {
    expect(() => resolveDeleteParagraphContext(model(2), 'Scratch ask')).toThrow(/shares its text block/);
    const lone = model();
    const shape = lone.objects.find(o => o.objectId === SHAPE);
    if (shape) shape.properties = [603986976, '{a2}{1}'];
    expect(() => resolveDeleteParagraphContext(lone, 'Scratch ask')).toThrow(/only paragraph/);
  });

  test('confirms only once the shape stops listing the block', () => {
    const first = resolveDeleteParagraphContext(model(), 'Scratch ask');
    const args = { text: 'Scratch ask' };
    expect(deleteParagraphAction.isApplied(model(), first, args)).toBe(false);
    const after = model();
    const shape = after.objects.find(o => o.objectId === SHAPE);
    if (shape) shape.properties = [603986976, '{a1}{1},{a3}{1}'];
    expect(deleteParagraphAction.isApplied(after, first, args)).toBe(true);
  });

  test('parseArgs requires the text, and the action is never re-issued blindly', () => {
    expect(() => deleteParagraphAction.parseArgs({})).toThrow(/needs `text`/);
    expect(deleteParagraphAction.idempotent).toBe(false);
  });
});
