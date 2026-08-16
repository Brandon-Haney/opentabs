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

const {
  substituteIdentity,
  describePodsFailure,
  runPodsBridge,
  runPodsWriteConfirmed,
  sortPropertiesById,
  freshAfterFirst,
} = await import('./pods-bridge.js');
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

describe('sortPropertiesById', () => {
  test('orders pairs ascending by id without splitting them', () => {
    expect(sortPropertiesById([603986975, 'slides', 134236331, 'false', 335562809, '26.6'])).toEqual([
      134236331,
      'false',
      335562809,
      '26.6',
      603986975,
      'slides',
    ]);
  });

  test('drops a trailing id with no value rather than emitting a broken pair', () => {
    expect(sortPropertiesById([2, 'b', 1])).toEqual([2, 'b']);
  });
});

describe('runPodsWriteConfirmed', () => {
  /** A confirmation whose readState returns each queued state in turn. */
  const confirmationOver = (states: boolean[], idempotent: boolean) => {
    let i = 0;
    return {
      readState: async () => states[Math.min(i++, states.length - 1)] ?? false,
      isApplied: (state: boolean) => state,
      idempotent,
      delayMs: 0,
    };
  };

  test('a write whose change is observed reports applied with no failure', async () => {
    const { postBodies } = wire('h|1', [podsBody({ StatusCode: 0 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmationOver([true], false));
    expect(result.applied).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.confirmationReads).toBe(1);
    expect(postBodies).toHaveLength(1);
  });

  test('a lagging read is retried until the change surfaces', async () => {
    wire('h|1', [podsBody({ StatusCode: 0 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmationOver([false, false, true], false));
    expect(result.applied).toBe(true);
    expect(result.confirmationReads).toBe(3);
    expect(result.failure).toBeUndefined();
  });

  // The safety property: an accepted-but-invisible structural write must NOT be
  // re-issued, because if it did land, a second write would delete/add twice.
  test('a NON-idempotent write whose change never appears is reported and NEVER re-issued', async () => {
    const { postBodies } = wire('h|1', [podsBody({ StatusCode: 0 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmationOver([false], false));
    expect(result.applied).toBe(false);
    expect(result.failure).toMatch(/accepted/i);
    expect(result.failure).toMatch(/twice|not retried automatically/i);
    expect(postBodies).toHaveLength(1); // the whole point — exactly one write
  });

  test('an idempotent write whose change never appears IS re-issued, then fails cleanly', async () => {
    const { postBodies } = wire('h|1', [podsBody({ StatusCode: 0 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmationOver([false], true));
    expect(result.applied).toBe(false);
    expect(result.failure).toMatch(/never appeared/i);
    expect(postBodies).toHaveLength(2); // one retry, bounded
  });

  test('an idempotent write confirmed on the second attempt succeeds', async () => {
    // First attempt never confirms; the rewrite does.
    let call = 0;
    const confirmation = {
      readState: async () => {
        call += 1;
        return call > 3; // first attempt's 3 reads fail, the rewrite's first read passes
      },
      isApplied: (state: boolean) => state,
      idempotent: true,
      delayMs: 0,
    };
    const { postBodies } = wire('h|1', [podsBody({ StatusCode: 0 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmation);
    expect(result.applied).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(postBodies).toHaveLength(2);
  });

  test('a server-refused write returns its own reason without any confirmation read', async () => {
    let reads = 0;
    const confirmation = {
      readState: async () => {
        reads += 1;
        return true;
      },
      isApplied: (state: boolean) => state,
      idempotent: false,
      delayMs: 0,
    };
    wire('h|1', [podsBody({ StatusCode: 3 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmation);
    expect(result.failure).toMatch(/StatusCode 3/);
    expect(result.applied).toBeUndefined();
    expect(reads).toBe(0); // a refusal needs no confirmation
  });

  test('a throwing confirmation read counts as inconclusive, not as a failed write', async () => {
    let call = 0;
    const confirmation = {
      readState: async () => {
        call += 1;
        if (call === 1) throw new Error('frame briefly unavailable');
        return true;
      },
      isApplied: (state: boolean) => state,
      idempotent: false,
      delayMs: 0,
    };
    wire('h|1', [podsBody({ StatusCode: 0 })]);
    const result = await runPodsWriteConfirmed(params({ b: 1 }), confirmation);
    expect(result.applied).toBe(true);
    expect(result.failure).toBeUndefined();
  });
});

describe('freshAfterFirst', () => {
  test('returns the supplied value once, then re-resolves on every later call', async () => {
    let resolved = 0;
    const next = freshAfterFirst('initial', async () => `resolved-${++resolved}`);
    expect(await next()).toBe('initial');
    expect(await next()).toBe('resolved-1');
    expect(await next()).toBe('resolved-2');
    expect(resolved).toBe(2); // the first call did not read
  });
});

describe('runPodsBridge body factory', () => {
  test('a static body is sent as-is', async () => {
    const { postBodies } = wire('h|1', [podsBody({ StatusCode: 0 })]);
    await runPodsBridge(params({ shape: 'static' }));
    expect(postBodies[0]).toContain('"shape":"static"');
  });

  // The point of the factory: a conflict means the document moved, so the retry
  // must rebuild against the document as it is now, not replay the first snapshot.
  test('a conflict retry re-derives the body instead of replaying the stale one', async () => {
    let built = 0;
    let head = 'head-a|1';
    const postBodies: string[] = [];
    fetchInFrame.mockImplementation(async (_t: number, _f: string, request: { url?: string; body?: string }) => {
      if (request.url?.includes('__otb_pods_head__'))
        return { frameId: 7, status: 200, ok: true, body: JSON.stringify({ head }) };
      postBodies.push(request.body ?? '');
      const conflicted = head === 'head-a|1';
      head = 'head-b|1';
      return {
        frameId: 7,
        status: 200,
        ok: true,
        body: podsBody({ StatusCode: conflicted ? 124 : 0, IsConflict: conflicted }),
      };
    });

    const result = await runPodsBridge({
      ...params({}),
      body: async () => ({ derivedOnAttempt: ++built }),
    });

    expect(result.failure).toBeUndefined();
    expect(built).toBe(2);
    expect(postBodies[0]).toContain('"derivedOnAttempt":1');
    expect(postBodies[1]).toContain('"derivedOnAttempt":2'); // rebuilt, not replayed
  });

  test('a factory that throws (target vanished) surfaces the error rather than writing', async () => {
    const { postBodies } = wire('h|1', [podsBody({ StatusCode: 0 })]);
    await expect(
      runPodsBridge({
        ...params({}),
        body: async () => {
          throw new Error('slide is no longer in the deck');
        },
      }),
    ).rejects.toThrow(/no longer in the deck/);
    expect(postBodies).toHaveLength(0);
  });
});
