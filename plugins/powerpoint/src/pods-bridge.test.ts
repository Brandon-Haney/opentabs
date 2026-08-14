import { describe, expect, test } from 'vitest';
import { PODS_GUID_TOKEN, PODS_HEAD_TOKEN, podsWrite } from './pods-bridge.js';

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
