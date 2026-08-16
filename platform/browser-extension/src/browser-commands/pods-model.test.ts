import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { actionDescIdOf, cellIdOf, findPresentationRoot, guidOf, parseRefList, readProp, refToObjectId, slideRefsOf } =
  await import('./pods-model.js');
const { reduceOutline } = await import('./pods-action-read-outline.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { PodsModel } from './pods-model.js';

const ROOT = {
  classId: 393271,
  objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
  properties: [
    536889540,
    '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}',
    603986975,
    '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58},{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}',
  ] as (string | number)[],
};

describe('pods model helpers', () => {
  test('readProp finds a value in a flat pair list, or undefined', () => {
    expect(readProp([1, 'a', 2, 'b'], 2)).toBe('b');
    expect(readProp([1, 'a'], 9)).toBeUndefined();
  });

  test('parseRefList splits and trims, dropping empties', () => {
    expect(parseRefList('{a}{1}, {b}{2},,')).toEqual(['{a}{1}', '{b}{2}']);
    expect(parseRefList('')).toEqual([]);
  });

  test('refToObjectId converts a {guid}{ctr} token, or null for anything else', () => {
    expect(refToObjectId('{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}')).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|2');
    expect(refToObjectId('nonsense')).toBeNull();
  });

  test('guidOf takes the guid half of an object id', () => {
    expect(guidOf('abc|7')).toBe('abc');
    expect(guidOf('no-counter')).toBe('no-counter');
  });

  test('root derivations: cell id is |3 on the root guid, descriptor is |1 on the action-context guid', () => {
    const model: PodsModel = { totalObjects: 1, objects: [ROOT] };
    const root = findPresentationRoot(model);
    expect(cellIdOf(root)).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(actionDescIdOf(root)).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
    expect(slideRefsOf(root).slideRefs).toHaveLength(2);
  });

  test('missing root, slide list, or action context each fail with a named validation error', () => {
    expect(() => findPresentationRoot({ totalObjects: 0, objects: [] })).toThrow(FrameBridgeValidationError);
    const bare = { ...ROOT, properties: [] as (string | number)[] };
    expect(() => slideRefsOf(bare)).toThrow(FrameBridgeValidationError);
    expect(() => actionDescIdOf(bare)).toThrow(FrameBridgeValidationError);
  });
});

describe('reduceOutline', () => {
  const model = (): PodsModel => ({
    totalObjects: 42,
    objects: [
      ROOT,
      {
        classId: 393230,
        objectId: 'p|1',
        properties: [469769250, 'Fusion Pilot Timeline', 603987475, '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}'],
      },
      {
        classId: 1179725,
        objectId: 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|7',
        properties: [134224900, 'true', 268442635, '64', 469780527, 'Aptos', 469780760, '@FF0000,0,'],
      },
      { classId: 1074135132, objectId: 's|1', properties: [469780826, 'Title 1'] },
      { classId: 1074135132, objectId: 's|2', properties: [469780826, 'Content Placeholder 2'] },
    ],
  });

  test('reduces the model to slides, paragraphs with run formatting, and shape names', () => {
    const outline = reduceOutline(model());
    expect(outline.slideCount).toBe(2);
    expect(outline.paragraphTotal).toBe(1);
    expect(outline.paragraphs).toEqual([
      {
        text: 'Fusion Pilot Timeline',
        runs: [{ sizePt: 32, bold: true, italic: null, underline: null, colorHex: 'FF0000', font: 'Aptos' }],
      },
    ]);
    expect(outline.shapes).toEqual(['Title 1', 'Content Placeholder 2']);
    expect(outline.shapeTotal).toBe(2);
    expect(outline.totalObjects).toBe(42);
  });
});
