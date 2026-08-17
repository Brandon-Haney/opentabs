import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildSetTextBody, setTextAction } = await import('./pods-action-set-text.js');
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
  runRef: '{cfc16549-02d7-4fbe-85bd-3d047593bf17}{222}',
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

  test('a multi-run paragraph is rejected — a constructed run collapse crashes the live editor client', () => {
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
    const first = resolveRunFormatTarget(model(), 'Testing');
    // The decoy already says "Replaced", but the TARGET paragraph still says "Testing".
    expect(setTextAction.isApplied(model(), first, args)).toBe(false);
    expect(setTextAction.isApplied(model('Replaced'), first, args)).toBe(true);
  });

  test('a text replacement is declared non-idempotent — never blindly re-issued', () => {
    expect(setTextAction.idempotent).toBe(false);
  });
});
