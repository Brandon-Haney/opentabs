import { describe, expect, test } from 'vitest';
import { PODS_GUID_TOKEN, PODS_HEAD_TOKEN, podsFormatText, podsSetFontSize, podsWrite } from './pods-bridge.js';

describe('podsWrite', () => {
  const body = { Mode: 4, srs: [[3, { Revisions: [{ Id: `${PODS_GUID_TOKEN}|2`, BaseId: PODS_HEAD_TOKEN }] }]] };

  test('wraps the body in a __podsBridge directive with the PowerPoint frame/donor/sentinel', () => {
    const directive = podsWrite(body) as unknown as { __podsBridge: Record<string, unknown> };
    expect(directive.__podsBridge).toEqual({
      frameUrlIncludes: 'powerpoint.officeapps.live.com',
      donorGlobal: '__otbPptPodsDonor',
      headSentinel: '__otb_pods_head__',
      body,
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    });
  });

  test('passes the body through by reference, tokens intact for the engine to substitute', () => {
    const directive = podsWrite(body) as unknown as { __podsBridge: { body: unknown } };
    expect(directive.__podsBridge.body).toBe(body);
    expect(JSON.stringify(directive.__podsBridge.body)).toContain(PODS_GUID_TOKEN);
    expect(JSON.stringify(directive.__podsBridge.body)).toContain(PODS_HEAD_TOKEN);
  });

  test('the identity tokens are distinctive and JSON-safe (no quotes or backslashes)', () => {
    for (const token of [PODS_GUID_TOKEN, PODS_HEAD_TOKEN]) {
      expect(token).toMatch(/^__OTB_PODS_[A-Z]+__$/);
      expect(JSON.stringify(token)).toBe(`"${token}"`);
    }
  });
});

describe('podsSetFontSize', () => {
  test('builds a __podsSetFontSize directive with the target, size, and read payload', () => {
    const directive = podsSetFontSize('Workstream', 24) as unknown as { __podsSetFontSize: Record<string, unknown> };
    expect(directive.__podsSetFontSize).toEqual({
      frameUrlIncludes: 'powerpoint.officeapps.live.com',
      donorGlobal: '__otbPptPodsDonor',
      headSentinel: '__otb_pods_head__',
      text: 'Workstream',
      sizePt: 24,
      modelReadBody:
        '{"Mode":4,"srs":[[2,{"OperationId":1,"DependentOn":0,"ExpectedLatestRevisionId":"00000000-0000-0000-0000-000000000000|0","SlideId":null,"Sequence":0,"LocalRenderingParams":null}]]}',
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    });
  });

  test('carries the caller text and size verbatim', () => {
    const directive = podsSetFontSize('04/29 - PILOT GO -- NO GO', 10.5) as unknown as {
      __podsSetFontSize: { text: string; sizePt: number };
    };
    expect(directive.__podsSetFontSize.text).toBe('04/29 - PILOT GO -- NO GO');
    expect(directive.__podsSetFontSize.sizePt).toBe(10.5);
  });
});

describe('podsFormatText', () => {
  test('builds a __podsFormatText directive with only the requested changes present', () => {
    const directive = podsFormatText('Workstream', { bold: true, italic: false }) as unknown as {
      __podsFormatText: Record<string, unknown>;
    };
    expect(directive.__podsFormatText).toEqual({
      frameUrlIncludes: 'powerpoint.officeapps.live.com',
      donorGlobal: '__otbPptPodsDonor',
      headSentinel: '__otb_pods_head__',
      text: 'Workstream',
      bold: true,
      italic: false,
      modelReadBody:
        '{"Mode":4,"srs":[[2,{"OperationId":1,"DependentOn":0,"ExpectedLatestRevisionId":"00000000-0000-0000-0000-000000000000|0","SlideId":null,"Sequence":0,"LocalRenderingParams":null}]]}',
      guidToken: PODS_GUID_TOKEN,
      headToken: PODS_HEAD_TOKEN,
    });
  });

  test('omits change keys that were not requested', () => {
    const directive = podsFormatText('Title', { sizePt: 28 }) as unknown as {
      __podsFormatText: Record<string, unknown>;
    };
    expect(directive.__podsFormatText.sizePt).toBe(28);
    expect('bold' in directive.__podsFormatText).toBe(false);
    expect('italic' in directive.__podsFormatText).toBe(false);
  });
});
