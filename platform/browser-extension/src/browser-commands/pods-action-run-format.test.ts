import { describe, expect, test } from 'vitest';

// Minimal Chrome stub so transitive module access at import time resolves.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildRunFormatBody, formatTextAction, resolveRunFormatTarget, setFontSizeAction } = await import(
  './pods-action-run-format.js'
);
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { ResolvedTarget } from './pods-action-run-format.js';
import type { PodsMint } from './pods-actions.js';
import type { PodsModel } from './pods-model.js';
import type { TextRange } from './pods-text-runs.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';
const mint: PodsMint = {
  guidToken: GUID,
  headToken: HEAD,
  seed: 'a1b2c3d4-0000-0000-0000-000000000000',
  actionTime: '2',
};

const RUN_REF = '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}';
const RUN_ID = 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|7';
const RUN_PROPS: (string | number)[] = [
  134224900,
  'false',
  268442635,
  '22',
  469780527,
  'Aptos',
  469780760,
  '@FFFFFF,0,',
];
const TEXT = 'Workstream';

/** A single-run "Workstream" paragraph resolved from the model, à la the live read. */
const target = (): ResolvedTarget => ({
  cellId: '23069e19-9218-5ae4-9815-d8ceaade97df|3',
  actionDescId: 'b3ab583c-77cd-428d-9371-02c2ea7c058b|1',
  paragraphId: '9182af9a-7890-4cb4-8497-a2086b1e730f|248',
  paragraphProperties: [469769250, TEXT, 603987475, RUN_REF, 335562753, '103'],
  text: TEXT,
  runRef: RUN_REF,
  segments: [{ start: 0, end: TEXT.length, ref: RUN_REF }],
  runsByRef: new Map([[RUN_REF, { classId: 1179725, objectId: RUN_ID, properties: RUN_PROPS }]]),
  textRuns: [
    {
      ref: RUN_REF,
      objectId: RUN_ID,
      properties: RUN_PROPS,
      sizeHalfPt: '22',
      bold: 'false',
      italic: null,
    },
  ],
});

/** The range covering a whole paragraph — what `format_text` uses when no `match` is given. */
const whole = (t: ResolvedTarget): TextRange => ({ start: 0, end: t.text.length });

/** Build against a range, defaulting to the whole paragraph. */
const build = (
  t: ResolvedTarget,
  changes: Parameters<typeof buildRunFormatBody>[1],
  range?: TextRange,
): Record<string, unknown> => buildRunFormatBody(t, changes, range ?? whole(t), GUID, HEAD);

/** The same target expressed as a live-model fixture, for resolve tests. */
const model = (): PodsModel => ({
  totalObjects: 5,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [
        536889540,
        '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}',
        603986975,
        '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58}',
      ],
    },
    {
      classId: 393230,
      objectId: '9182af9a-7890-4cb4-8497-a2086b1e730f|248',
      properties: [469769250, 'Workstream', 603987475, '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}', 335562753, '103'],
    },
    {
      classId: 1179725,
      objectId: 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|7',
      properties: [134224900, 'false', 268442635, '22', 469780527, 'Aptos', 469780760, '@FFFFFF,0,'],
    },
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}

/** Reach into the built body's single revision, guarding every index access. */
const revisionOf = (body: Record<string, unknown>) => {
  const srs = body.srs as [number, Record<string, unknown>][];
  const outer = srs[0];
  if (!outer) throw new Error('missing srs entry');
  const inner = outer[1];
  const revision = (inner.Revisions as Record<string, unknown>[])[0];
  if (!revision) throw new Error('missing revision');
  const group = (revision.ObjectGroups as { Id: string; Objects: Obj[] }[])[0];
  if (!group) throw new Error('missing object group');
  const [action, paragraph, run, ...moreRuns] = group.Objects;
  if (!action || !paragraph || !run) throw new Error('expected an action, paragraph, and run object');
  // A range spanning differently formatted stretches mints one run per stretch, so
  // `runs` is the full list and `run` stays the first for the single-run tests.
  return { discriminator: outer[0], inner, revision, group, action, paragraph, run, runs: [run, ...moreRuns] };
};

