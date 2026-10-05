import { describe, expect, test } from 'vitest';
import type { PodsMint } from './pods-actions.js';
import type { PodsModel, PodsObject } from './pods-model.js';
import {
  wordDeleteParagraphAction,
  wordInsertParagraphsAction,
  wordReadAction,
  wordReplaceTextAction,
} from './word-actions.js';
import { listWordParagraphs, WORD_ENVELOPE_FLAG } from './word-live-model.js';

const CELL = '7a1bb8d8-aa5f-4237-9adc-4d5b9ab9bdc0|1';
const MINT: PodsMint = { guidToken: 'G', headToken: 'H', seed: 'seed', actionTime: '1' };

const paragraph = (id: string, text: string, extra: (string | number)[] = []): PodsObject => ({
  classId: 393230,
  objectId: id,
  properties: [469769250, text, 603987475, '{fa}{1}', ...extra],
  cellId: CELL,
});
const block = (id: string, child: string): PodsObject => ({
  classId: 393229,
  objectId: id,
  properties: [603986975, `{${child.split('|')[0]}}{${child.split('|')[1]}}`],
  cellId: CELL,
});

/**
 * The live document as the zero-base read rebuilds it: a title, a heading, a
 * one-cell table holding one paragraph, and two body paragraphs in a second body
 * container — plus a retired block nothing lists any more.
 */
