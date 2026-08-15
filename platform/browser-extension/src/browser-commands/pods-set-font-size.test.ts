import { describe, expect, test } from 'vitest';

// Minimal Chrome stub so transitive module access at import time resolves.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildSetFontSizeBody } = await import('./pods-set-font-size.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { ResolvedTarget } from './pods-set-font-size.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';

/** A single-run "Workstream" paragraph resolved from the model, à la the live read. */
const target = (): ResolvedTarget => ({
  cellId: '23069e19-9218-5ae4-9815-d8ceaade97df|3',
  actionDescId: 'b3ab583c-77cd-428d-9371-02c2ea7c058b|1',
  paragraphId: '9182af9a-7890-4cb4-8497-a2086b1e730f|248',
  paragraphProperties: [
    469769250,
    'Workstream',
    603987475,
    '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}',
    335562753,
    '103',
  ],
  runRef: '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}',
  textRuns: [
    {
      ref: '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}',
      objectId: 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|7',
      properties: [134224900, 'false', 268442635, '22', 469780527, 'Aptos', 469780760, '@FFFFFF,0,'],
      sizeHalfPt: '22',
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
  const [action, paragraph, run] = group.Objects;
  if (!action || !paragraph || !run) throw new Error('expected an action, paragraph, and run object');
  return { discriminator: outer[0], inner, revision, group, action, paragraph, run };
};

const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};

describe('buildSetFontSizeBody', () => {
  test('builds the proven type-3 shape with identity tokens in every slot', () => {
    const body = buildSetFontSizeBody(target(), 36, GUID, HEAD);
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
    const { run } = revisionOf(buildSetFontSizeBody(target(), 36, GUID, HEAD));
    expect(run.ObjectId).toBe(`${GUID}|1`);
    expect(propValue(run.Properties, 268442635)).toBe('36');
    // Every other run property is carried through unchanged.
    expect(propValue(run.Properties, 469780527)).toBe('Aptos');
    expect(propValue(run.Properties, 469780760)).toBe('@FFFFFF,0,');
    expect(propValue(run.Properties, 134224900)).toBe('false');
  });

  test('the paragraph is resubmitted with its run-ref pointing at the new run', () => {
    const { paragraph } = revisionOf(buildSetFontSizeBody(target(), 36, GUID, HEAD));
    expect(paragraph.ObjectId).toBe('9182af9a-7890-4cb4-8497-a2086b1e730f|248');
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{${GUID}}{1}`);
    // Text and other paragraph properties are unchanged.
    expect(propValue(paragraph.Properties, 469769250)).toBe('Workstream');
    expect(propValue(paragraph.Properties, 335562753)).toBe('103');
  });

  test('run and paragraph properties are sorted ascending by id, matching the proven write', () => {
    const { paragraph, run } = revisionOf(buildSetFontSizeBody(target(), 36, GUID, HEAD));
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
    const { action } = revisionOf(buildSetFontSizeBody(target(), 36, GUID, HEAD));
    expect(action.ObjectId).toBe('b3ab583c-77cd-428d-9371-02c2ea7c058b|1');
    expect(propValue(action.Properties, 469780989)).toBe('SetFontSize');
  });

  test('a multi-run paragraph is rejected rather than mangled', () => {
    const multi = target();
    multi.textRuns.push({
      ref: '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{8}',
      objectId: 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|8',
      properties: [268442635, '22'],
      sizeHalfPt: '22',
    });
    expect(() => buildSetFontSizeBody(multi, 36, GUID, HEAD)).toThrow(FrameBridgeValidationError);
  });

  test('only the matched run reference is rewritten in a multi-part list', () => {
    const t = target();
    t.runRef = '{keep-a}{1},{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7},{keep-b}{2}';
    t.paragraphProperties = [469769250, 'Workstream', 603987475, t.runRef];
    // {keep-a}/{keep-b} are not resolved 1179725 runs, so textRuns stays length 1.
    const { paragraph } = revisionOf(buildSetFontSizeBody(t, 36, GUID, HEAD));
    expect(propValue(paragraph.Properties, 603987475)).toBe(`{keep-a}{1},{${GUID}}{1},{keep-b}{2}`);
  });
});
