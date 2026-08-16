import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildDeleteSlideBody, deleteSlideAction, resolveDeleteSlideContext } = await import(
  './pods-action-delete-slide.js'
);
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { DeleteSlideContext } from './pods-action-delete-slide.js';
import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const ACTION_JSON = '{"ActionId":"1","ActionName":"DeleteSlide","ActionTime":"2"}';

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

const ctx = (targetIndex: number): DeleteSlideContext => ({
  rootObjectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
  rootProperties: ROOT_PROPERTIES,
  slideRefs: [REF_A, REF_B, REF_C],
  targetRef: [REF_A, REF_B, REF_C][targetIndex - 1] as string,
  targetIndex,
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

describe('buildDeleteSlideBody', () => {
  test('produces a type-3 revision with exactly an action descriptor and the root — no slide object', () => {
    const body = buildDeleteSlideBody(ctx(2), GUID, HEAD, ACTION_JSON);
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

  test('removes only the target reference from the slide list and copies every other root prop verbatim', () => {
    const { root } = revisionOf(buildDeleteSlideBody(ctx(2), GUID, HEAD, ACTION_JSON));
    // Deleting position 2 (REF_B) leaves REF_A and REF_C in order.
    expect(propValue(root.Properties, 603986975)).toBe(`${REF_A},${REF_C}`);
    // Everything else is copied verbatim — this is what protects the surviving slides.
    expect(propValue(root.Properties, 335562809)).toBe('26.66');
    expect(propValue(root.Properties, 536889540)).toBe('{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}');
    expect(propValue(root.Properties, 469780797)).toBe('[]');
  });

  test('sets the root modified flag and sorts the root properties ascending, matching the editor', () => {
    // Decoded from a real DeleteSlide capture: the editor sets 134236525="true" and
    // writes the root properties sorted ascending; both are required to apply.
    const { root } = revisionOf(buildDeleteSlideBody(ctx(2), GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 134236525)).toBe('true');
    const ids: number[] = [];
    for (let i = 0; i < root.Properties.length; i += 2) ids.push(Number(root.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('deleting the first slide leaves the remaining slides in order', () => {
    const { root } = revisionOf(buildDeleteSlideBody(ctx(1), GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe(`${REF_B},${REF_C}`);
  });

  test('deleting the last slide leaves the remaining slides in order', () => {
    const { root } = revisionOf(buildDeleteSlideBody(ctx(3), GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe(`${REF_A},${REF_B}`);
  });

  test('deleting the only slide yields an empty slide list', () => {
    const single: DeleteSlideContext = {
      rootObjectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      rootProperties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, REF_A],
      slideRefs: [REF_A],
      targetRef: REF_A,
      targetIndex: 1,
    };
    const { root } = revisionOf(buildDeleteSlideBody(single, GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe('');
  });

  test('the action descriptor names DeleteSlide', () => {
    const { action } = revisionOf(buildDeleteSlideBody(ctx(2), GUID, HEAD, ACTION_JSON));
    expect(action.ClassId).toBe(131140);
    expect(propValue(action.Properties, 469780989)).toBe('DeleteSlide');
    expect(propValue(action.Properties, 469780658)).toBe(ACTION_JSON);
  });

  test('the action-descriptor id derives from the root action-context reference', () => {
    const { action } = revisionOf(buildDeleteSlideBody(ctx(2), GUID, HEAD, ACTION_JSON));
    // root 536889540 = {b3ab583c…}{2} → action descriptor b3ab583c…|1
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
  });

  test('throws on an inconsistent context, where the index does not name the target ref', () => {
    const inconsistent = { ...ctx(2), targetRef: REF_C };
    expect(() => buildDeleteSlideBody(inconsistent, GUID, HEAD, ACTION_JSON)).toThrow(FrameBridgeValidationError);
  });

  test('throws when the root has no action-context reference', () => {
    const bad = { ...ctx(1), rootProperties: [603986975, `${REF_A},${REF_B},${REF_C}`] as (string | number)[] };
    expect(() => buildDeleteSlideBody(bad, GUID, HEAD, ACTION_JSON)).toThrow(FrameBridgeValidationError);
  });
});

describe('deleteSlideAction spec', () => {
  test('resolve pins the target reference from its 1-based index', () => {
    const resolved = resolveDeleteSlideContext(model(), 2);
    expect(resolved.targetRef).toBe(REF_B);
    expect(resolved.targetIndex).toBe(2);
  });

  test('resolve throws when the index is out of range', () => {
    expect(() => resolveDeleteSlideContext(model(), 0)).toThrow(FrameBridgeValidationError);
    expect(() => resolveDeleteSlideContext(model(), 4)).toThrow(FrameBridgeValidationError);
  });

  test('rebind re-locates the pinned reference at its NEW position after a concurrent edit', () => {
    if (!deleteSlideAction.rebind) throw new Error('delete_slide must rebind by reference');
    const first = resolveDeleteSlideContext(model(), 2);
    // A co-author deleted REF_A: the pinned REF_B is now at position 1.
    const rebound = deleteSlideAction.rebind(model(`${REF_B},${REF_C}`), first, { slideIndex: 2 });
    expect(rebound.targetRef).toBe(REF_B);
    expect(rebound.targetIndex).toBe(1);
  });

  test('rebind throws when the pinned slide is gone — someone else already deleted it', () => {
    if (!deleteSlideAction.rebind) throw new Error('delete_slide must rebind by reference');
    const first = resolveDeleteSlideContext(model(), 2);
    expect(() => deleteSlideAction.rebind?.(model(`${REF_A},${REF_C}`), first, { slideIndex: 2 })).toThrow(
      /removed by someone else/,
    );
  });

  test('isApplied only when the pinned reference is gone from the live list', () => {
    const first = resolveDeleteSlideContext(model(), 2);
    expect(deleteSlideAction.isApplied(model(), first, { slideIndex: 2 })).toBe(false);
    expect(deleteSlideAction.isApplied(model(`${REF_A},${REF_C}`), first, { slideIndex: 2 })).toBe(true);
  });

  test('a delete is declared non-idempotent — an unconfirmed write must never be re-issued', () => {
    expect(deleteSlideAction.idempotent).toBe(false);
  });

  test('parseArgs rejects a non-positive or non-integer index', () => {
    expect(() => deleteSlideAction.parseArgs({ slideIndex: 0 })).toThrow(FrameBridgeValidationError);
    expect(() => deleteSlideAction.parseArgs({ slideIndex: 1.5 })).toThrow(FrameBridgeValidationError);
    expect(() => deleteSlideAction.parseArgs({})).toThrow(FrameBridgeValidationError);
  });
});
