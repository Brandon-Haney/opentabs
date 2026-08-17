import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { alignTextAction, buildAlignTextBody, resolveAlignTextContext } = await import('./pods-action-align-text.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const ACTION_JSON = '{"ActionId":"1","ActionName":"CenterTextJustify","ActionTime":"2"}';

/**
 * Two paragraphs: one already carrying an explicit alignment pair (left), one
 * inheriting its alignment (no pair). The aligned paragraph's props are
 * deliberately unsorted so the build's ascending re-sort is observable.
 */
const model = (): PodsModel => ({
  totalObjects: 3,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, '{a}{1}'],
    },
    {
      classId: 393230,
      objectId: 'p|1',
      cellId: 'cell|7',
      properties: [
        603987475,
        '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}',
        469769250,
        'Workstream',
        335551550,
        '1',
        335551620,
        '1',
      ],
    },
    {
      classId: 393230,
      objectId: 'p|2',
      properties: [469769250, 'UAT', 603987475, '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{9}'],
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
  const revision = (outer[1].Revisions as Record<string, unknown>[])[0];
  if (!revision) throw new Error('missing revision');
  const group = (revision.ObjectGroups as { Id: string; Objects: Obj[] }[])[0];
  if (!group) throw new Error('missing group');
  const [action, paragraph] = group.Objects;
  if (!action || !paragraph) throw new Error('expected action and paragraph');
  return { discriminator: outer[0], revision, action, paragraph, objectCount: group.Objects.length };
};
const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('resolveAlignTextContext', () => {
  test('resolves the paragraph, its own cell, and the alignment before', () => {
    const ctx = resolveAlignTextContext(model(), 'Workstream');
    expect(ctx.paragraphId).toBe('p|1');
    expect(ctx.cellId).toBe('cell|7');
    expect(ctx.alignmentBefore).toBe('left');
  });

  test('an inherited-alignment paragraph reports null before, and falls back to the root cell', () => {
    const ctx = resolveAlignTextContext(model(), 'UAT');
    expect(ctx.alignmentBefore).toBeNull();
    expect(ctx.cellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
  });

  test('a text miss names nearby text', () => {
    expect(() => resolveAlignTextContext(model(), 'Workstreams')).toThrow(/"Workstream", "UAT"/);
  });
});

describe('buildAlignTextBody', () => {
  test('produces a type-3 revision with exactly the descriptor and the paragraph — no run object', () => {
    const ctx = resolveAlignTextContext(model(), 'Workstream');
    const body = buildAlignTextBody(ctx, 'center', GUID, HEAD, ACTION_JSON);
    const { discriminator, revision, action, paragraph, objectCount } = revisionOf(body);
    expect(discriminator).toBe(3);
    expect(objectCount).toBe(2);
    expect(revision.CellId).toBe('cell|7');
    expect(revision.BaseId).toBe(HEAD);
    expect([action.ClassId, paragraph.ClassId]).toEqual([131140, 393230]);
  });

  test('overrides BOTH alignment props and leaves the text and run-reference untouched', () => {
    const ctx = resolveAlignTextContext(model(), 'Workstream');
    const { paragraph } = revisionOf(buildAlignTextBody(ctx, 'center', GUID, HEAD, ACTION_JSON));
    expect(propValue(paragraph.Properties, 335551550)).toBe('2');
    expect(propValue(paragraph.Properties, 335551620)).toBe('2');
    expect(propValue(paragraph.Properties, 469769250)).toBe('Workstream');
    expect(propValue(paragraph.Properties, 603987475)).toBe('{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}');
  });

  test('appends the pair on an inherited-alignment paragraph, sorted ascending', () => {
    const ctx = resolveAlignTextContext(model(), 'UAT');
    const { paragraph } = revisionOf(buildAlignTextBody(ctx, 'right', GUID, HEAD, ACTION_JSON));
    expect(propValue(paragraph.Properties, 335551550)).toBe('3');
    expect(propValue(paragraph.Properties, 335551620)).toBe('3');
    const ids: number[] = [];
    for (let i = 0; i < paragraph.Properties.length; i += 2) ids.push(Number(paragraph.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('the action descriptor carries the alignment-specific editor action name', () => {
    const ctx = resolveAlignTextContext(model(), 'Workstream');
    const { action } = revisionOf(buildAlignTextBody(ctx, 'center', GUID, HEAD, ACTION_JSON));
    expect(propValue(action.Properties, 469780989)).toBe('CenterTextJustify');
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
  });
});

describe('alignTextAction spec', () => {
  test('parseArgs validates text and the alignment name', () => {
    expect(alignTextAction.parseArgs({ text: 'Workstream', alignment: 'center' })).toEqual({
      text: 'Workstream',
      alignment: 'center',
    });
    expect(() => alignTextAction.parseArgs({ text: '', alignment: 'center' })).toThrow(FrameBridgeValidationError);
    expect(() => alignTextAction.parseArgs({ text: 'Workstream', alignment: 'middle' })).toThrow(
      /left, center, right, justify/,
    );
  });

  test('isApplied only when the paragraph carries the requested code', () => {
    const args = { text: 'Workstream', alignment: 'center' as const };
    const first = resolveAlignTextContext(model(), 'Workstream');
    expect(alignTextAction.isApplied(model(), first, args)).toBe(false);
    const applied = model();
    const paragraph = applied.objects.find(o => o.objectId === 'p|1');
    if (!paragraph) throw new Error('model must carry p|1');
    paragraph.properties = paragraph.properties.map((v, i, arr) =>
      arr[i - 1] === 335551550 || arr[i - 1] === 335551620 ? '2' : v,
    );
    expect(alignTextAction.isApplied(applied, first, args)).toBe(true);
  });

  test('alignment is declared idempotent', () => {
    expect(alignTextAction.idempotent).toBe(true);
  });
});
