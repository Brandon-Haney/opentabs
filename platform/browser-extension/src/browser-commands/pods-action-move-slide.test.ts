import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildMoveSlideBody, moveSlideAction, reorderSlideRefs, resolveMoveSlideContext } = await import(
  './pods-action-move-slide.js'
);
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { MoveSlideContext } from './pods-action-move-slide.js';
import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const ACTION_JSON = '{"ActionId":"1","ActionName":"MoveSlideById","ActionTime":"2"}';

const REF_A = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58}';
const REF_B = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}';
const REF_C = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{60}';

const ROOT_PROPERTIES: (string | number)[] = [
  335562809,
  '26.66',
  536889540,
  '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}',
  603986975,
  `${REF_A},${REF_B},${REF_C}`,
  469780797,
  '[]',
];

const ctx = (fromIndex: number, toIndex: number): MoveSlideContext => ({
  rootObjectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
  rootProperties: ROOT_PROPERTIES,
  slideRefs: [REF_A, REF_B, REF_C],
  targetRef: [REF_A, REF_B, REF_C][fromIndex - 1] as string,
  fromIndex,
  toIndex,
});

const model = (slideList = `${REF_A},${REF_B},${REF_C}`): PodsModel => ({
  totalObjects: 1,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [
        335562809,
        '26.66',
        536889540,
        '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}',
        603986975,
        slideList,
        469780797,
        '[]',
      ],
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
  const [action, root] = group.Objects;
  if (!action || !root) throw new Error('expected action and root');
  return { discriminator: outer[0], inner, revision, group, action, root, objectCount: group.Objects.length };
};
const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('reorderSlideRefs', () => {
  test('moves forward: the slide lands at the 1-based destination', () => {
    expect(reorderSlideRefs([REF_A, REF_B, REF_C], 1, 3)).toEqual([REF_B, REF_C, REF_A]);
  });

  test('moves backward: the slide lands at the 1-based destination', () => {
    expect(reorderSlideRefs([REF_A, REF_B, REF_C], 3, 1)).toEqual([REF_C, REF_A, REF_B]);
  });

  test('adjacent swap', () => {
    expect(reorderSlideRefs([REF_A, REF_B, REF_C], 2, 3)).toEqual([REF_A, REF_C, REF_B]);
  });
});

describe('buildMoveSlideBody', () => {
  test('produces a type-3 revision with exactly an action descriptor and the root — no slide object', () => {
    const body = buildMoveSlideBody(ctx(1, 3), GUID, HEAD, ACTION_JSON);
    expect(body.Mode).toBe(4);
    const { discriminator, inner, revision, group, action, root, objectCount } = revisionOf(body);
    expect(discriminator).toBe(3);
    expect(objectCount).toBe(2);
    expect(inner.ExpectedLatestId).toBe(HEAD);
    expect(revision.Id).toBe(`${GUID}|2`);
    expect(revision.BaseId).toBe(HEAD);
    expect(revision.CellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(group.Id).toBe(`${GUID}|3`);
    expect([action.ClassId, root.ClassId]).toEqual([131140, 393271]);
  });

  test('reorders only the slide list and copies every other root prop verbatim', () => {
    const { root } = revisionOf(buildMoveSlideBody(ctx(1, 3), GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe(`${REF_B},${REF_C},${REF_A}`);
    expect(propValue(root.Properties, 335562809)).toBe('26.66');
    expect(propValue(root.Properties, 536889540)).toBe('{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}');
    expect(propValue(root.Properties, 469780797)).toBe('[]');
  });

  test('does NOT set the root modified flag — the editor omits it on move, and sorts properties ascending', () => {
    // Captured from the editor's own MoveSlideById: no 134236525, unlike delete.
    const { root } = revisionOf(buildMoveSlideBody(ctx(1, 3), GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 134236525)).toBeUndefined();
    const ids: number[] = [];
    for (let i = 0; i < root.Properties.length; i += 2) ids.push(Number(root.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('the action descriptor names MoveSlideById', () => {
    const { action } = revisionOf(buildMoveSlideBody(ctx(3, 1), GUID, HEAD, ACTION_JSON));
    expect(action.ClassId).toBe(131140);
    expect(propValue(action.Properties, 469780989)).toBe('MoveSlideById');
    expect(propValue(action.Properties, 469780658)).toBe(ACTION_JSON);
    // root 536889540 = {b3ab583c…}{2} → action descriptor b3ab583c…|1
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
  });

  test('throws on an inconsistent context, where fromIndex does not name the target ref', () => {
    const inconsistent = { ...ctx(1, 3), targetRef: REF_C };
    expect(() => buildMoveSlideBody(inconsistent, GUID, HEAD, ACTION_JSON)).toThrow(FrameBridgeValidationError);
  });
});

describe('moveSlideAction spec', () => {
  test('resolve pins the moving reference from its 1-based index', () => {
    const resolved = resolveMoveSlideContext(model(), { fromIndex: 2, toIndex: 1 });
    expect(resolved.targetRef).toBe(REF_B);
    expect(resolved.fromIndex).toBe(2);
    expect(resolved.toIndex).toBe(1);
  });

  test('resolve throws when either index is out of range', () => {
    expect(() => resolveMoveSlideContext(model(), { fromIndex: 0, toIndex: 2 })).toThrow(FrameBridgeValidationError);
    expect(() => resolveMoveSlideContext(model(), { fromIndex: 1, toIndex: 4 })).toThrow(FrameBridgeValidationError);
  });

  test('parseArgs rejects a same-position move and non-positive indices', () => {
    expect(() => moveSlideAction.parseArgs({ fromIndex: 2, toIndex: 2 })).toThrow(/already there/);
    expect(() => moveSlideAction.parseArgs({ fromIndex: 0, toIndex: 1 })).toThrow(FrameBridgeValidationError);
    expect(() => moveSlideAction.parseArgs({ fromIndex: 1 })).toThrow(FrameBridgeValidationError);
  });

  test('rebind re-locates the pinned reference at its NEW position after a concurrent edit', () => {
    if (!moveSlideAction.rebind) throw new Error('move_slide must rebind by reference');
    const args = { fromIndex: 3, toIndex: 1 };
    const first = resolveMoveSlideContext(model(), args);
    // A co-author deleted REF_A: the pinned REF_C is now at position 2.
    const rebound = moveSlideAction.rebind(model(`${REF_B},${REF_C}`), first, args);
    expect(rebound.targetRef).toBe(REF_C);
    expect(rebound.fromIndex).toBe(2);
    expect(rebound.toIndex).toBe(1);
  });

  test('rebind throws when the pinned slide is gone — someone else already deleted it', () => {
    if (!moveSlideAction.rebind) throw new Error('move_slide must rebind by reference');
    const args = { fromIndex: 2, toIndex: 3 };
    const first = resolveMoveSlideContext(model(), args);
    expect(() => moveSlideAction.rebind?.(model(`${REF_A},${REF_C}`), first, args)).toThrow(/removed by someone else/);
  });

  test('rebind throws when the destination is out of range in the shrunk deck', () => {
    if (!moveSlideAction.rebind) throw new Error('move_slide must rebind by reference');
    const args = { fromIndex: 2, toIndex: 3 };
    const first = resolveMoveSlideContext(model(), args);
    expect(() => moveSlideAction.rebind?.(model(`${REF_A},${REF_B}`), first, args)).toThrow(/out of range now/);
  });

  test('isApplied only when the pinned reference sits at the destination', () => {
    const args = { fromIndex: 1, toIndex: 3 };
    const first = resolveMoveSlideContext(model(), args);
    expect(moveSlideAction.isApplied(model(), first, args)).toBe(false);
    expect(moveSlideAction.isApplied(model(`${REF_B},${REF_C},${REF_A}`), first, args)).toBe(true);
  });

  test('a move is declared idempotent — re-issuing rebuilds from the fresh model and lands as a no-op', () => {
    expect(moveSlideAction.idempotent).toBe(true);
  });
});