const model = (): PodsModel => ({
  totalObjects: 0,
  objects: [
    { classId: 393271, objectId: 'a0|1', properties: [603986975, '{a1}{1}'], cellId: CELL },
    { classId: 393227, objectId: 'a1|1', properties: [603986976, '{a2}{1}'] },
    { classId: 1073872968, objectId: 'a2|1', properties: [603986976, '{b0}{1},{b0}{2}'] },
    { classId: 393241, objectId: 'b0|1', properties: [134233171, 'true', 603986976, '{b}{1},{b}{2},{b}{3}'] },
    block('b|1', 'd|1'),
    paragraph('d|1', 'Weekly Status Notes'),
    block('b|2', 'd|2'),
    paragraph('d|2', 'Open questions', [536884268, '{f1}{1}']),
    { classId: 1073872969, objectId: 'f1|1', properties: [469775450, 'heading 1'] },
    block('b|3', 'e0|1'),
    { classId: 393250, objectId: 'e0|1', properties: [603986976, '{e1}{1}'] },
    { classId: 393251, objectId: 'e1|1', properties: [603986976, '{ce}{1}'] },
    { classId: 393252, objectId: 'ce|1', properties: [603986976, '{b}{4}'] },
    block('b|4', 'd|4'),
    paragraph('d|4', 'Owner: the review team'),
    { classId: 393241, objectId: 'b0|2', properties: [603986976, '{b}{5},{b}{6}'] },
    block('b|5', 'd|5'),
    paragraph('d|5', 'The review team meets weekly.'),
    block('b|6', 'd|6'),
    paragraph('d|6', 'Next steps follow.', [335559682, '3', 335559683, '1']),
    block('b|9', 'd|9'),
    paragraph('d|9', 'A deleted paragraph'),
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const entryOf = (body: Record<string, unknown>): Record<string, unknown> =>
  (body.srs as [number, Record<string, unknown>][])[0]?.[1] as Record<string, unknown>;
const objectsOf = (body: Record<string, unknown>): Obj[] => {
  const revision = entryOf(body).Revision as { ObjectGroups: { Objects: Obj[] }[] };
  return revision.ObjectGroups[0]?.Objects ?? [];
};
const propOf = (o: Obj | undefined, id: number): string | undefined => {
  for (let i = 0; o && i + 1 < o.Properties.length; i += 2)
    if (o.Properties[i] === id) return String(o.Properties[i + 1]);
  return undefined;
};

describe('listWordParagraphs', () => {
  test('walks body containers and tables in reading order, skipping unlisted blocks', () => {
    const paragraphs = listWordParagraphs(model());
    expect(paragraphs.map(p => [p.index, p.text, p.inTable, p.container.objectId])).toEqual([
      [1, 'Weekly Status Notes', false, 'b0|1'],
      [2, 'Open questions', false, 'b0|1'],
      [3, 'Owner: the review team', true, 'ce|1'],
      [4, 'The review team meets weekly.', false, 'b0|2'],
      [5, 'Next steps follow.', false, 'b0|2'],
    ]);
  });
});

describe('word_read', () => {
  test('reports style names and list levels', () => {
    const read = wordReadAction.read(model(), {});
    expect((read.paragraphs as { style: string | null; listLevel: number | null }[]).slice(1, 5)).toEqual([
      expect.objectContaining({ style: 'heading 1', listLevel: null }),
      expect.objectContaining({ inTable: true }),
      expect.objectContaining({ listLevel: null }),
      expect.objectContaining({ listLevel: 1 }),
    ]);
    expect(read.totalParagraphs).toBe(5);
  });
});

describe('word_replace_text', () => {
  test('requires a unique match unless all is set', () => {
    const args = wordReplaceTextAction.parseArgs({ find: 'review team', replace: 'inventory team' });
    expect(() => wordReplaceTextAction.resolve(model(), args)).toThrow(/occurs 2 times \(paragraphs #3, #4\)/);
  });

  test('rewrites every matching paragraph in one flagged revision', () => {
    const args = wordReplaceTextAction.parseArgs({ find: 'review team', replace: 'inventory team', all: true });
    const ctx = wordReplaceTextAction.resolve(model(), args);
    const body = wordReplaceTextAction.build(ctx, args, MINT);
    expect(entryOf(body)[WORD_ENVELOPE_FLAG]).toBe(true);
    expect((entryOf(body).Revision as { BaseId: string; CellId: string }).BaseId).toBe('H');
    expect(objectsOf(body).map(o => [o.ObjectId, propOf(o, 469769250)])).toEqual([
      ['d|4', 'Owner: the inventory team'],
      ['d|5', 'The inventory team meets weekly.'],
    ]);
  });

  test('confirms by paragraph id', () => {
    const args = wordReplaceTextAction.parseArgs({ find: 'Weekly', replace: 'Monthly' });
    const ctx = wordReplaceTextAction.resolve(model(), args);
    expect(wordReplaceTextAction.isApplied(model(), ctx, args)).toBe(false);
    const after = model();
    after.objects = after.objects.map(o => (o.objectId === 'd|1' ? paragraph('d|1', 'Monthly Status Notes') : o));
    expect(wordReplaceTextAction.isApplied(after, ctx, args)).toBe(true);
  });

  test('rejects a missing match and line breaks', () => {
    expect(() => wordReplaceTextAction.resolve(model(), { find: 'absent', replace: 'x', all: false })).toThrow(
      /does not occur/,
    );
    expect(() => wordReplaceTextAction.parseArgs({ find: 'a', replace: 'b\nc' })).toThrow(/line breaks/);
  });
});

describe('word_insert_paragraphs', () => {
  test('lists new blocks after the anchor in its own container, modelled on the anchor', () => {
    const args = wordInsertParagraphsAction.parseArgs({ anchor: 'Next steps', paragraphs: ['One.', 'Two.'] });
    const ctx = wordInsertParagraphsAction.resolve(model(), args);
    const objects = objectsOf(wordInsertParagraphsAction.build(ctx, args, MINT));
    expect(objects[0]?.ObjectId).toBe('b0|2');
    expect(propOf(objects[0], 603986976)).toBe('{b}{5},{b}{6},{G}{3},{G}{5}');
    expect(objects.slice(1).map(o => [o.ObjectId, o.ClassId])).toEqual([
      ['G|3', 393229],
      ['G|4', 393230],
      ['G|5', 393229],
      ['G|6', 393230],
    ]);
    expect(propOf(objects[2], 469769250)).toBe('One.');
    expect(propOf(objects[2], 335559683)).toBe('1');
    expect(propOf(objects[1], 603986975)).toBe('{G}{4}');
  });

  test('inserts before the anchor, named by index', () => {
    const args = wordInsertParagraphsAction.parseArgs({ index: 1, position: 'before', paragraphs: ['Draft'] });
    const ctx = wordInsertParagraphsAction.resolve(model(), args);
    const objects = objectsOf(wordInsertParagraphsAction.build(ctx, args, MINT));
    expect(propOf(objects[0], 603986976)).toBe('{G}{3},{b}{1},{b}{2},{b}{3}');
    expect(propOf(objects[0], 134233171)).toBe('true');
  });

  test('confirms by new blocks carrying the requested text in order', () => {
    const args = wordInsertParagraphsAction.parseArgs({ anchor: 'Weekly', paragraphs: ['One.', 'Two.'] });
    const ctx = wordInsertParagraphsAction.resolve(model(), args);
    const after = model();
    after.objects = [
      ...after.objects.map(o =>
        o.objectId === 'b0|1' ? { ...o, properties: [603986976, '{b}{1},{c}{1},{c}{3},{b}{2},{b}{3}'] } : o,
      ),
      block('c|1', 'c|2'),
      paragraph('c|2', 'One.'),
      block('c|3', 'c|4'),
      paragraph('c|4', 'Two.'),
    ];
    expect(wordInsertParagraphsAction.isApplied(model(), ctx, args)).toBe(false);
    expect(wordInsertParagraphsAction.isApplied(after, ctx, args)).toBe(true);
  });

  test('rejects an ambiguous anchor with the candidates', () => {
    const args = wordInsertParagraphsAction.parseArgs({ anchor: 'team', paragraphs: ['x'] });
    expect(() => wordInsertParagraphsAction.resolve(model(), args)).toThrow(/matches 2 paragraphs/);
  });
});

describe('word_delete_paragraph', () => {
  test('unlists the paragraph’s block from its container', () => {
    const args = wordDeleteParagraphAction.parseArgs({ anchor: 'Open questions' });
    const ctx = wordDeleteParagraphAction.resolve(model(), args);
    const objects = objectsOf(wordDeleteParagraphAction.build(ctx, args, MINT));
    expect(objects).toHaveLength(1);
    expect(propOf(objects[0], 603986976)).toBe('{b}{1},{b}{3}');
  });

  test('refuses the last paragraph of a table cell', () => {
    const args = wordDeleteParagraphAction.parseArgs({ index: 3 });
    expect(() => wordDeleteParagraphAction.resolve(model(), args)).toThrow(/only one in its table cell/);
  });

  test('confirms once no container lists the block', () => {
    const args = wordDeleteParagraphAction.parseArgs({ index: 5 });
    const ctx = wordDeleteParagraphAction.resolve(model(), args);
    const after = model();
    after.objects = after.objects.map(o => (o.objectId === 'b0|2' ? { ...o, properties: [603986976, '{b}{5}'] } : o));
    expect(wordDeleteParagraphAction.isApplied(model(), ctx, args)).toBe(false);
    expect(wordDeleteParagraphAction.isApplied(after, ctx, args)).toBe(true);
  });
});
