import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { addSlideAction, buildAddSlideBody, resolveAddSlideContext } = await import('./pods-action-add-slide.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { AddSlideContext } from './pods-action-add-slide.js';
import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const ACTION_JSON = '{"ActionId":"1","ActionName":"NewSlideWithLayout","ActionTime":"2"}';

const ctx = (): AddSlideContext => ({
  rootObjectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
  rootProperties: [
    335562809,
    '26.66',
    536889540,
    '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}',
    603986975,
    '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58},{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}',
    469780797,
    '[]',
  ],
  slideList: '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58},{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}',
  slideRefs: ['{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58}', '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}'],
  master: '2147483648',
  layout: '2147483656',
});

/** The same context expressed as a live-model fixture, for resolve tests. */
const model = (): PodsModel => ({
  totalObjects: 3,
  objects: [
    { classId: 393271, objectId: ctx().rootObjectId, properties: ctx().rootProperties },
    {
      classId: 393227,
      objectId: 'd55934be-57c9-4c97-8e07-bf34a0bb3f76|58',
      properties: [335562835, '2147483648', 335562836, '2147483656'],
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
  const [action, root, slide] = group.Objects;
  if (!action || !root || !slide) throw new Error('expected action, root, slide');
  return { discriminator: outer[0], inner, revision, group, action, root, slide };
};
const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('buildAddSlideBody', () => {
  test('produces a type-3 revision with action, root, and new slide objects', () => {
    const body = buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222');
    expect(body.Mode).toBe(4);
    const { discriminator, inner, revision, group, action, root, slide } = revisionOf(body);
    expect(discriminator).toBe(3);
    expect(inner.ExpectedLatestId).toBe(HEAD);
    expect(revision.Id).toBe(`${GUID}|2`);
    expect(revision.BaseId).toBe(HEAD);
    expect(revision.CellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(group.Id).toBe(`${GUID}|3`);
    expect([action.ClassId, root.ClassId, slide.ClassId]).toEqual([131140, 393271, 393227]);
  });

  test('appends the new slide to the root slide list and leaves every other root prop unchanged', () => {
    const { root } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    // 603986975 gets the new slide ref appended.
    expect(propValue(root.Properties, 603986975)).toBe(
      `{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58},{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59},{${GUID}}{1}`,
    );
    // Everything else is copied verbatim — this is what protects the existing slides.
    expect(propValue(root.Properties, 335562809)).toBe('26.66');
    expect(propValue(root.Properties, 536889540)).toBe('{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}');
    expect(propValue(root.Properties, 469780797)).toBe('[]');
  });

  test('writes the root properties sorted ascending, matching the editor NewSlideWithLayout', () => {
    const { root } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    const ids: number[] = [];
    for (let i = 0; i < root.Properties.length; i += 2) ids.push(Number(root.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('does NOT set the root modified flag — the editor omits it on an add', () => {
    // Verified live: setting 134236525 on an add makes the server accept the
    // revision and silently drop it. The flag is delete-specific mimicry.
    const { root } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    expect(propValue(root.Properties, 134236525)).toBeUndefined();
  });

  test('the new slide object carries the templated master/layout ids and fresh creation ids', () => {
    const { slide } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    expect(slide.ObjectId).toBe(`${GUID}|1`);
    expect(propValue(slide.Properties, 335562835)).toBe('2147483648');
    expect(propValue(slide.Properties, 335562836)).toBe('2147483656');
    expect(propValue(slide.Properties, 335562805)).toBe('111');
    expect(propValue(slide.Properties, 335562806)).toBe('222');
  });

  test('the new slide is anchored to the deck last slide, so it appends in place', () => {
    // 536889506 is the slide the new one is inserted AFTER — verified against three
    // captured inserts, where it always equals the entry preceding the new slide.
    // It never appears in the read model, so it is derived from the live slide list.
    const { slide, root } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    expect(propValue(slide.Properties, 536889506)).toBe('{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}');
    // Consistency: the anchor is the entry immediately before the new ref in the list.
    const refs = String(propValue(root.Properties, 603986975)).split(',');
    expect(refs[refs.length - 2]).toBe(propValue(slide.Properties, 536889506));
    expect(refs[refs.length - 1]).toBe(`{${GUID}}{1}`);
  });

  test('a deck with no slides yet omits the anchor rather than emitting an empty one', () => {
    const empty = { ...ctx(), slideList: '', slideRefs: [] };
    const { slide } = revisionOf(buildAddSlideBody(empty, GUID, HEAD, ACTION_JSON, '111', '222'));
    expect(propValue(slide.Properties, 536889506)).toBeUndefined();
  });

  test('the action descriptor names NewSlideWithLayout', () => {
    const { action } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    expect(action.ClassId).toBe(131140);
    expect(propValue(action.Properties, 469780989)).toBe('NewSlideWithLayout');
    expect(propValue(action.Properties, 469780658)).toBe(ACTION_JSON);
  });

  test('the action-descriptor id derives from the root action-context reference', () => {
    const { action } = revisionOf(buildAddSlideBody(ctx(), GUID, HEAD, ACTION_JSON, '111', '222'));
    // root 536889540 = {b3ab583c…}{2} → action descriptor b3ab583c…|1
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
  });

  test('throws when the root has no action-context reference', () => {
    const bad = ctx();
    bad.rootProperties = [603986975, bad.slideList];
    expect(() => buildAddSlideBody(bad, GUID, HEAD, ACTION_JSON, '111', '222')).toThrow(FrameBridgeValidationError);
  });
});

describe('addSlideAction spec', () => {
  test('resolves the root and a template slide from a live-model fixture', () => {
    const resolved = resolveAddSlideContext(model());
    expect(resolved).toEqual(ctx());
  });

  test('throws when no slide carries master/layout ids to template from', () => {
    const bare: PodsModel = { totalObjects: 1, objects: [model().objects[0] as PodsModel['objects'][number]] };
    expect(() => resolveAddSlideContext(bare)).toThrow(FrameBridgeValidationError);
  });

  test('build derives creation ids and the action descriptor from the mint, deterministically', () => {
    const mint = { guidToken: GUID, headToken: HEAD, seed: 'a1b2c3d4-0000-0000-0000-000000000000', actionTime: '7' };
    const first = addSlideAction.build(ctx(), {}, mint);
    expect(addSlideAction.build(ctx(), {}, mint)).toEqual(first);
    const { action, slide } = revisionOf(first);
    expect(String(propValue(action.Properties, 469780658))).toContain('"ActionTime":"7"');
    expect(propValue(slide.Properties, 335562805)).toBeDefined();
  });

  const withSlideList = (slideList: string): PodsModel => {
    const changed = model();
    const root = changed.objects[0] as PodsModel['objects'][number];
    root.properties = [...root.properties];
    root.properties[root.properties.indexOf(603986975) + 1] = slideList;
    return changed;
  };

  test('isApplied only when the live slide list carries a reference the first resolve did not know', () => {
    const first = resolveAddSlideContext(model());
    expect(addSlideAction.isApplied(model(), first, {})).toBe(false);
    expect(addSlideAction.isApplied(withSlideList(`${ctx().slideList},{new}{1}`), first, {})).toBe(true);
  });

  test('isApplied survives a co-author deleting a slide in the confirmation window', () => {
    // Our add landed AND a co-author deleted a slide: the count is back to the
    // first-resolved count, but the new reference is present — a count comparison
    // would falsely report the add as dropped and invite a duplicate.
    const first = resolveAddSlideContext(model());
    const [keep] = ctx().slideRefs;
    expect(addSlideAction.isApplied(withSlideList(`${keep},{new}{1}`), first, {})).toBe(true);
  });

  test('an add is declared non-idempotent — an unconfirmed write must never be re-issued', () => {
    expect(addSlideAction.idempotent).toBe(false);
  });
});
