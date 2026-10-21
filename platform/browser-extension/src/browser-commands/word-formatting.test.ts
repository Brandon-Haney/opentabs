import { describe, expect, test } from 'vitest';
import type { PodsMint } from './pods-actions.js';
import { revisionObjects } from './pods-actions.js';
import type { PodsModel, PodsObject } from './pods-model.js';
import { wordInsertParagraphsAction } from './word-actions.js';
import {
  derivedFormat,
  formatRanges,
  paragraphProperties,
  wordColor,
  wordFormatParagraphAction,
  wordFormatTextAction,
} from './word-formatting.js';
import { wordRemoveLinkAction } from './word-links.js';
import { hexColor, linkTarget, wordReadFormattingAction } from './word-read-formatting.js';

const CELL = '7a1bb8d8-aa5f-4237-9adc-4d5b9ab9bdc0|1';
const MINT: PodsMint = { guidToken: 'G', headToken: 'H', seed: 'seed', actionTime: '1' };
const ZERO = '{00000000-0000-0000-0000-000000000000}{0}';

const block = (id: string, child: string): PodsObject => ({
  classId: 393229,
  objectId: id,
  properties: [603986975, `{${child.split('|')[0]}}{${child.split('|')[1]}}`],
  cellId: CELL,
});
const paragraph = (id: string, properties: (string | number)[]): PodsObject => ({
  classId: 393230,
  objectId: id,
  properties,
  cellId: CELL,
});

/**
 * A document of four paragraphs, as the captures showed them: a plain one; one
 * whose middle word is bold; a bullet whose text is a link (field characters
 * around text formatted with the Hyperlink style); and a heading.
 */
