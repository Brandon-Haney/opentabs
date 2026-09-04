import { beforeEach, describe, expect, test } from 'vitest';
import {
  eligibleCandidates,
  forgetRejected,
  isRejected,
  listRejected,
  rememberRejected,
  resetCascadeMemory,
} from './auth-cascade-memory.js';
import { tokenFingerprint } from './token-fingerprint.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const REST = 'https://outlook.office.com/api/v2.0';

const graphToken = { token: 'graph-secret-token', apiBase: GRAPH };
const restToken = { token: 'rest-secret-token', apiBase: REST };
const sameSecretOnRest = { token: graphToken.token, apiBase: REST };

beforeEach(() => {
  resetCascadeMemory();
});

describe('rememberRejected / isRejected', () => {
  test('an unknown candidate is not rejected', () => {
    expect(isRejected('outlook', graphToken)).toBe(false);
  });

  test('a rejection is keyed by token and api base within one slot', () => {
    rememberRejected('outlook', graphToken);
    expect(isRejected('outlook', graphToken)).toBe(true);
    expect(isRejected('outlook', sameSecretOnRest)).toBe(false);
    expect(isRejected('outlook', restToken)).toBe(false);
    expect(isRejected('outlook-calendar', graphToken)).toBe(false);
  });
});

describe('listRejected', () => {
  test('returns secret-free descriptors', () => {
    rememberRejected('outlook', graphToken, 1_700_000_000_000);
    const [entry] = listRejected('outlook');
    expect(entry).toEqual({
      apiBase: GRAPH,
      fingerprint: tokenFingerprint(graphToken.token),
      rejectedAt: 1_700_000_000_000,
    });
    expect(Object.keys(entry ?? {})).toEqual(['apiBase', 'fingerprint', 'rejectedAt']);
    expect(JSON.stringify(listRejected('outlook'))).not.toContain(graphToken.token);
  });

  test('is empty for a slot with no rejections', () => {
    expect(listRejected('outlook')).toEqual([]);
  });
});

describe('eligibleCandidates', () => {
  test('returns a new array holding every candidate when nothing is remembered', () => {
    const candidates = [graphToken, restToken];
    const eligible = eligibleCandidates('outlook', candidates);
    expect(eligible).toEqual(candidates);
    expect(eligible).not.toBe(candidates);
  });

  test('filters remembered rejections and keeps the order of the rest', () => {
    rememberRejected('outlook', graphToken);
    expect(eligibleCandidates('outlook', [graphToken, restToken, sameSecretOnRest])).toEqual([
      restToken,
      sameSecretOnRest,
    ]);
    expect(listRejected('outlook')).toHaveLength(1);
  });

  test('forgets the slot and returns every candidate once all of them are rejected', () => {
    rememberRejected('outlook', graphToken);
    rememberRejected('outlook', restToken);
    expect(eligibleCandidates('outlook', [graphToken, restToken])).toEqual([graphToken, restToken]);
    expect(listRejected('outlook')).toEqual([]);
  });

  test('returns [] for an empty candidate list without touching the memory', () => {
    rememberRejected('outlook', graphToken);
    expect(eligibleCandidates('outlook', [])).toEqual([]);
    expect(listRejected('outlook')).toHaveLength(1);
  });

  test('returns only a newly appeared candidate while the stale ones stay remembered', () => {
    rememberRejected('outlook', graphToken);
    rememberRejected('outlook', restToken);
    const rotated = { token: 'rotated-graph-secret', apiBase: GRAPH };
    expect(eligibleCandidates('outlook', [rotated, graphToken, restToken])).toEqual([rotated]);
    expect(listRejected('outlook')).toHaveLength(2);
  });

  test('is scoped per slot', () => {
    rememberRejected('outlook', graphToken);
    expect(eligibleCandidates('outlook-calendar', [graphToken, restToken])).toEqual([graphToken, restToken]);
  });
});

describe('forgetRejected / resetCascadeMemory', () => {
  test('forgetRejected clears only the named slot', () => {
    rememberRejected('outlook', graphToken);
    rememberRejected('outlook-calendar', graphToken);
    forgetRejected('outlook');
    expect(listRejected('outlook')).toEqual([]);
    expect(listRejected('outlook-calendar')).toHaveLength(1);
  });

  test('resetCascadeMemory clears every slot', () => {
    rememberRejected('outlook', graphToken);
    rememberRejected('outlook-calendar', restToken);
    resetCascadeMemory();
    expect(listRejected('outlook')).toEqual([]);
    expect(listRejected('outlook-calendar')).toEqual([]);
  });
});
