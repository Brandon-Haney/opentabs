import { describe, expect, test } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildSlideBackgroundBody, resolveSlideBackgroundContext, slideBackgroundAction } = await import(
  './pods-action-slide-background.js'
);
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { PodsModel } from './pods-model.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const ACTION_JSON = '{"ActionId":"1","ActionName":"FormatBackgroundSolidFill","ActionTime":"2"}';

const SLIDE_GUID = 'e1dbc311-2b4a-4f70-9d3e-1b2c3d4e5f60';
const REF_A = `{${SLIDE_GUID}}{61}`;
const REF_B = `{${SLIDE_GUID}}{62}`;
const SLIDE_A_ID = `${SLIDE_GUID}|61`;
const SLIDE_B_ID = `${SLIDE_GUID}|62`;
const THEME_BLOB = '{"majorFont":"Aptos Display","minorFont":"Aptos","accent1":"0F6CBD"}';

/**
 * Slide A already carries a background fill (orange, as in the editor capture);
 * slide B never had one set. Slide A's props are deliberately unsorted so the
 * build's ascending re-sort is observable.
 */
const model = (): PodsModel => ({
  totalObjects: 3,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, `${REF_A},${REF_B}`],
    },
    {
      classId: 393227,
      objectId: SLIDE_A_ID,
      cellId: `${SLIDE_GUID}|7`,
      properties: [
        603986976,
        `{${SLIDE_GUID}}{70}`,
        469780561,
        '#ED7D31,,,',
        469780621,
        '{"Alpha":100,"ColorLuminance":0,"FTintColor":false,"RGBColor":"ED7D31","ThemeColor":-1}',
        469780560,
        '',
        469780963,
        '{"noFillField":{},"shadeToTitleField":false}',
        469780520,
        THEME_BLOB,
      ],
    },
    {
      classId: 393227,
      objectId: SLIDE_B_ID,
      properties: [603986976, `{${SLIDE_GUID}}{80}`, 469780520, THEME_BLOB],
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
  const [action, slide] = group.Objects;
  if (!action || !slide) throw new Error('expected action and slide');
  return { discriminator: outer[0], inner, revision, group, action, slide, objectCount: group.Objects.length };
};
const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('resolveSlideBackgroundContext', () => {
  test('resolves the slide object, its own cell, and the colour before', () => {
    const ctx = resolveSlideBackgroundContext(model(), 1);
    expect(ctx.slideObjectId).toBe(SLIDE_A_ID);
    expect(ctx.slideRef).toBe(REF_A);
    expect(ctx.cellId).toBe(`${SLIDE_GUID}|7`);
    expect(ctx.colorBefore).toBe('#ED7D31,,,');
  });

  test('falls back to the root cell when the model carried no per-slide cell', () => {
    const ctx = resolveSlideBackgroundContext(model(), 2);
    expect(ctx.slideObjectId).toBe(SLIDE_B_ID);
    expect(ctx.cellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(ctx.colorBefore).toBeNull();
  });

  test('throws when the index is out of range', () => {
    expect(() => resolveSlideBackgroundContext(model(), 0)).toThrow(FrameBridgeValidationError);
    expect(() => resolveSlideBackgroundContext(model(), 3)).toThrow(FrameBridgeValidationError);
  });

  test('throws when the slide list names an object the model does not carry', () => {
    const broken = model();
    broken.objects = broken.objects.filter(o => o.objectId !== SLIDE_B_ID);
    expect(() => resolveSlideBackgroundContext(broken, 2)).toThrow(/no slide object/);
  });
});

describe('buildSlideBackgroundBody', () => {
  test('produces a type-3 revision naming the SLIDE object and its own cell', () => {
    const ctx = resolveSlideBackgroundContext(model(), 1);
    const body = buildSlideBackgroundBody(ctx, '4472C4', GUID, HEAD, ACTION_JSON);
    expect(body.Mode).toBe(4);
    const { discriminator, revision, action, slide, objectCount } = revisionOf(body);
    expect(discriminator).toBe(3);
    expect(objectCount).toBe(2);
    expect(revision.CellId).toBe(`${SLIDE_GUID}|7`);
    expect(revision.BaseId).toBe(HEAD);
    expect([action.ClassId, slide.ClassId]).toEqual([131140, 393227]);
    expect(slide.ObjectId).toBe(SLIDE_A_ID);
  });

  test('overrides the four fill properties and copies everything else verbatim — including the theme blob', () => {
    const ctx = resolveSlideBackgroundContext(model(), 1);
    const { slide } = revisionOf(buildSlideBackgroundBody(ctx, '4472C4', GUID, HEAD, ACTION_JSON));
    expect(propValue(slide.Properties, 469780561)).toBe('#4472C4,,,');
    expect(propValue(slide.Properties, 469780621)).toBe(
      '{"Alpha":100,"ColorLuminance":0,"FTintColor":false,"RGBColor":"4472C4","ThemeColor":-1}',
    );
    expect(propValue(slide.Properties, 469780560)).toBe('');
    expect(propValue(slide.Properties, 469780963)).toBe('{"noFillField":{},"shadeToTitleField":false}');
    expect(propValue(slide.Properties, 469780520)).toBe(THEME_BLOB);
    expect(propValue(slide.Properties, 603986976)).toBe(`{${SLIDE_GUID}}{70}`);
  });

  test('appends the fill properties on a slide whose background was never set, sorted ascending', () => {
    const ctx = resolveSlideBackgroundContext(model(), 2);
    const { slide } = revisionOf(buildSlideBackgroundBody(ctx, '00B050', GUID, HEAD, ACTION_JSON));
    expect(propValue(slide.Properties, 469780561)).toBe('#00B050,,,');
    expect(propValue(slide.Properties, 469780560)).toBe('');
    expect(propValue(slide.Properties, 469780963)).toBe('{"noFillField":{},"shadeToTitleField":false}');
    const ids: number[] = [];
    for (let i = 0; i < slide.Properties.length; i += 2) ids.push(Number(slide.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('the action descriptor names FormatBackgroundSolidFill', () => {
    const ctx = resolveSlideBackgroundContext(model(), 1);
    const { action } = revisionOf(buildSlideBackgroundBody(ctx, '4472C4', GUID, HEAD, ACTION_JSON));
    expect(propValue(action.Properties, 469780989)).toBe('FormatBackgroundSolidFill');
    expect(propValue(action.Properties, 469780658)).toBe(ACTION_JSON);
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
  });
});

describe('slideBackgroundAction spec', () => {
  test('parseArgs validates the index and normalizes the colour to uppercase', () => {
    expect(slideBackgroundAction.parseArgs({ slideIndex: 2, colorHex: '4472c4' })).toEqual({
      slideIndex: 2,
      colorHex: '4472C4',
    });
    expect(() => slideBackgroundAction.parseArgs({ slideIndex: 0, colorHex: '4472C4' })).toThrow(
      FrameBridgeValidationError,
    );
    expect(() => slideBackgroundAction.parseArgs({ slideIndex: 1, colorHex: '#4472C4' })).toThrow(
      FrameBridgeValidationError,
    );
    expect(() => slideBackgroundAction.parseArgs({ slideIndex: 1, colorHex: ' red ' })).toThrow(
      FrameBridgeValidationError,
    );
  });

  test('rebind re-locates the pinned slide at its NEW position after a concurrent edit', () => {
    if (!slideBackgroundAction.rebind) throw new Error('set_slide_background must rebind by reference');
    const args = { slideIndex: 2, colorHex: '4472C4' };
    const first = resolveSlideBackgroundContext(model(), 2);
    // A co-author deleted slide A: the pinned slide B is now at position 1.
    const shifted = model();
    const root = shifted.objects[0];
    if (!root) throw new Error('model must carry a root');
    root.properties = [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, REF_B];
    const rebound = slideBackgroundAction.rebind(shifted, first, args);
    expect(rebound.slideObjectId).toBe(SLIDE_B_ID);
    expect(rebound.slideIndex).toBe(1);
  });

  test('isApplied only when the pinned slide object carries the requested colour', () => {
    const args = { slideIndex: 1, colorHex: '4472C4' };
    const first = resolveSlideBackgroundContext(model(), 1);
    expect(slideBackgroundAction.isApplied(model(), first, args)).toBe(false);
    const applied = model();
    const slide = applied.objects.find(o => o.objectId === SLIDE_A_ID);
    if (!slide) throw new Error('model must carry slide A');
    slide.properties = slide.properties.map((v, i, arr) => (arr[i - 1] === 469780561 ? '#4472C4,,,' : v));
    expect(slideBackgroundAction.isApplied(applied, first, args)).toBe(true);
  });

  test('a background fill is declared idempotent — re-setting the same colour is a harmless overwrite', () => {
    expect(slideBackgroundAction.idempotent).toBe(true);
  });
});
