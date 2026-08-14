import { afterEach, describe, expect, test, vi } from 'vitest';

// Minimal Chrome stub so transitive module access at import time resolves.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

// Mock the leaf primitive the engine replays through, so the flow can be driven
// without a browser. The real module is imported by other tests; here only the
// engine's use of it matters.
const fetchInFrame = vi.fn();
vi.mock('./frame-fetch.js', () => ({
  fetchInFrame: (...args: unknown[]) => fetchInFrame(...args),
}));

const { substituteIdentity, describePodsFailure, runPodsBridge } = await import('./pods-bridge.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

afterEach(() => {
  fetchInFrame.mockReset();
  vi.restoreAllMocks();
});

/** A pods response envelope with the given entry under Responses[0][1]. */
const podsBody = (entry: Record<string, unknown>): string =>
  JSON.stringify({ Responses: [[3, { OperationId: 1, ...entry }]] });

/**
 * Drive the mocked fetchInFrame: answer the head sentinel with `head`, and answer
 * each POST from `postResponses` in order (capturing the bodies sent).
 */
const wire = (head: string | null, postResponses: string[]): { postBodies: string[] } => {
  const postBodies: string[] = [];
  let postIdx = 0;
  fetchInFrame.mockImplementation(async (_tabId: number, _frame: string, request: { url?: string; body?: string }) => {
    if (request.url?.includes('__otb_pods_head__')) {
      return { frameId: 7, status: 200, ok: true, body: JSON.stringify({ head, ts: 1 }) };
    }
    postBodies.push(request.body ?? '');
    const body = postResponses[Math.min(postIdx, postResponses.length - 1)];
    postIdx += 1;
    return { frameId: 7, status: 200, ok: true, body };
  });
  return { postBodies };
};

const params = (body: Record<string, unknown>) => ({
  tabId: 1,
  frameUrlIncludes: 'powerpoint.officeapps.live.com',
  donorGlobal: '__otbPptPodsDonor',
  headSentinel: '__otb_pods_head__',
  body,
});

describe('substituteIdentity', () => {
  test('replaces every occurrence of both tokens', () => {
    const out = substituteIdentity(
      'run=__G__|1 rev=__G__|2 base=__H__ og=__G__|3 eli=__H__',
      '__G__',
      GUID,
      '__H__',
      'headguid|9',
    );
    expect(out).toBe(`run=${GUID}|1 rev=${GUID}|2 base=headguid|9 og=${GUID}|3 eli=headguid|9`);
    expect(out).not.toContain('__G__');
    expect(out).not.toContain('__H__');
  });
});

describe('describePodsFailure', () => {
  test('accepted write (StatusCode 0, no conflict) is not a failure', () => {
    expect(describePodsFailure({ StatusCode: 0, IsConflict: false })).toBeUndefined();
  });
  test('conflict is reported', () => {
    expect(describePodsFailure({ StatusCode: 124, IsConflict: true })).toMatch(/conflict/i);
  });
  test('non-zero StatusCode with a ServerError is reported with the code', () => {
    const reason = describePodsFailure({ StatusCode: 124, ServerError: { Code: 157, Source: 2 } });
    expect(reason).toMatch(/StatusCode 124/);
    expect(reason).toMatch(/157\/2/);
  });
  test('missing payload is a failure', () => {
    expect(describePodsFailure(undefined)).toMatch(/no Responses/i);
  });
});

describe('runPodsBridge', () => {
  test('substitutes the read head and a minted GUID into the body, then reports acceptance', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(GUID);
    const { postBodies } = wire('serverhead|1', [podsBody({ StatusCode: 0, IsConflict: false })]);

    const result = await runPodsBridge(
      params({ Mode: 4, srs: [[3, { id: '__OTB_PODS_GUID__|2', base: '__OTB_PODS_HEAD__' }]] }),
    );

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(0);
    expect(result.head).toBe('serverhead|1');
    expect(result.retries).toBe(0);
    // The POST body carried the substituted identity, not the tokens.
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]).toContain(`${GUID}|2`);
    expect(postBodies[0]).toContain('serverhead|1');
    expect(postBodies[0]).not.toContain('__OTB_PODS_GUID__');
    expect(postBodies[0]).not.toContain('__OTB_PODS_HEAD__');
  });

  test('retries a conflict with a freshly-read head and succeeds', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(GUID);
    // Head advances between attempts; first POST conflicts, second applies.
    let head = 'head-a|1';
    fetchInFrame.mockImplementation(async (_t: number, _f: string, request: { url?: string; body?: string }) => {
      if (request.url?.includes('__otb_pods_head__'))
        return { frameId: 7, status: 200, ok: true, body: JSON.stringify({ head }) };
      const conflicted = head === 'head-a|1';
      head = 'head-b|1';
      return {
        frameId: 7,
        status: 200,
        ok: true,
        body: podsBody({ StatusCode: conflicted ? 124 : 0, IsConflict: conflicted }),
      };
    });

    const result = await runPodsBridge(params({ base: '__OTB_PODS_HEAD__' }));

    expect(result.failure).toBeUndefined();
    expect(result.retries).toBe(1);
    expect(result.head).toBe('head-b|1');
  });

  test('a persistent conflict is surfaced as a failure after exhausting retries', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(GUID);
    wire('stale|1', [podsBody({ StatusCode: 124, IsConflict: true })]);

    const result = await runPodsBridge(params({ base: '__OTB_PODS_HEAD__' }));

    expect(result.isConflict).toBe(true);
    expect(result.failure).toMatch(/conflict/i);
    expect(result.retries).toBe(3);
  });

  test('a non-conflict rejection fails immediately without retrying', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(GUID);
    const { postBodies } = wire('head|1', [podsBody({ StatusCode: 2, ServerError: { Code: 5, Source: 1 } })]);

    const result = await runPodsBridge(params({ base: '__OTB_PODS_HEAD__' }));

    expect(result.failure).toMatch(/StatusCode 2/);
    expect(result.isConflict).toBeUndefined();
    expect(postBodies).toHaveLength(1); // no retry
  });

  test('a null head (editor has not polled yet) fails with a clear message', async () => {
    wire(null, [podsBody({ StatusCode: 0 })]);
    await expect(runPodsBridge(params({ base: '__OTB_PODS_HEAD__' }))).rejects.toBeInstanceOf(
      FrameBridgeValidationError,
    );
  });
});