const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('buildRunFormatBody (size change)', () => {
  test('builds the proven type-3 shape with identity tokens in every slot', () => {
    const body = build(target(), { sizeHalfPt: 36 });
    expect(body.Mode).toBe(4);

    const { discriminator, inner, revision, group, action, paragraph, run } = revisionOf(body);
    expect(discriminator).toBe(3);
    expect(inner.ExpectedLatestId).toBe(HEAD);
    expect(inner.PutOnlyCall).toBe(false);
    expect(revision.Id).toBe(`${GUID}|2`);
    expect(revision.BaseId).toBe(HEAD);
    expect(revision.CellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(revision.ContextId).toBe('00000000-0000-0000-0000-000000000000|0');
    expect(revision.ExpectedLatestId).toBe('00000000-0000-0000-0000-000000000000|0');
    expect(group.Id).toBe(`${GUID}|3`);
    expect([action.ClassId, paragraph.ClassId, run.ClassId]).toEqual([131140, 393230, 1179725]);
  });

  test('the new run copies props verbatim but with the new size', () => {
    const { run } = revisionOf(build(target(), { sizeHalfPt: 36 }));
    expect(run.ObjectId).toBe(`${GUID}|4`);
    expect(propValue(run.Properties, 268442635)).toBe('36');
    // Every other run property is carried through unchanged.
    expect(propValue(run.Properties, 469780527)).toBe('Aptos');
    expect(propValue(run.Properties, 469780760)).toBe('@FFFFFF,0,');
    expect(propValue(run.Properties, 134224900)).toBe('false');
  });

  test('the paragraph is resubmitted with its run-ref pointing at the new run', () => {
    const { paragraph } = revisionOf(build(target(), { sizeHalfPt: 36 }));
    expect(paragraph.ObjectId).toBe('9182af9a-7890-4cb4-8497-a2086b1e730f|248');
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{4}`);
    // Text and other paragraph properties are unchanged.
    expect(propValue(paragraph.Properties, 469769250)).toBe('Workstream');
    expect(propValue(paragraph.Properties, 335562753)).toBe('103');
  });

  test('run and paragraph properties are sorted ascending by id, matching the proven write', () => {
    const { paragraph, run } = revisionOf(build(target(), { sizeHalfPt: 36 }));
    const ids = (properties: (string | number)[]): number[] => {
      const out: number[] = [];
      for (let i = 0; i < properties.length; i += 2) out.push(Number(properties[i]));
      return out;
    };
    const runIds = ids(run.Properties);
    const paraIds = ids(paragraph.Properties);
    expect(runIds).toEqual([...runIds].sort((a, b) => a - b));
    expect(paraIds).toEqual([...paraIds].sort((a, b) => a - b));
  });

  test('the action descriptor names SetFontSize', () => {
    const { action } = revisionOf(build(target(), { sizeHalfPt: 36 }));
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
    expect(propValue(action.Properties, 469780989)).toBe('SetFontSize');
  });

  test('a paragraph that already has two runs formats both, each keeping its own base', () => {
    // "Work" in Aptos, "stream" in Georgia; a whole-paragraph size change must not
    // flatten the two fonts into one.
    const t = target();
    const secondRef = '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{8}';
    t.segments = [
      { start: 0, end: 4, ref: RUN_REF },
      { start: 4, end: TEXT.length, ref: secondRef },
    ];
    t.runsByRef.set(secondRef, {
      classId: 1179725,
      objectId: 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|8',
      properties: [268442635, '22', 469780527, 'Georgia'],
    });
    t.paragraphProperties = [469769250, TEXT, 603987475, `${RUN_REF},${secondRef}`, 469769746, '4'];

    const { paragraph, runs } = revisionOf(build(t, { sizeHalfPt: 36 }));
    expect(runs).toHaveLength(2);
    expect(runs.map(r => r.ObjectId)).toEqual([`${GUID}|4`, `${GUID}|5`]);
    expect(runs.map(r => propValue(r.Properties, 268442635))).toEqual(['36', '36']);
    expect(runs.map(r => propValue(r.Properties, 469780527))).toEqual(['Aptos', 'Georgia']);
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{4},{${GUID}}{5}`);
    expect(propValue(paragraph.Properties, 469769746)).toBe('4');
  });

  test('references outside the formatted range are preserved verbatim, resolvable or not', () => {
    const t = target();
    t.segments = [
      { start: 0, end: 4, ref: '{keep-a}{1}' },
      { start: 4, end: 8, ref: RUN_REF },
      { start: 8, end: TEXT.length, ref: '{keep-b}{2}' },
    ];
    t.paragraphProperties = [469769250, TEXT, 603987475, `{keep-a}{1},${RUN_REF},{keep-b}{2}`, 469769746, '4,8'];

    const { paragraph } = revisionOf(build(t, { sizeHalfPt: 36 }, { start: 4, end: 8 }));
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{keep-a}{1},{${GUID}}{4},{keep-b}{2}`);
    expect(propValue(paragraph.Properties, 469769746)).toBe('4,8');
  });
});

describe('buildRunFormatBody (a range within the paragraph)', () => {
  // The shape decoded from the editor's own range-bold of the word "Timeline" in
  // " Fusion Pilot Timeline: Key Milestones": boundaries "14,22", and the head and
  // tail segments both still pointing at the ORIGINAL run object.
  test('splits a single-run paragraph into head, formatted range, and tail', () => {
    const { paragraph, runs } = revisionOf(build(target(), { bold: true }, { start: 4, end: 6 }));
    expect(propValue(paragraph.Properties, 603987475)).toBe(`${RUN_REF},{${GUID}}{4},${RUN_REF}`);
    expect(propValue(paragraph.Properties, 469769746)).toBe('4,6');
    expect(runs).toHaveLength(1);
    expect(propValue(runs[0]?.Properties ?? [], 134224900)).toBe('true');
    // The untouched stretches keep the original run, so nothing else changes.
    expect(propValue(runs[0]?.Properties ?? [], 469780527)).toBe('Aptos');
  });

  test('a range at the start writes no leading segment', () => {
    const { paragraph } = revisionOf(build(target(), { bold: true }, { start: 0, end: 4 }));
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{4},${RUN_REF}`);
    expect(propValue(paragraph.Properties, 469769746)).toBe('4');
  });

  test('a range covering the whole paragraph writes no boundaries at all', () => {
    const { paragraph } = revisionOf(build(target(), { bold: true }));
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{4}`);
    expect(propValue(paragraph.Properties, 469769746)).toBeUndefined();
  });

  test('formatting back to a single run drops the boundaries the paragraph carried', () => {
    const t = target();
    t.segments = [
      { start: 0, end: 4, ref: RUN_REF },
      { start: 4, end: TEXT.length, ref: RUN_REF },
    ];
    t.paragraphProperties = [469769250, TEXT, 603987475, `${RUN_REF},${RUN_REF}`, 469769746, '4'];
    const { paragraph } = revisionOf(build(t, { bold: true }));
    // Both stretches take the same new run, so the boundary between them is gone.
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{4}`);
    expect(propValue(paragraph.Properties, 469769746)).toBeUndefined();
  });

  test('an empty range is refused rather than writing a no-op revision', () => {
    expect(() => build(target(), { bold: true }, { start: 3, end: 3 })).toThrow(FrameBridgeValidationError);
  });
});

