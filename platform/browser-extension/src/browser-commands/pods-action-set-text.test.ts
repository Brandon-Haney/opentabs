import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildReplaceBlockBody, buildSetTextBody, resolveSetTextContext, setTextAction } = await import(
  './pods-action-set-text.js'
);
const { resolveRunFormatTarget } = await import('./pods-action-run-format.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { ResolvedTarget } from './pods-action-run-format.js';
import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';

/**
 * A single-run paragraph shaped like the captured Typing exemplar: run-ref and
 * end-mark reference the same existing run, and the paragraph carries layout
 * properties that must survive the rewrite verbatim.
 */
const target = (): ResolvedTarget => ({
  cellId: '23069e19-9218-5ae4-9815-d8ceaade97df|3',
  actionDescId: 'b3ab583c-77cd-428d-9371-02c2ea7c058b|1',
  paragraphId: '1b190d82-afc7-4c66-adda-078fe5f6db84|25',
  paragraphProperties: [
    469769250,
    'Testing',
    603987475,
    '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
    536886591,
    '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
    335551550,
    '1',
    469780757,
    '{"Lines":[1]}',
    134236461,
    'true',
  ],
  text: 'Testing',
  runRef: '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
  segments: [{ start: 0, end: 'Testing'.length, ref: '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}' }],
  runsByRef: new Map([
    [
      '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
      { classId: 1179725, objectId: 'cfc16549-02d7-4fbe-85bd-3d047593bf17|222', properties: [268442635, '22'] },
    ],
  ]),
  textRuns: [
    {
      ref: '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
      objectId: 'cfc16549-02d7-4fbe-85bd-3d047593bf17|222',
      properties: [268442635, '22'],
      sizeHalfPt: '22',
      bold: null,
      italic: null,
    },
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const revisionOf = (body: Record<string, unknown>) => {
  const srs = body.srs as [number, Record<string, unknown>][];
  const outer = srs[0];
  if (!outer) throw new Error('missing srs');
  const inner = outer[1];
  const revision = (inner.Revisions as Record<string, unknown>[])[0];
  if (!revision) throw new Error('missing revision');
  const group = (revision.ObjectGroups as { Id: string; Objects: Obj[] }[])[0];
  if (!group) throw new Error('missing group');
  const [action, paragraph] = group.Objects;
  if (!action || !paragraph) throw new Error('expected action and paragraph');
  return { discriminator: outer[0], inner, revision, group, action, paragraph, objectCount: group.Objects.length };
};
const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('buildSetTextBody', () => {
  test('matches the captured Typing shape: an action descriptor and the paragraph, no run object', () => {
    const body = buildSetTextBody(target(), 'Replaced', GUID, HEAD);
    expect(body.Mode).toBe(4);
    const { discriminator, inner, revision, group, action, paragraph, objectCount } = revisionOf(body);
    expect(discriminator).toBe(3);
    expect(objectCount).toBe(2);
    expect(inner.Sequence).toBe(37);
    expect(inner.ExpectedLatestId).toBe(HEAD);
    expect(revision.Id).toBe(`${GUID}|2`);
    expect(revision.BaseId).toBe(HEAD);
    expect(revision.CellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(group.Id).toBe(`${GUID}|3`);
    expect([action.ClassId, paragraph.ClassId]).toEqual([131140, 393230]);
  });

  test('patches only the text; every other paragraph property is copied verbatim', () => {
    const { paragraph } = revisionOf(buildSetTextBody(target(), 'Replaced', GUID, HEAD));
    expect(paragraph.ObjectId).toBe('1b190d82-afc7-4c66-adda-078fe5f6db84|25');
    expect(propValue(paragraph.Properties, 469769250)).toBe('Replaced');
    // The run references keep pointing at the EXISTING run — the formatting source.
    expect(propValue(paragraph.Properties, 603987475)).toBe('{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}');
    expect(propValue(paragraph.Properties, 536886591)).toBe('{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}');
    // Layout, line-count, and flag properties survive untouched.
    expect(propValue(paragraph.Properties, 335551550)).toBe('1');
    expect(propValue(paragraph.Properties, 469780757)).toBe('{"Lines":[1]}');
    expect(propValue(paragraph.Properties, 134236461)).toBe('true');
  });

  test('writes the paragraph properties sorted ascending, matching the editor Typing write', () => {
    const { paragraph } = revisionOf(buildSetTextBody(target(), 'Replaced', GUID, HEAD));
    const ids: number[] = [];
    for (let i = 0; i < paragraph.Properties.length; i += 2) ids.push(Number(paragraph.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('the action descriptor names Typing in the three-property form, with no ActionId json', () => {
    const { action } = revisionOf(buildSetTextBody(target(), 'Replaced', GUID, HEAD));
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
    expect(action.Properties).toEqual([134236193, 'true', 335562934, '1', 469780989, 'Typing']);
  });

  test('a run carrying its OWN text is replaced format-style, keeping run and paragraph text in step', () => {
    // A paragraph/run text divergence makes the editor split runs and resurrect
    // deleted text (observed live), so the run's text must move with the write.
    const withRunText = target();
    withRunText.textRuns = [
      {
        ref: '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
        objectId: 'cfc16549-02d7-4fbe-85bd-3d047593bf17|222',
        properties: [268442635, '22', 469769250, 'Testing'],
        sizeHalfPt: '22',
        bold: null,
        italic: null,
      },
    ];
    const body = buildSetTextBody(withRunText, 'Replaced', GUID, HEAD);
    const group = ((body.srs as [number, Record<string, unknown>][])[0]?.[1].Revisions as Record<string, unknown>[])[0]
      ?.ObjectGroups as { Objects: Obj[] }[];
    const objects = group[0]?.Objects ?? [];
    expect(objects).toHaveLength(3);
    const [, paragraph, run] = objects;
    if (!paragraph || !run) throw new Error('expected paragraph and run');
    // The replacement run takes the reference and carries the new text; formatting props survive.
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{1}`);
    expect(run.ObjectId).toBe(`${GUID}|1`);
    expect(propValue(run.Properties, 469769250)).toBe('Replaced');
    expect(propValue(run.Properties, 268442635)).toBe('22');
    expect(propValue(paragraph.Properties, 469769250)).toBe('Replaced');
  });

  test('a multi-run paragraph is refused by the in-place write, which cannot re-cut runs', () => {
    const multi = target();
    multi.textRuns.push({
      ref: '{other}{1}',
      objectId: 'other|1',
      properties: [268442635, '22'],
      sizeHalfPt: '22',
      bold: null,
      italic: null,
    });
    expect(() => buildSetTextBody(multi, 'Replaced', GUID, HEAD)).toThrow(FrameBridgeValidationError);
  });

  test('a paragraph with no resolvable runs is rejected — it is not editable text', () => {
    const bare = target();
    bare.textRuns = [];
    expect(() => buildSetTextBody(bare, 'Replaced', GUID, HEAD)).toThrow(FrameBridgeValidationError);
  });
});

describe('setTextAction spec', () => {
  const model = (paragraphText = 'Testing'): PodsModel => ({
    totalObjects: 4,
    objects: [
      {
        classId: 393271,
        objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
        properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{s}{1}'],
      },
      {
        classId: 1074135132,
        objectId: 'aaaaaaaa-0000-0000-0000-000000000000|1',
        properties: [603986976, '{bbbbbbbb-0000-0000-0000-000000000000}{1}'],
      },
      {
        classId: 393229,
        objectId: 'bbbbbbbb-0000-0000-0000-000000000000|1',
        properties: [603986975, '{1b190d82-afc7-4c66-adda-078fe5f6db84}{25}'],
      },
      {
        classId: 393230,
        objectId: '1b190d82-afc7-4c66-adda-078fe5f6db84|25',
        properties: [469769250, paragraphText, 603987475, '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}'],
      },
      {
        classId: 393230,
        objectId: 'decoy|1',
        properties: [469769250, 'Replaced', 603987475, '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{223}'],
      },
      { classId: 1179725, objectId: 'cfc16549-02d7-4fbe-85bd-3d047593bf17|222', properties: [268442635, '22'] },
    ],
  });

  test('parseArgs rejects missing fields, identical text, and line breaks', () => {
    expect(() => setTextAction.parseArgs({ newText: 'x' })).toThrow(FrameBridgeValidationError);
    expect(() => setTextAction.parseArgs({ text: 'a' })).toThrow(FrameBridgeValidationError);
    expect(() => setTextAction.parseArgs({ text: 'a', newText: 'a' })).toThrow(FrameBridgeValidationError);
    expect(() => setTextAction.parseArgs({ text: 'a', newText: 'x\ny' })).toThrow(FrameBridgeValidationError);
    expect(setTextAction.parseArgs({ text: 'a', newText: '' })).toEqual({ text: 'a', newText: '' });
  });

  test('isApplied is keyed on the paragraph id — a decoy paragraph with the new text never confirms', () => {
    const args = setTextAction.parseArgs({ text: 'Testing', newText: 'Replaced' });
    const first = { target: resolveRunFormatTarget(model(), 'Testing'), block: null };
    // The decoy already says "Replaced", but the TARGET paragraph still says "Testing".
    expect(setTextAction.isApplied(model(), first, args)).toBe(false);
    expect(setTextAction.isApplied(model('Replaced'), first, args)).toBe(true);
  });

  test('a text replacement is declared non-idempotent — never blindly re-issued', () => {
    expect(setTextAction.idempotent).toBe(false);
  });
});

/**
 * A three-run bullet in a content placeholder, shaped like the captured
 * `PowerPointPasteGivenText` source: two blocks in the shape, the target block
 * carrying a list marker, and a paragraph whose segments all share one run.
 */
describe('block replacement for a multi-run paragraph', () => {
  const SHAPE = '3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829|249';
  const OLD_BODY = '81f0b7aa-fff5-406a-9364-7df4bca1210a|1';
  const OLD_BODY_REF = '{81f0b7aa-fff5-406a-9364-7df4bca1210a}{1}';
  const OTHER_BODY_REF = '{3f92ec9c-5c3a-4bd6-9cbe-50728ddf0829}{250}';
  const PARAGRAPH = '81f0b7aa-fff5-406a-9364-7df4bca1210a|2';
  const RUN_REF = '{f98c02a1-6978-46b5-ac4f-8626ca20ffe9}{33}';
  const MARKER = 'f98c02a1-6978-46b5-ac4f-8626ca20ffe9|40';
  const TEXT = 'A plan and an owner for the three gaps beyond the store list.';
  const OWNER = '4e1fa5cf-bde8-48ff-ae7f-df451eb506eb';
  const DESCRIPTOR = '{"ActionId":"1","ActionName":"PowerPointPasteGivenText","ActionTime":"1789652597603"}';

  const multiRunModel = (paragraphsInBlock = 1): PodsModel => ({
    totalObjects: 6,
    objects: [
      {
        classId: 393271,
        objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
        properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{s}{1}'],
      },
      {
        classId: 1074135132,
        objectId: SHAPE,
        properties: [469780826, 'Content Placeholder 1', 603986976, `${OTHER_BODY_REF},${OLD_BODY_REF}`],
      },
      {
        classId: 393229,
        objectId: OLD_BODY,
        properties: [
          335562753,
          '15',
          603986975,
          paragraphsInBlock === 1
            ? '{81f0b7aa-fff5-406a-9364-7df4bca1210a}{2}'
            : '{81f0b7aa-fff5-406a-9364-7df4bca1210a}{2},{81f0b7aa-fff5-406a-9364-7df4bca1210a}{3}',
          603986982,
          '{f98c02a1-6978-46b5-ac4f-8626ca20ffe9}{40}',
        ],
      },
      {
        classId: 393234,
        objectId: MARKER,
        properties: [134236456, 'true', 335551500, '3305961', 469769242, '8226', 469780482, 'old-owner'],
      },
      {
        classId: 393230,
        objectId: PARAGRAPH,
        cellId: '23069e19-9218-5ae4-9815-d8ceaade97df|3',
        properties: [
          335559683,
          '0',
          335562753,
          '15',
          335562805,
          '2147482957',
          335562806,
          '1153216370',
          469769250,
          TEXT,
          469769746,
          '20,40',
          469769819,
          '111',
          469780482,
          'old-owner',
          469780757,
          '{"Lines":[58,4]}',
          469780968,
          'Slide',
          536886591,
          '{f98c02a1-6978-46b5-ac4f-8626ca20ffe9}{16}',
          603987475,
          `${RUN_REF},${RUN_REF},${RUN_REF}`,
        ],
      },
      { classId: 1179725, objectId: 'f98c02a1-6978-46b5-ac4f-8626ca20ffe9|33', properties: [268442635, '28'] },
    ],
  });

  const objectsOfBody = (body: Record<string, unknown>): Obj[] => revisionOf(body).group.Objects;
  const props = (o: Obj | undefined): Map<number, string> => {
    const map = new Map<number, string>();
    for (let i = 0; o && i + 1 < o.Properties.length; i += 2) {
      map.set(Number(o.Properties[i]), String(o.Properties[i + 1]));
    }
    return map;
  };
  const build = (newText = 'Scratch replacement') => {
    const ctx = resolveSetTextContext(multiRunModel(), TEXT);
    if (!ctx.block) throw new Error('expected a block replacement');
    return buildReplaceBlockBody(ctx.target, ctx.block, newText, GUID, HEAD, OWNER, DESCRIPTOR, '1789652597609');
  };

  test('a multi-run paragraph resolves to a block replacement naming its block', () => {
    expect(resolveSetTextContext(multiRunModel(), TEXT).block?.blockRef).toBe(OLD_BODY_REF);
  });

  test('swaps the old block for the new one in place, leaving the other blocks where they were', () => {
    const shape = objectsOfBody(build()).find(o => o.ClassId === 1074135132);
    expect(props(shape).get(603986976)).toBe(`${OTHER_BODY_REF},{${GUID}}{3}`);
    expect(props(shape).get(469780826)).toBe('Content Placeholder 1');
  });

  test('the new paragraph carries the text in a single-run layout, as the editor writes it', () => {
    const paragraph = objectsOfBody(build()).find(o => o.ClassId === 393230);
    const p = props(paragraph);
    expect(paragraph?.ObjectId).toBe(`${GUID}|4`);
    expect(p.get(469769250)).toBe('Scratch replacement');
    expect(p.get(603987475)).toBe(RUN_REF);
    expect(p.has(469769746)).toBe(false);
    expect(p.get(469769819)).toBe('1');
    expect(p.get(469780757)).toBe('{"Lines":[20]}');
    expect(p.get(469780482)).toBe(OWNER);
    expect(p.get(536886591)).toBe('{f98c02a1-6978-46b5-ac4f-8626ca20ffe9}{16}');
  });

  test('the new text body owns the paragraph and a fresh copy of the list marker', () => {
    const objects = objectsOfBody(build());
    const body = props(objects.find(o => o.ClassId === 393229));
    expect(body.get(603986975)).toBe(`{${GUID}}{4}`);
    expect(body.get(603986982)).toBe(`{${GUID}}{5}`);
    expect(body.get(469780482)).toBe(OWNER);
    const marker = objects.find(o => o.ClassId === 393234);
    expect(marker?.ObjectId).toBe(`${GUID}|5`);
    expect(props(marker).get(469769242)).toBe('8226');
    expect(props(marker).get(469780482)).toBe(OWNER);
  });

  test('the old paragraph is not resubmitted, and the descriptor names Typing', () => {
    const objects = objectsOfBody(build());
    expect(objects.some(o => o.ObjectId === PARAGRAPH)).toBe(false);
    expect(props(objects.find(o => o.ClassId === 131140)).get(469780989)).toBe('Typing');
  });

  test('refuses when the block holds other paragraphs that a replacement would remove', () => {
    expect(() => resolveSetTextContext(multiRunModel(2), TEXT)).toThrow(/shares its text block/);
  });

  test('confirms only when the old block is gone and a new block carries the text', () => {
    const args = { text: TEXT, newText: 'Scratch replacement' };
    const first = resolveSetTextContext(multiRunModel(), TEXT);
    expect(setTextAction.isApplied(multiRunModel(), first, args)).toBe(false);

    const after = multiRunModel();
    const shape = after.objects.find(o => o.objectId === SHAPE);
    if (shape) shape.properties = [603986976, `${OTHER_BODY_REF},{aaaa}{1}`];
    after.objects.push(
      { classId: 393229, objectId: 'aaaa|1', properties: [603986975, '{aaaa}{2}'] },
      { classId: 393230, objectId: 'aaaa|2', properties: [469769250, 'Scratch replacement'] },
    );
    expect(setTextAction.isApplied(after, first, args)).toBe(true);
  });
});

describe('set_text on the slide, not a retired paragraph', () => {
  test('skips an unlisted paragraph carrying the same text, as a replaced block leaves behind', () => {
    const model: PodsModel = {
      totalObjects: 0,
      objects: [
        {
          classId: 393271,
          objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
          properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{0}{1}'],
        },
        // The retired paragraph comes first in the model and is listed by a body no shape lists.
        { classId: 393229, objectId: 'dead|1', properties: [603986975, '{dead}{2}'] },
        { classId: 393230, objectId: 'dead|2', properties: [469769250, 'Same', 603987475, '{c1}{1}'] },
        { classId: 1074135132, objectId: 'a1|1', properties: [603986976, '{b1}{1}'] },
        { classId: 393229, objectId: 'b1|1', properties: [603986975, '{d1}{2}'] },
        { classId: 393230, objectId: 'd1|2', properties: [469769250, 'Same', 603987475, '{c1}{1}'] },
        { classId: 1179725, objectId: 'c1|1', properties: [268442635, '22'] },
      ],
    };
    expect(resolveSetTextContext(model, 'Same').target.paragraphId).toBe('d1|2');
  });
});
