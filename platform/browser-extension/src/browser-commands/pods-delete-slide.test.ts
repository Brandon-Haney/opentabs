import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildDeleteSlideBody } = await import('./pods-delete-slide.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { DeleteSlideContext } from './pods-delete-slide.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const ACTION_JSON = '{"ActionId":"1","ActionName":"DeleteSlide","ActionTime":"2"}';

const REF_A = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58}';
const REF_B = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}';
const REF_C = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{60}';

const ctx = (): DeleteSlideContext => ({
  rootObjectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
  rootProperties: [
    335562809,
    '26.66',
    536889540,
    '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}',
    603986975,
    `${REF_A},${REF_B},${REF_C}`,
    469780797,
    '[]',
  ],
  slideList: `${REF_A},${REF_B},${REF_C}`,
  slideRefs: [REF_A, REF_B, REF_C],
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
    const body = buildDeleteSlideBody(ctx(), 2, GUID, HEAD, ACTION_JSON);
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
    const { root } = revisionOf(buildDeleteSlideBody(ctx(), 2, GUID, HEAD, ACTION_JSON));
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
    const { root } = revisionOf(buildDeleteSlideBody(ctx(), 2, GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 134236525)).toBe('true');
    const ids: number[] = [];
    for (let i = 0; i < root.Properties.length; i += 2) ids.push(Number(root.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('deleting the first slide leaves the remaining slides in order', () => {
    const { root } = revisionOf(buildDeleteSlideBody(ctx(), 1, GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe(`${REF_B},${REF_C}`);
  });

  test('deleting the last slide leaves the remaining slides in order', () => {
    const { root } = revisionOf(buildDeleteSlideBody(ctx(), 3, GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe(`${REF_A},${REF_B}`);
  });

  test('deleting the only slide yields an empty slide list', () => {
    const single: DeleteSlideContext = {
      rootObjectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      rootProperties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, REF_A],
      slideList: REF_A,
      slideRefs: [REF_A],
    };
    const { root } = revisionOf(buildDeleteSlideBody(single, 1, GUID, HEAD, ACTION_JSON));
    expect(propValue(root.Properties, 603986975)).toBe('');
  });

  test('the action descriptor names DeleteSlide', () => {
    const { action } = revisionOf(buildDeleteSlideBody(ctx(), 2, GUID, HEAD, ACTION_JSON));
    expect(action.ClassId).toBe(131140);
    expect(propValue(action.Properties, 469780989)).toBe('DeleteSlide');
    expect(propValue(action.Properties, 469780658)).toBe(ACTION_JSON);
  });

  test('the action-descriptor id derives from the root action-context reference', () => {
    const { action } = revisionOf(buildDeleteSlideBody(ctx(), 2, GUID, HEAD, ACTION_JSON));
    // root 536889540 = {b3ab583c…}{2} → action descriptor b3ab583c…|1
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
  });

  test('throws when the index is out of range', () => {
    expect(() => buildDeleteSlideBody(ctx(), 0, GUID, HEAD, ACTION_JSON)).toThrow(FrameBridgeValidationError);
    expect(() => buildDeleteSlideBody(ctx(), 4, GUID, HEAD, ACTION_JSON)).toThrow(FrameBridgeValidationError);
  });

  test('throws when the root has no action-context reference', () => {
    const bad = ctx();
    bad.rootProperties = [603986975, bad.slideList];
    expect(() => buildDeleteSlideBody(bad, 1, GUID, HEAD, ACTION_JSON)).toThrow(FrameBridgeValidationError);
  });
});