describe('buildRunFormatBody', () => {
  test('overrides bold on a run that already carries a bold property', () => {
    // The fixture run has bold=false (134224900). Turning it on overrides in place.
    const { run } = revisionOf(build(target(), { bold: true }));
    expect(propValue(run.Properties, 134224900)).toBe('true');
    // Size and other properties are untouched.
    expect(propValue(run.Properties, 268442635)).toBe('22');
    expect(propValue(run.Properties, 469780527)).toBe('Aptos');
  });

  test('appends italic on a run that had no italic property', () => {
    // The fixture run has no italic (134224901). Turning it on appends it.
    const { run } = revisionOf(build(target(), { italic: true }));
    expect(propValue(run.Properties, 134224901)).toBe('true');
  });

  test('applies size, bold, and italic together in one revision', () => {
    const { run } = revisionOf(build(target(), { sizeHalfPt: 48, bold: true, italic: false }));
    expect(propValue(run.Properties, 268442635)).toBe('48');
    expect(propValue(run.Properties, 134224900)).toBe('true');
    expect(propValue(run.Properties, 134224901)).toBe('false');
  });

  test('keeps the properties sorted ascending by id even after appending', () => {
    const { run } = revisionOf(build(target(), { italic: true }));
    const ids: number[] = [];
    for (let i = 0; i < run.Properties.length; i += 2) ids.push(Number(run.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('sets font color as both the display string and its BGR-integer mirror', () => {
    // Red FF0000 → "@FF0000,," and BGR int 255 (matches the captured SetFontColor write).
    const { run } = revisionOf(build(target(), { colorHex: 'FF0000' }));
    expect(propValue(run.Properties, 469780760)).toBe('@FF0000,,');
    expect(propValue(run.Properties, 335551500)).toBe('255');
  });

  test('BGR mirror packs blue and green into the high bytes', () => {
    // 00FF80 → r=0,g=255,b=128 → (128<<16)|(255<<8)|0 = 8454144+65280 = 8519424
    const { run } = revisionOf(build(target(), { colorHex: '00FF80' }));
    expect(propValue(run.Properties, 335551500)).toBe(String((128 << 16) | (255 << 8) | 0));
  });

  test('writes the font family to all four typeface slots', () => {
    const { run } = revisionOf(build(target(), { font: 'Georgia' }));
    for (const face of [469769226, 469780527, 469780528, 469780529]) {
      expect(propValue(run.Properties, face)).toBe('Georgia');
    }
  });

  test('sets underline as a true/false flag', () => {
    const { run } = revisionOf(build(target(), { underline: true }));
    expect(propValue(run.Properties, 134224902)).toBe('true');
  });

  test('rejects an empty change set', () => {
    expect(() => build(target(), {})).toThrow(FrameBridgeValidationError);
  });
});

describe('resolveRunFormatTarget', () => {
  test('resolves the paragraph and its run from a live-model fixture', () => {
    const resolved = resolveRunFormatTarget(model(), 'Workstream');
    expect(resolved.cellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
    expect(resolved.actionDescId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
    expect(resolved.paragraphId).toBe('9182af9a-7890-4cb4-8497-a2086b1e730f|248');
    expect(resolved.textRuns).toHaveLength(1);
    expect(resolved.textRuns[0]?.sizeHalfPt).toBe('22');
  });

  test('an unmatched text errors with nearby-text samples', () => {
    expect(() => resolveRunFormatTarget(model(), 'Not There')).toThrow(/Workstream/);
  });

  test('the target cell is the PARAGRAPH own cell when the model carries one — cells are per slide', () => {
    const perCell = model();
    const paragraph = perCell.objects.find(o => o.classId === 393230);
    if (!paragraph) throw new Error('fixture paragraph missing');
    paragraph.cellId = 'fc911c25-6600-4b0b-83e0-9cb6749138d4|3';
    expect(resolveRunFormatTarget(perCell, 'Workstream').cellId).toBe('fc911c25-6600-4b0b-83e0-9cb6749138d4|3');
    // Without a per-object cell, the root-derived cell remains the fallback.
    expect(resolveRunFormatTarget(model(), 'Workstream').cellId).toBe('23069e19-9218-5ae4-9815-d8ceaade97df|3');
  });
});

describe('action specs', () => {
  test('set_font_size is the size-only special case of format_text', () => {
    const sizeArgs = setFontSizeAction.parseArgs({ text: 'Workstream', sizePt: 24 });
    const formatArgs = formatTextAction.parseArgs({ text: 'Workstream', sizePt: 24 });
    expect(setFontSizeAction.build(target(), sizeArgs, mint)).toEqual(
      formatTextAction.build(target(), formatArgs, mint),
    );
  });

  test('format_text parseArgs is an allow-list: unknown fields do not survive', () => {
    const args = formatTextAction.parseArgs({ text: 'Workstream', bold: true, evil: 'x' });
    expect(args).toEqual({ text: 'Workstream', changes: { bold: true }, requested: { bold: true } });
  });

  test('format_text parseArgs rejects an empty change set and set_font_size a bad size', () => {
    expect(() => formatTextAction.parseArgs({ text: 'Workstream' })).toThrow(FrameBridgeValidationError);
    expect(() => setFontSizeAction.parseArgs({ text: 'Workstream', sizePt: 0 })).toThrow(FrameBridgeValidationError);
  });

  test('isApplied is true only when the run reflects every requested change', () => {
    const args = formatTextAction.parseArgs({ text: 'Workstream', sizePt: 11 });
    const first = resolveRunFormatTarget(model(), 'Workstream');
    // The fixture run is already 22 half-points (11pt), so a size-11 request reads as applied.
    expect(formatTextAction.isApplied(model(), first, args)).toBe(true);
    const bolder = formatTextAction.parseArgs({ text: 'Workstream', bold: true });
    expect(formatTextAction.isApplied(model(), first, bolder)).toBe(false);
  });
});
