/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://outlook.cloud.microsoft/mail/"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { collectAuthCandidates, describeTokenSources, GRAPH_API_BASE, OUTLOOK_API_BASE } from './auth-candidates.js';
import { tokenFingerprint } from './token-fingerprint.js';

const ENTERPRISE_CLIENT_ID = '9199bf20-a13f-4107-85dc-02114787ef48';
const CONSUMER_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';
const OTHER_CLIENT_ID = '11111111-2222-3333-4444-555555555555';

const NOW = 1_800_000_000_000;
const IN_ONE_HOUR = Math.floor(NOW / 1000) + 3600;

interface MsalEntry {
  secret: string;
  target: string;
  expiresOn: number | string;
}

/** Seeds a modern (v2/v3) MSAL token index and its entries for one client id. */
const seedModern = (version: '2' | '3', clientId: string, entries: MsalEntry[]): void => {
  const keys = entries.map((_entry, index) => `${clientId}-v${version}-${index}`);
  localStorage.setItem(`msal.${version}.token.keys.${clientId}`, JSON.stringify({ accessToken: keys }));
  entries.forEach((entry, index) => {
    localStorage.setItem(keys[index] ?? '', JSON.stringify(entry));
  });
};

/** Seeds a v1 MSAL token index whose keys carry the Graph resource, plus its entries. */
const seedV1 = (clientId: string, entries: Omit<MsalEntry, 'target'>[]): void => {
  const keys = entries.map((_entry, index) => `${clientId}-v1-https://graph.microsoft.com/-${index}`);
  localStorage.setItem(`msal.token.keys.${clientId}`, JSON.stringify({ accessToken: keys }));
  entries.forEach((entry, index) => {
    localStorage.setItem(keys[index] ?? '', JSON.stringify(entry));
  });
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collectAuthCandidates', () => {
  test('returns nothing when no MSAL entries exist', () => {
    expect(collectAuthCandidates()).toEqual([]);
  });

  test('orders v3 enterprise Graph, then REST, then v2, then v1 consumer, then other client ids', () => {
    seedModern('3', ENTERPRISE_CLIENT_ID, [
      { secret: 'v3-rest', target: 'https://outlook.office.com/Mail.ReadWrite', expiresOn: IN_ONE_HOUR },
      { secret: 'v3-graph', target: 'openid https://graph.microsoft.com/Mail.Read', expiresOn: IN_ONE_HOUR },
    ]);
    seedModern('2', ENTERPRISE_CLIENT_ID, [
      { secret: 'v2-graph', target: 'https://graph.microsoft.com/.default', expiresOn: IN_ONE_HOUR },
    ]);
    seedV1(CONSUMER_CLIENT_ID, [{ secret: 'v1-consumer', expiresOn: IN_ONE_HOUR }]);
    seedModern('3', OTHER_CLIENT_ID, [
      { secret: 'other-graph', target: 'https://graph.microsoft.com/User.Read', expiresOn: IN_ONE_HOUR },
    ]);

    expect(collectAuthCandidates()).toEqual([
      {
        token: 'v3-graph',
        apiBase: GRAPH_API_BASE,
        cache: 'v3',
        clientId: ENTERPRISE_CLIENT_ID,
        expiresOn: IN_ONE_HOUR,
      },
      {
        token: 'v3-rest',
        apiBase: OUTLOOK_API_BASE,
        cache: 'v3',
        clientId: ENTERPRISE_CLIENT_ID,
        expiresOn: IN_ONE_HOUR,
      },
      {
        token: 'v2-graph',
        apiBase: GRAPH_API_BASE,
        cache: 'v2',
        clientId: ENTERPRISE_CLIENT_ID,
        expiresOn: IN_ONE_HOUR,
      },
      {
        token: 'v1-consumer',
        apiBase: GRAPH_API_BASE,
        cache: 'v1',
        clientId: CONSUMER_CLIENT_ID,
        expiresOn: IN_ONE_HOUR,
      },
      { token: 'other-graph', apiBase: GRAPH_API_BASE, cache: 'v3', clientId: OTHER_CLIENT_ID, expiresOn: IN_ONE_HOUR },
    ]);
  });

  test('skips expired, malformed and non-matching entries', () => {
    seedModern('3', ENTERPRISE_CLIENT_ID, [
      { secret: 'expired', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: Math.floor(NOW / 1000) - 1 },
      { secret: 'garbage-expiry', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: '9999999999junk' },
      { secret: 'wrong-host', target: 'https://attacker.example/graph.microsoft.com/x', expiresOn: IN_ONE_HOUR },
      { secret: '', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: IN_ONE_HOUR },
      { secret: 'valid', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: IN_ONE_HOUR },
    ]);
    localStorage.setItem(`msal.2.token.keys.${ENTERPRISE_CLIENT_ID}`, 'not json');

    expect(collectAuthCandidates().map(c => c.token)).toEqual(['valid']);
  });

  test('deduplicates by secret, keeping the first provenance', () => {
    seedModern('3', ENTERPRISE_CLIENT_ID, [
      { secret: 'shared', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: IN_ONE_HOUR },
    ]);
    seedModern('2', ENTERPRISE_CLIENT_ID, [
      { secret: 'shared', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: IN_ONE_HOUR + 60 },
    ]);

    const candidates = collectAuthCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ token: 'shared', cache: 'v3', expiresOn: IN_ONE_HOUR });
  });
});

describe('describeTokenSources', () => {
  test('lists an absent row for every known lookup when no token exists', () => {
    const rows = describeTokenSources(NOW);
    expect(rows).toHaveLength(5);
    expect(rows.every(row => !row.present && row.knownClient && row.fingerprint === null)).toBe(true);
    expect(rows.map(row => `${row.source} ${row.audienceHost}`)).toEqual([
      'msal.v3 graph.microsoft.com',
      'msal.v3 outlook.office.com',
      'msal.v2 graph.microsoft.com',
      'msal.v2 outlook.office.com',
      'msal.v1 graph.microsoft.com',
    ]);
  });

  test('describes present tokens with expiry and fingerprint, then other client ids, never the secret', () => {
    seedModern('3', ENTERPRISE_CLIENT_ID, [
      { secret: 'v3-graph-secret', target: 'https://graph.microsoft.com/Mail.Read', expiresOn: IN_ONE_HOUR },
    ]);
    seedModern('3', OTHER_CLIENT_ID, [
      { secret: 'other-secret', target: 'https://outlook.office.com/Mail.Read', expiresOn: IN_ONE_HOUR + 30 },
    ]);

    const rows = describeTokenSources(NOW);
    expect(rows[0]).toEqual({
      source: 'msal.v3',
      clientId: ENTERPRISE_CLIENT_ID,
      knownClient: true,
      audienceHost: 'graph.microsoft.com',
      present: true,
      expiresInSec: 3600,
      fingerprint: tokenFingerprint('v3-graph-secret'),
    });
    expect(rows.slice(1, 5).every(row => !row.present)).toBe(true);
    expect(rows[5]).toEqual({
      source: 'msal.v3',
      clientId: OTHER_CLIENT_ID,
      knownClient: false,
      audienceHost: 'outlook.office.com',
      present: true,
      expiresInSec: 3630,
      fingerprint: tokenFingerprint('other-secret'),
    });
    expect(JSON.stringify(rows)).not.toMatch(/secret/);
  });
});
