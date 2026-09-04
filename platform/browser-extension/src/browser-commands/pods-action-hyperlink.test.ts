import { describe, expect, test } from 'vitest';

// Minimal Chrome stub so transitive module access at import time resolves.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildHyperlinkBody, buildRemoveHyperlinkBody, containsFieldCode, hyperlinkFieldCode, setHyperlinkAction } =
  await import('./pods-action-hyperlink.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

import type { ResolvedTarget } from './pods-action-run-format.js';

const GUID = '__OTB_PODS_GUID__';
const HEAD = '__OTB_PODS_HEAD__';

/**
 * The exact paragraph the editor's own Insert Link was captured on: the deck title,
 * one run, with "Milestones" the last word.
 */
const TITLE = ' Fusion Pilot Timeline: Key Milestones';
const RUN_REF = '{4efeeb47-de77-4081-a870-b0e9ad47aabf}{58}';
const RUN_PROPS: (string | number)[] = [134224900, 'true', 268442635, '48', 469780527, 'Arial', 469780760, '@001489,,'];
const URL = 'https://example.com/sop';

const target = (): ResolvedTarget => ({
  cellId: '23069e19-9218-5ae4-9815-d8ceaade97df|3',
  actionDescId: 'b3ab583c-77cd-428d-9371-02c2ea7c058b|1',
  paragraphId: '9d6d4a29-58d3-4c6f-bdb7-70296063d69b|89',
  paragraphProperties: [469769250, TITLE, 603987475, RUN_REF, 335562753, '58'],
  text: TITLE,
  runRef: RUN_REF,
  segments: [{ start: 0, end: TITLE.length, ref: RUN_REF }],
  runsByRef: new Map([
    [RUN_REF, { classId: 1179725, objectId: '4efeeb47-de77-4081-a870-b0e9ad47aabf|58', properties: RUN_PROPS }],
  ]),
  textRuns: [
    {
      ref: RUN_REF,
      objectId: '4efeeb47-de77-4081-a870-b0e9ad47aabf|58',
      properties: RUN_PROPS,
      sizeHalfPt: '48',
      bold: 'true',
      italic: null,
    },
  ],
});

interface Obj {
  ObjectId: string;
  ClassId: number;
  Properties: (string | number)[];
}
const objectsOf = (body: Record<string, unknown>): Obj[] => {
  const srs = body.srs as [number, Record<string, unknown>][];
  const inner = srs[0]?.[1];
  if (!inner) throw new Error('missing srs entry');
  const revision = (inner.Revisions as Record<string, unknown>[])[0];
  if (!revision) throw new Error('missing revision');
  const group = (revision.ObjectGroups as { Objects: Obj[] }[])[0];
  if (!group) throw new Error('missing object group');
  return group.Objects;
};
const propValue = (properties: (string | number)[], id: number): string | number | undefined => {
  for (let i = 0; i + 1 < properties.length; i += 2) if (properties[i] === id) return properties[i + 1];
  return undefined;
};
/** The range of a word within the title, the way `rangeOf` resolves a `match`. */
const rangeOfWord = (word: string) => ({ start: TITLE.indexOf(word), end: TITLE.indexOf(word) + word.length });

describe('hyperlinkFieldCode', () => {
  test('is the Word field code the editor splices into the text', () => {
    expect(hyperlinkFieldCode(URL)).toBe(`﷟HYPERLINK "${URL}"`);
    expect(containsFieldCode(`x${hyperlinkFieldCode(URL)}y`)).toBe(true);
    expect(containsFieldCode(TITLE)).toBe(false);
  });
});

describe('buildHyperlinkBody', () => {
  test('reproduces the captured write: text, offsets and three stretches', () => {
    const body = buildHyperlinkBody(target(), rangeOfWord('Milestones'), URL, GUID, HEAD);
    const [action, paragraph, codeRun, displayRun] = objectsOf(body);

    // The editor wrote boundaries "28,64" for this exact paragraph and URL.
    expect(propValue(paragraph?.Properties ?? [], 469769746)).toBe('28,64');
    expect(propValue(paragraph?.Properties ?? [], 469769250)).toBe(
      ' Fusion Pilot Timeline: Key ﷟HYPERLINK "https://example.com/sop"Milestones',
    );
    expect(propValue(paragraph?.Properties ?? [], 603987475)).toBe(`${RUN_REF},{${GUID}}{4},{${GUID}}{5}`);

    expect(action?.ClassId).toBe(131140);
    expect([codeRun?.ClassId, displayRun?.ClassId]).toEqual([1179725, 1179725]);
    expect([codeRun?.ObjectId, displayRun?.ObjectId]).toEqual([`${GUID}|4`, `${GUID}|5`]);
  });

  test('the field-code run is hidden and carries no formatting at all', () => {
    const [, , codeRun] = objectsOf(buildHyperlinkBody(target(), rangeOfWord('Milestones'), URL, GUID, HEAD));
    // 134225430 is the client's own `isHidden`.
    expect(codeRun?.Properties).toEqual([134225428, 'true', 134225430, 'true', 134225433, 'true']);
  });

  test('the display run keeps the formatting the words already had, plus the link flags', () => {
    const [, , , displayRun] = objectsOf(buildHyperlinkBody(target(), rangeOfWord('Milestones'), URL, GUID, HEAD));
    const props = displayRun?.Properties ?? [];
    expect(propValue(props, 268442635)).toBe('48');
    expect(propValue(props, 469780527)).toBe('Arial');
    expect(propValue(props, 469780760)).toBe('@001489,,');
    expect(propValue(props, 134224900)).toBe('true');
    expect(propValue(props, 134225428)).toBe('true');
    expect(propValue(props, 134225433)).toBe('true');
    expect(propValue(props, 134236593)).toBe('true');
    // The display run is NOT hidden — only the code is.
    expect(propValue(props, 134225430)).toBeUndefined();
  });

  test('a link in the middle shifts the text after it by the length of the code', () => {
    const body = buildHyperlinkBody(target(), rangeOfWord('Timeline'), URL, GUID, HEAD);
    const [, paragraph] = objectsOf(body);
    const shift = hyperlinkFieldCode(URL).length;
    // "Timeline" sits at 14..22, so the tail resumes after the code and the linked word.
    expect(propValue(paragraph?.Properties ?? [], 469769746)).toBe(`14,${14 + shift},${22 + shift}`);
    expect(propValue(paragraph?.Properties ?? [], 603987475)).toBe(`${RUN_REF},{${GUID}}{4},{${GUID}}{5},${RUN_REF}`);
  });

  test('linking the whole paragraph writes no leading stretch', () => {
    const body = buildHyperlinkBody(target(), { start: 0, end: TITLE.length }, URL, GUID, HEAD);
    const [, paragraph] = objectsOf(body);
    expect(propValue(paragraph?.Properties ?? [], 603987475)).toBe(`{${GUID}}{4},{${GUID}}{5}`);
    expect(propValue(paragraph?.Properties ?? [], 469769746)).toBe(String(hyperlinkFieldCode(URL).length));
  });

  test('properties are sorted ascending, and the paragraph keeps everything else verbatim', () => {
    const [, paragraph] = objectsOf(buildHyperlinkBody(target(), rangeOfWord('Milestones'), URL, GUID, HEAD));
    const ids: number[] = [];
    for (let i = 0; i < (paragraph?.Properties.length ?? 0); i += 2) ids.push(Number(paragraph?.Properties[i]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(propValue(paragraph?.Properties ?? [], 335562753)).toBe('58');
  });

  test('refuses a paragraph that already carries a field code rather than nesting one', () => {
    const linked = target();
    linked.text = `${TITLE}${hyperlinkFieldCode(URL)}`;
    expect(() => buildHyperlinkBody(linked, { start: 0, end: 5 }, URL, GUID, HEAD)).toThrow(FrameBridgeValidationError);
  });

  test('refuses text that spans two formatting runs, which has no single formatting to copy', () => {
    const mixed = target();
    const second = '{4efeeb47-de77-4081-a870-b0e9ad47aabf}{59}';
    mixed.segments = [
      { start: 0, end: 30, ref: RUN_REF },
      { start: 30, end: TITLE.length, ref: second },
    ];
    mixed.runsByRef.set(second, { classId: 1179725, objectId: 'x|59', properties: [268442635, '20'] });
    expect(() => buildHyperlinkBody(mixed, rangeOfWord('Milestones'), URL, GUID, HEAD)).toThrow(
      FrameBridgeValidationError,
    );
  });
});

describe('setHyperlinkAction.parseArgs', () => {
  const parse = (raw: Record<string, unknown>) => setHyperlinkAction.parseArgs(raw);

  test('accepts an http, https or mailto target and trims it', () => {
    expect(parse({ text: TITLE, url: '  https://example.com/a  ' }).url).toBe('https://example.com/a');
    expect(parse({ text: TITLE, url: 'http://example.com' }).url).toBe('http://example.com');
    expect(parse({ text: TITLE, url: 'mailto:someone@example.com' }).url).toBe('mailto:someone@example.com');
  });

  test('refuses a URL containing the quote that delimits the field code', () => {
    expect(() => parse({ text: TITLE, url: 'https://example.com/a"b' })).toThrow(/double quote/);
  });

  test('refuses a scheme it cannot write', () => {
    expect(() => parse({ text: TITLE, url: 'javascript:alert(1)' })).toThrow(FrameBridgeValidationError);
    expect(() => parse({ text: TITLE, url: 'example.com' })).toThrow(FrameBridgeValidationError);
  });

  test('requires the paragraph text and a url', () => {
    expect(() => parse({ url: URL })).toThrow(FrameBridgeValidationError);
    expect(() => parse({ text: TITLE })).toThrow(FrameBridgeValidationError);
    expect(() => parse({ text: TITLE, url: '   ' })).toThrow(FrameBridgeValidationError);
  });

  test('carries an optional match and occurrence through', () => {
    expect(parse({ text: TITLE, url: URL, match: 'Key', occurrence: 2 }).match).toEqual({
      value: 'Key',
      occurrence: 2,
    });
    expect(parse({ text: TITLE, url: URL }).match).toBeUndefined();
    expect(() => parse({ text: TITLE, url: URL, match: 'Key', occurrence: 0 })).toThrow(FrameBridgeValidationError);
  });
});

describe('buildRemoveHyperlinkBody', () => {
  /** The paragraph as it stands after a link was added — the shape the add builder writes. */
  const linked = (): ResolvedTarget => {
    const t = target();
    const code = hyperlinkFieldCode(URL);
    const start = TITLE.indexOf('Milestones');
    t.text = `${TITLE.slice(0, start)}${code}${TITLE.slice(start)}`;
    const codeRef = '{minted}{4}';
    const displayRef = '{minted}{5}';
    t.segments = [
      { start: 0, end: start, ref: RUN_REF },
      { start, end: start + code.length, ref: codeRef },
      { start: start + code.length, end: t.text.length, ref: displayRef },
    ];
    t.runsByRef.set(codeRef, {
      classId: 1179725,
      objectId: 'minted|4',
      properties: [134225428, 'true', 134225430, 'true', 134225433, 'true'],
    });
    t.runsByRef.set(displayRef, {
      classId: 1179725,
      objectId: 'minted|5',
      properties: [...RUN_PROPS, 134225428, 'true', 134225433, 'true', 134236593, 'true'],
    });
    t.paragraphProperties = [469769250, t.text, 603987475, `${RUN_REF},${codeRef},${displayRef}`, 469769746, '28,64'];
    return t;
  };

  test('restores the original text exactly', () => {
    const [, paragraph] = objectsOf(buildRemoveHyperlinkBody(linked(), GUID, HEAD));
    expect(propValue(paragraph?.Properties ?? [], 469769250)).toBe(TITLE);
    expect(containsFieldCode(String(propValue(paragraph?.Properties ?? [], 469769250)))).toBe(false);
  });

  test('the words keep their formatting and the field flags are CLEARED, not dropped', () => {
    const [, , plainRun] = objectsOf(buildRemoveHyperlinkBody(linked(), GUID, HEAD));
    const props = plainRun?.Properties ?? [];
    expect(propValue(props, 268442635)).toBe('48');
    expect(propValue(props, 469780527)).toBe('Arial');
    expect(propValue(props, 469780760)).toBe('@001489,,');
    // Captured from the editor's own RemoveHyperlink: false, not absent. An omitted
    // property is merged as unchanged, which would leave the run half a field.
    expect(propValue(props, 134225428)).toBe('false');
    expect(propValue(props, 134225433)).toBe('false');
    // The editor leaves this one true, so removal must not touch it.
    expect(propValue(props, 134236593)).toBe('true');
  });

  test('drops the field-code stretch and leaves the words as one run', () => {
    const [, paragraph] = objectsOf(buildRemoveHyperlinkBody(linked(), GUID, HEAD));
    expect(propValue(paragraph?.Properties ?? [], 603987475)).toBe(`${RUN_REF},{${GUID}}{4}`);
    expect(propValue(paragraph?.Properties ?? [], 469769746)).toBe(String(TITLE.indexOf('Milestones')));
  });

  test('refuses a paragraph that carries no link', () => {
    expect(() => buildRemoveHyperlinkBody(target(), GUID, HEAD)).toThrow(FrameBridgeValidationError);
  });

  test('add then remove round-trips back to the original text', () => {
    const [, added] = objectsOf(buildHyperlinkBody(target(), rangeOfWord('Milestones'), URL, GUID, HEAD));
    const withLink = String(propValue(added?.Properties ?? [], 469769250));
    const [, removed] = objectsOf(buildRemoveHyperlinkBody(linked(), GUID, HEAD));
    expect(withLink).toBe(linked().text);
    expect(propValue(removed?.Properties ?? [], 469769250)).toBe(TITLE);
  });
});

describe('setHyperlinkAction.parseArgs with remove', () => {
  test('remove needs no url and no match', () => {
    expect(setHyperlinkAction.parseArgs({ text: TITLE, remove: true })).toEqual({ text: TITLE, remove: true });
  });

  test('remove ignores a match rather than implying a choice the paragraph does not offer', () => {
    const parsed = setHyperlinkAction.parseArgs({ text: TITLE, remove: true, match: 'Key' }) as {
      match?: unknown;
    };
    expect(parsed.match).toBeUndefined();
  });
});
