import { describe, expect, test } from 'vitest';

// Minimal Chrome stub so any transitive module access at import time resolves,
// then dynamically import the module under test so the stub is in place first.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const { buildReplayHeaders, deriveTargetUrl, mergeContextFromResponse } = await import('./frame-bridge-rpc.js');

describe('deriveTargetUrl', () => {
  test('replaces the method segment and preserves the query string', () => {
    expect(
      deriveTargetUrl(
        'https://usc-excel.officeapps.live.com/x/_vti_bin/EwaInternalWebService.json/GetSessionStatus?waccluster=PUS1',
        'EwaInternalWebService.json/',
        'FreezeOrUnfreezePanes',
      ),
    ).toBe(
      'https://usc-excel.officeapps.live.com/x/_vti_bin/EwaInternalWebService.json/FreezeOrUnfreezePanes?waccluster=PUS1',
    );
  });

  test('works when the donor URL has no query string', () => {
    expect(deriveTargetUrl('https://host/a/Svc.json/Foo', 'Svc.json/', 'Bar')).toBe('https://host/a/Svc.json/Bar');
  });

  test('throws when the marker is absent from the donor URL', () => {
    expect(() => deriveTargetUrl('https://host/other/Foo', 'Svc.json/', 'Bar')).toThrow(/marker/);
  });
});

describe('buildReplayHeaders', () => {
  test('strips headers a fetch cannot set (case-insensitive) and keeps the rest', () => {
    const result = buildReplayHeaders({
      'Content-Type': 'application/json',
      'X-AccessToken': 'jwt',
      haep: '2',
      Cookie: 'a=b',
      Host: 'example.com',
      'Content-Length': '10',
      Origin: 'https://x',
      Referer: 'https://x/page',
      'User-Agent': 'UA',
      DNT: '1',
      'sec-ch-ua': '"Chromium"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });
    expect(result).toEqual({ 'Content-Type': 'application/json', 'X-AccessToken': 'jwt', haep: '2' });
  });

  test('refreshes X-CorrelationId with a new value, preserving the key casing', () => {
    const result = buildReplayHeaders({ 'X-CorrelationId': 'old-id', 'X-AccessToken': 'jwt' });
    expect(result['X-CorrelationId']).toBeDefined();
    expect(result['X-CorrelationId']).not.toBe('old-id');
    expect(result['X-CorrelationId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(result['X-AccessToken']).toBe('jwt');
  });

  test('leaves headers untouched when there is no correlation id', () => {
    expect(buildReplayHeaders({ 'X-AccessToken': 'jwt' })).toEqual({ 'X-AccessToken': 'jwt' });
  });
});

describe('mergeContextFromResponse', () => {
  const baseContext = () => ({
    SessionId: 'old-session',
    TransientEditSessionToken: 'old-token',
    WorkbookMetadataParameter: { WorkbookMetadataState: { MetadataVersion: 3, ServerEventVersion: 0 } },
    CollaborationParameter: { CollaborationState: { UserListVersion: 2, CollabStateId: 4 } },
    ClientRevisions: { Min: 4, Max: 4, MaxFromBlockCache: 4 },
    MergeCount: { Current: 1, Pending: 1 },
    ClientRequestId: 'unchanged',
  });

  const freshResponse = {
    SessionId: 'new-session',
    TransientEditSessionToken: 'new-token',
    StateId: 9,
    WorkbookMetadataResult: { WorkbookMetadataState: { MetadataVersion: 7 } },
    CollaborationResult: { CollaborationState: { UserListVersion: 5, CollabStateId: 9 } },
    MergeCount: { Current: 2, Pending: 2 },
  };

  test('overwrites live edit-state fields from the response', () => {
    const ctx = baseContext();
    mergeContextFromResponse(ctx, freshResponse);
    expect(ctx.SessionId).toBe('new-session');
    expect(ctx.TransientEditSessionToken).toBe('new-token');
    expect(ctx.WorkbookMetadataParameter.WorkbookMetadataState.MetadataVersion).toBe(7);
    expect(ctx.CollaborationParameter.CollaborationState.UserListVersion).toBe(5);
    expect(ctx.CollaborationParameter.CollaborationState.CollabStateId).toBe(9);
    expect(ctx.ClientRevisions).toEqual({ Min: 9, Max: 9, MaxFromBlockCache: 9 });
    expect(ctx.MergeCount).toEqual({ Current: 2, Pending: 2 });
  });

  test('preserves fields the response does not provide', () => {
    const ctx = baseContext();
    mergeContextFromResponse(ctx, { SessionId: 'only-session' });
    expect(ctx.SessionId).toBe('only-session');
    // Untouched:
    expect(ctx.TransientEditSessionToken).toBe('old-token');
    expect(ctx.WorkbookMetadataParameter.WorkbookMetadataState.MetadataVersion).toBe(3);
    expect(ctx.CollaborationParameter.CollaborationState.CollabStateId).toBe(4);
    expect(ctx.ClientRevisions).toEqual({ Min: 4, Max: 4, MaxFromBlockCache: 4 });
    expect(ctx.ClientRequestId).toBe('unchanged');
  });

  test('does not create nested shapes that are absent from the context', () => {
    const ctx: Record<string, unknown> = { SessionId: 'x' };
    mergeContextFromResponse(ctx, freshResponse);
    // No CollaborationParameter/WorkbookMetadataParameter existed → not fabricated.
    expect(ctx.CollaborationParameter).toBeUndefined();
    expect(ctx.WorkbookMetadataParameter).toBeUndefined();
    expect(ctx.ClientRevisions).toBeUndefined();
    // Top-level string fields still applied.
    expect(ctx.SessionId).toBe('new-session');
    expect(ctx.TransientEditSessionToken).toBe('new-token');
  });
});