const model = (): PodsModel => ({
  totalObjects: 0,
  objects: [
    { classId: 393271, objectId: 'a0|1', properties: [603986975, '{a1}{1}', 603995325, '{f0}{1}'], cellId: CELL },
    { classId: 393227, objectId: 'a1|1', properties: [603986976, '{a2}{1}'] },
    { classId: 1073872968, objectId: 'a2|1', properties: [603986976, '{b0}{1}'] },
    { classId: 393241, objectId: 'b0|1', properties: [603986976, '{b}{1},{b}{2},{b}{3},{b}{4}'] },
    block('b|1', 'd|1'),
    paragraph('d|1', [469769250, 'Plain words here.', 603987475, '{f0}{1}', 469777884, ZERO, 469777513, '0']),
    block('b|2', 'd|2'),
    paragraph('d|2', [
      469769250,
      'Some bold text.',
      469777884,
      `${ZERO},${ZERO},${ZERO}`,
      603987475,
      '{f0}{1},{fb}{1},{f0}{1}',
      469769746,
      '5,9',
    ]),
    block('b|3', 'd|3'),
    paragraph('d|3', [
      469769250,
      '￼￼SOP 3.1￼',
      335559682,
      '1',
      536886591,
      '{f0}{1}',
      603987475,
      '{fc}{1},{fc}{2},{fd}{1},{fc}{3}',
      469777884,
      `${ZERO},${ZERO},${ZERO},${ZERO}`,
      469769746,
      '1,2,9',
    ]),
    block('b|4', 'd|4'),
    paragraph('d|4', [
      469769250,
      'Next steps',
      603987475,
      '{f0}{1}',
      536884268,
      '{e1}{1}',
      335551550,
      '2',
      335551620,
      '2',
    ]),
    { classId: 1179649, objectId: 'f0|1', properties: [201342000, '0', 335551547, '1033'] },
    { classId: 1179649, objectId: 'fb|1', properties: [335560228, '1', 201342000, '0', 134224900, 'true'] },
    { classId: 1179649, objectId: 'fd|1', properties: [335560228, '1', 536884443, '{e2}{37}'] },
    { classId: 1073872969, objectId: 'e1|1', properties: [469775450, 'heading 1'] },
    { classId: 1073872969, objectId: 'e1|0', properties: [469775450, 'Normal'] },
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const objectsOf = (body: Record<string, unknown>): Obj[] => {
  const entry = (body.srs as [number, { Revision: { ObjectGroups: { Objects: Obj[] }[] } }][])[0]?.[1];
  return entry?.Revision.ObjectGroups[0]?.Objects ?? [];
};
const propOf = (o: { Properties?: (string | number)[]; properties?: (string | number)[] } | undefined, id: number) => {
  const list = o?.Properties ?? o?.properties ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i] === id) return String(list[i + 1]);
  return undefined;
};

describe('wordColor', () => {
  test('writes #RRGGBB as 0xBBGGRR', () => {
    expect(wordColor('#FF0000')).toBe('255');
    expect(wordColor('ffff00')).toBe('65535');
    expect(() => wordColor('red')).toThrow(/not a colour/);
  });
});

describe('formatRanges', () => {
  test('splits runs at the range edges and remaps only the spans inside it', () => {
    const properties = formatRanges(
      [469769250, 'Some bold text.', 603987475, '{f0}{1},{fb}{1},{f0}{1}', 469777884, 'a,b,c', 469769746, '5,9'],
      [[2, 7]],
      ref => `${ref}*`,
    );
    expect(propOf({ properties }, 469769746)).toBe('2,5,7,9');
    expect(propOf({ properties }, 603987475)).toBe('{f0}{1},{f0}{1}*,{fb}{1}*,{fb}{1},{f0}{1}');
    expect(propOf({ properties }, 469777884)).toBe('a,a,b,b,c');
  });

  test('keeps a span whose format the remap does not cover', () => {
    const properties = formatRanges([469769250, 'abc', 603987475, '{x}{1}'], [[0, 3]], () => undefined);
    expect(propOf({ properties }, 603987475)).toBe('{x}{1}');
    expect(propOf({ properties }, 469769746)).toBeUndefined();
  });
});

describe('derivedFormat', () => {
  test('adds the change to the base format and marks it as setting a property', () => {
    expect(derivedFormat([201342000, '0', 335551547, '1033'], { italic: true, size: 14 })).toEqual([
      201342000,
      '0',
      335551547,
      '1033',
      335560228,
      '1',
      134224901,
      'true',
      268442635,
      '28',
    ]);
  });

  test('clear writes the cleared format whatever the base', () => {
    expect(derivedFormat([134224900, 'true'], 'clear')).toEqual([201342000, '0', 134233130, 'true']);
  });
});

describe('word_format_text', () => {
  test('formats a match: one new format per base, the paragraph re-split, the root listing them', () => {
    const args = wordFormatTextAction.parseArgs({ find: 'bold text', color: '#FF0000' });
    const ctx = wordFormatTextAction.resolve(model(), args);
    const objects = objectsOf(wordFormatTextAction.build(ctx, args, MINT));
    expect(objects.map(o => [o.ObjectId, o.ClassId])).toEqual([
      ['a0|1', 393271],
      ['d|2', 393230],
      ['G|3', 1179649],
      ['G|4', 1179649],
    ]);
    expect(propOf(objects[0], 603995325)).toBe('{f0}{1},{G}{3},{G}{4}');
    expect(propOf(objects[1], 469769746)).toBe('5,9,14');
    expect(propOf(objects[1], 603987475)).toBe('{f0}{1},{G}{4},{G}{3},{f0}{1}');
    expect(propOf(objects[2], 335551500)).toBe('255');
    expect(propOf(objects[3], 134224900)).toBe('true');
    expect(propOf(objects[3], 335551500)).toBe('255');
  });

  test('clears a whole paragraph named by index without touching its field characters', () => {
    const args = wordFormatTextAction.parseArgs({ index: 3, clear: true });
    const ctx = wordFormatTextAction.resolve(model(), args);
    const objects = objectsOf(wordFormatTextAction.build(ctx, args, MINT));
    expect(propOf(objects[1], 603987475)).toBe('{fc}{1},{fc}{2},{G}{3},{fc}{3}');
    expect(objects[2]?.Properties).toEqual([201342000, '0', 134233130, 'true']);
  });

  test('requires a unique match and a change', () => {
    expect(() =>
      wordFormatTextAction.resolve(model(), wordFormatTextAction.parseArgs({ find: 'e', bold: true })),
    ).toThrow(/occurs \d+ times/);
    expect(() => wordFormatTextAction.parseArgs({ find: 'bold' })).toThrow(/needs a change/);
    expect(() => wordFormatTextAction.parseArgs({ find: 'x', superscript: true, subscript: true })).toThrow(
      /both superscript and subscript/,
    );
  });

  test('confirms when every run covering the match carries the change', () => {
    const args = wordFormatTextAction.parseArgs({ find: 'Plain', italic: true });
    const ctx = wordFormatTextAction.resolve(model(), args);
    expect(wordFormatTextAction.isApplied(model(), ctx, args)).toBe(false);
    const after = model();
    after.objects = after.objects.map(o =>
      o.objectId === 'd|1'
        ? paragraph('d|1', [469769250, 'Plain words here.', 603987475, '{c0}{1},{f0}{1}', 469769746, '5'])
        : o,
    );
    after.objects.push({ classId: 1179649, objectId: 'c0|1', properties: [134224901, 'true'] });
    expect(wordFormatTextAction.isApplied(after, ctx, args)).toBe(true);
  });
});

describe('word_format_paragraph', () => {
  test('writes the decoded paragraph properties', () => {
    expect(
      paragraphProperties({
        alignment: 'justify',
        indentLeft: 36,
        spaceBefore: 12,
        lineSpacing: 1.5,
        shading: '#D9E1F2',
      }),
    ).toEqual({
      set: [
        [335551550, '6'],
        [335551620, '6'],
        [335559685, '720'],
        [335559738, '240'],
        [134233117, 'false'],
        [335559740, '360'],
        [201341983, '0'],
        [335557856, '15917529'],
      ],
      remove: [],
    });
    expect(paragraphProperties({ alignment: 'left', shading: 'none' })).toEqual({
      set: [],
      remove: [335551550, 335551620, 335557856],
    });
  });

  test('applying a style clears direct formatting and points the runs at a cleared format', () => {
    const args = wordFormatParagraphAction.parseArgs({ anchor: 'Next steps', style: 'NORMAL' });
    const ctx = wordFormatParagraphAction.resolve(model(), args);
    const objects = objectsOf(wordFormatParagraphAction.build(ctx, args, MINT));
    expect(objects.map(o => o.ObjectId)).toEqual(['a0|1', 'a1|1', 'G|3', 'd|4']);
    expect(propOf(objects[1], 603993304)).toBe('{e1}{0}');
    expect(propOf(objects[1], 469789709)).toBe('["Normal"]');
    const target = objects[3];
    expect(propOf(target, 536884268)).toBe('{e1}{0}');
    expect(propOf(target, 134233130)).toBe('true');
    expect(propOf(target, 335551550)).toBeUndefined();
    expect(propOf(target, 603987475)).toBe('{G}{3}');
  });

  test('names the styles the document has when asked for one it lacks', () => {
    const args = wordFormatParagraphAction.parseArgs({ index: 1, style: 'Title' });
    expect(() => wordFormatParagraphAction.resolve(model(), args)).toThrow(/no style named "Title".*Normal, heading 1/);
  });

  test('confirms by the paragraph carrying the properties', () => {
    const args = wordFormatParagraphAction.parseArgs({ index: 4, alignment: 'left' });
    const ctx = wordFormatParagraphAction.resolve(model(), args);
    expect(wordFormatParagraphAction.isApplied(model(), ctx, args)).toBe(false);
    const after = model();
    after.objects = after.objects.map(o =>
      o.objectId === 'd|4' ? paragraph('d|4', [469769250, 'Next steps', 536884268, '{e1}{1}']) : o,
    );
    expect(wordFormatParagraphAction.isApplied(after, ctx, args)).toBe(true);
  });
});

describe('word_insert_paragraphs after a link', () => {
  test('gives the new paragraph the mark format, not the link’s', () => {
    const args = wordInsertParagraphsAction.parseArgs({ index: 3, paragraphs: ['New bullet'] });
    const ctx = wordInsertParagraphsAction.resolve(model(), args);
    const created = objectsOf(wordInsertParagraphsAction.build(ctx, args, MINT)).find(o => o.ObjectId === 'G|4');
    expect(propOf(created, 603987475)).toBe('{f0}{1}');
    expect(propOf(created, 335559682)).toBe('1');
  });

  test('keeps copying the longest plain run when there is one', () => {
    const args = wordInsertParagraphsAction.parseArgs({ index: 2, paragraphs: ['Another'] });
    const ctx = wordInsertParagraphsAction.resolve(model(), args);
    const created = objectsOf(wordInsertParagraphsAction.build(ctx, args, MINT)).find(o => o.ObjectId === 'G|4');
    expect(propOf(created, 603987475)).toBe('{f0}{1}');
  });
});

describe('word_read_formatting', () => {
  const withFields = (): PodsModel => {
    const m = model();
    m.objects.push(
      {
        classId: 131073,
        objectId: 'fc|1',
        properties: [335559696, '15', 469777596, 'HYPERLINK "https://example.com/sop" '],
      },
      { classId: 131073, objectId: 'fc|2', properties: [335559696, '16'] },
      { classId: 131073, objectId: 'fc|3', properties: [335559696, '17'] },
    );
    return m;
  };

  test('reports paragraph formatting and runs, merging same-looking runs and marking links', () => {
    const read = wordReadFormattingAction.read(withFields(), wordReadFormattingAction.parseArgs({}));
    const paragraphs = read.paragraphs as Record<string, unknown>[];
    expect(paragraphs[1]).toEqual({
      index: 2,
      text: 'Some bold text.',
      style: null,
      runs: [{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' text.' }],
    });
    expect(paragraphs[2]).toEqual(
      expect.objectContaining({
        text: 'SOP 3.1',
        listLevel: 0,
        runs: [{ text: 'SOP 3.1', link: 'https://example.com/sop' }],
      }),
    );
    expect(paragraphs[3]).toEqual(expect.objectContaining({ style: 'heading 1', alignment: 'center' }));
  });

  test('reads a range', () => {
    const read = wordReadFormattingAction.read(withFields(), wordReadFormattingAction.parseArgs({ from: 2, to: 3 }));
    expect((read.paragraphs as { index: number }[]).map(p => p.index)).toEqual([2, 3]);
    expect(() => wordReadFormattingAction.parseArgs({ from: 3, to: 2 })).toThrow(/must not be before/);
  });

  test('decodes colours and link codes', () => {
    expect(hexColor('255')).toBe('#FF0000');
    expect(hexColor('15983321')).toBe('#D9E2F3');
    expect(linkTarget('HYPERLINK "https://a.test/x" o "tip"')).toBe('https://a.test/x');
  });
});

describe('word_insert_paragraphs format_like', () => {
  test('copies the named paragraph’s formatting instead of the anchor’s', () => {
    const args = wordInsertParagraphsAction.parseArgs({ index: 3, paragraphs: ['Body text'], format_like: 1 });
    const ctx = wordInsertParagraphsAction.resolve(model(), args);
    const created = objectsOf(wordInsertParagraphsAction.build(ctx, args, MINT)).find(o => o.ObjectId === 'G|4');
    expect(propOf(created, 335559682)).toBeUndefined();
    expect(propOf(created, 603987475)).toBe('{f0}{1}');
    expect(() => wordInsertParagraphsAction.parseArgs({ index: 1, paragraphs: ['x'], format_like: 0 })).toThrow(
      /format_like/,
    );
  });
});

const fieldCharacters: PodsObject[] = [
  {
    classId: 131073,
    objectId: 'fc|1',
    properties: [335559696, '15', 469777596, 'HYPERLINK "https://example.com/sop" '],
  },
  { classId: 131073, objectId: 'fc|2', properties: [335559696, '16'] },
  { classId: 131073, objectId: 'fc|3', properties: [335559696, '17'] },
];
const linked = (): PodsModel => {
  const m = model();
  m.objects.push(...fieldCharacters);
  return m;
};

describe('word_remove_link', () => {
  test('drops the field placeholders and points the link text at an unlinked format', () => {
    const args = wordRemoveLinkAction.parseArgs({ find: 'SOP' });
    const ctx = wordRemoveLinkAction.resolve(linked(), args);
    const objects = objectsOf(wordRemoveLinkAction.build(ctx, args, MINT));
    expect(objects.map(o => o.ObjectId)).toEqual(['a0|1', 'd|3', 'G|3']);
    expect(propOf(objects[1], 469769250)).toBe('SOP 3.1');
    expect(propOf(objects[1], 469769746)).toBeUndefined();
    expect(propOf(objects[1], 603987475)).toBe('{G}{3}');
    expect(propOf(objects[1], 469777884)).toBe(ZERO);
    expect(propOf(objects[2], 536884443)).toBeUndefined();
    expect(propOf(objects[2], 134225428)).toBe('false');
    expect(propOf(objects[2], 134225433)).toBe('false');
    expect(wordRemoveLinkAction.summarize(ctx, args)).toEqual({
      removed: [{ index: 3, address: 'https://example.com/sop', text: 'SOP 3.1' }],
    });
  });

  test('confirms when the paragraph reads without the placeholders', () => {
    const args = wordRemoveLinkAction.parseArgs({ index: 3 });
    const ctx = wordRemoveLinkAction.resolve(linked(), args);
    expect(wordRemoveLinkAction.isApplied(linked(), ctx, args)).toBe(false);
    const after = linked();
    after.objects = after.objects.map(o => (o.objectId === 'd|3' ? paragraph('d|3', [469769250, 'SOP 3.1']) : o));
    expect(wordRemoveLinkAction.isApplied(after, ctx, args)).toBe(true);
  });

  test('says when there is no such link', () => {
    expect(() => wordRemoveLinkAction.resolve(linked(), wordRemoveLinkAction.parseArgs({ index: 1 }))).toThrow(
      /has no links/,
    );
    expect(() => wordRemoveLinkAction.resolve(linked(), wordRemoveLinkAction.parseArgs({ find: 'nope' }))).toThrow(
      /No link displaying "nope"/,
    );
  });
});

describe('paragraph flags and automatic colour', () => {
  test('writes keep-with-next, keep-lines-together and page-break-before', () => {
    expect(paragraphProperties({ keepWithNext: true, keepLinesTogether: false, pageBreakBefore: true }).set).toEqual([
      [134245418, 'true'],
      [134245529, 'false'],
      [134245659, 'true'],
    ]);
  });

  test('auto is the automatic font colour, and is refused for highlight', () => {
    expect(wordColor('auto')).toBe('4278190080');
    expect(() => wordFormatTextAction.parseArgs({ find: 'x', highlight: 'auto' })).toThrow(/highlight/);
  });

  test('highlight none writes No Color', () => {
    const args = wordFormatTextAction.parseArgs({ find: 'Plain', highlight: 'none' });
    expect(args.changes).toEqual(expect.objectContaining({ highlight: 'none' }));
    const objects = objectsOf(wordFormatTextAction.build(wordFormatTextAction.resolve(model(), args), args, MINT));
    expect(propOf(objects[2], 335551501)).toBe('4278190080');
  });
});

describe('compact dry run', () => {
  test('reduces a revision to the objects it writes', () => {
    const args = wordFormatTextAction.parseArgs({ find: 'Plain', bold: true });
    const body = wordFormatTextAction.build(wordFormatTextAction.resolve(model(), args), args, MINT);
    expect(revisionObjects(body)).toEqual({
      objects: [
        { objectId: 'a0|1', classId: 393271, properties: 2 },
        { objectId: 'd|1', classId: 393230, properties: 5 },
        { objectId: 'G|3', classId: 1179649, properties: 4 },
      ],
    });
  });
});
