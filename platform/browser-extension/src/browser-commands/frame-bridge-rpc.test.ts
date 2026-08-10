import { describe, expect, test } from 'vitest';

// Minimal Chrome stub so any transitive module access at import time resolves,
// then dynamically import the module under test so the stub is in place first.
(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

const {
  applyProjection,
  assignAtPath,
  buildQueryUrl,
  buildReplayHeaders,
  deriveTargetUrl,
  describeBridgeFailure,
  mergeContextFromResponse,
  selectFromPrep,
} = await import('./frame-bridge-rpc.js');

describe('selectFromPrep', () => {
  // Shaped like a PivotTable filter search: an "All" grouping row whose children
  // are the matching members, each carrying the id the commit is addressed by.
  const searchResponse = {
    Result: {
      PivotFilterItems: [
        {
          DisplayString: 'All',
          Id: 1,
          PivotFilterItems: [
            { DisplayString: 'ATL080 | DALLAS | HIRAM', Id: 168, PivotFilterItems: [] },
            { DisplayString: 'ATL081 | DOUGLASVILLE | DOUGLASVILLE', Id: 169, PivotFilterItems: [] },
          ],
        },
      ],
    },
  };

  const selection = (values: string[], asString = true) => ({
    option: 'checkedItems',
    projection: {
      path: 'Result.PivotFilterItems',
      fields: { name: 'DisplayString', id: 'Id' },
      flattenChildren: 'PivotFilterItems',
    },
    matchField: 'name',
    valueField: 'id',
    values,
    ...(asString ? { asString: true } : {}),
  });

  test('resolves a partial name to the one matching id', () => {
    expect(selectFromPrep(searchResponse, selection(['ATL081']))).toEqual(['169']);
  });

  test('matches case-insensitively', () => {
    expect(selectFromPrep(searchResponse, selection(['atl080']))).toEqual(['168']);
  });

  test('returns numbers when asString is not set', () => {
    expect(selectFromPrep(searchResponse, selection(['ATL081'], false))).toEqual([169]);
  });

  // The point of resolving by name: a term that could mean several members must
  // never silently become one of them.
  test('refuses an ambiguous term and names the candidates', () => {
    expect(() => selectFromPrep(searchResponse, selection(['ATL08']))).toThrow(/ambiguous/);
    expect(() => selectFromPrep(searchResponse, selection(['ATL08']))).toThrow(/DOUGLASVILLE/);
  });

  test('refuses a term that matches nothing', () => {
    expect(() => selectFromPrep(searchResponse, selection(['ZZZ999']))).toThrow(/matched none/);
  });

  test('refuses when the lookup returned no candidates at all', () => {
    expect(() => selectFromPrep({ Result: {} }, selection(['ATL081']))).toThrow(/matched none/);
  });
});

describe('assignAtPath', () => {
  // Shaped like an ApplyPivot body, whose concurrency counters the engine lifts
  // out of a prep response and writes into a nested option object.
  const pivotOptions = () => ({
    cell: { SheetName: 'Sales' },
    pivotFieldApplyData: { FieldListType: 1, ItemIndex: 311 } as Record<string, unknown>,
  });

  test('writes a value at a nested path', () => {
    const options = pivotOptions();
    assignAtPath(options, 'pivotFieldApplyData.FieldListVersion', 5);
    expect(options.pivotFieldApplyData.FieldListVersion).toBe(5);
  });

  test('overwrites a value that is already there', () => {
    const options = pivotOptions();
    assignAtPath(options, 'pivotFieldApplyData.ItemIndex', 999);
    expect(options.pivotFieldApplyData.ItemIndex).toBe(999);
  });

  test('writes a top-level key', () => {
    const options = pivotOptions();
    assignAtPath(options, 'dataSourceIndex', 0);
    expect(options).toHaveProperty('dataSourceIndex', 0);
  });

  test('leaves every other field untouched', () => {
    const options = pivotOptions();
    assignAtPath(options, 'pivotFieldApplyData.FieldWellVersion', 7);
    expect(options.pivotFieldApplyData).toEqual({ FieldListType: 1, ItemIndex: 311, FieldWellVersion: 7 });
    expect(options.cell).toEqual({ SheetName: 'Sales' });
  });

  // The branch is not created, so a path naming a parent that does not exist is
  // a typo or a changed request shape. Silently growing it would send a request
  // the service ignores while the call reported success.
  test('throws rather than creating a missing parent', () => {
    const options = pivotOptions();
    expect(() => {
      assignAtPath(options, 'notThere.FieldListVersion', 5);
    }).toThrow(/notThere/);
    expect(options).not.toHaveProperty('notThere');
  });

  test('throws when an intermediate segment is not an object', () => {
    const options = pivotOptions();
    expect(() => {
      assignAtPath(options, 'pivotFieldApplyData.ItemIndex.Nested', 5);
    }).toThrow(/ItemIndex/);
  });

  test('rejects an empty path', () => {
    expect(() => {
      assignAtPath(pivotOptions(), '', 5);
    }).toThrow();
  });
});

describe('describeBridgeFailure', () => {
  const ok = { ok: true, status: 200, errors: [] as unknown[], response: { Result: {} } };

  test('returns null for a clean success', () => {
    expect(describeBridgeFailure(ok)).toBeNull();
  });

  test('reports a service refusal from the outer Errors array', () => {
    const message = describeBridgeFailure({
      ...ok,
      errors: [{ MessageIdName: 'PftTokenMissing', Description: 'There was a problem with this session.' }],
    });
    expect(message).toContain('PftTokenMissing');
    expect(message).toContain('There was a problem with this session.');
    // Must not promise nothing applied: a refused PivotTable creation was
    // observed leaving behind the connection the same request had just created.
    expect(message).not.toContain('Nothing was applied');
    expect(message).toContain('Check the current state before retrying');
  });

  test('falls back to Caption when the error carries no Description', () => {
    expect(
      describeBridgeFailure({ ...ok, errors: [{ MessageIdName: 'X', Caption: 'Please refresh the page' }] }),
    ).toContain('Please refresh the page');
  });

  test('appends the hint registered for that error code', () => {
    expect(
      describeBridgeFailure(
        { ...ok, errors: [{ MessageIdName: 'PftTokenMissing' }] },
        { PftTokenMissing: 'Ask the user.' },
      ),
    ).toContain('Ask the user.');
  });

  test('leaves the message alone when no hint matches the code', () => {
    expect(
      describeBridgeFailure({ ...ok, errors: [{ MessageIdName: 'Other' }] }, { PftTokenMissing: 'Ask.' }),
    ).not.toContain('Ask.');
  });

  // The trap this function exists for: a tunnelled object-model batch reports its
  // failure nested in the response body while the outer array stays empty and the
  // status stays 200, so checking only one layer reads a refusal as a success.
  test('reports an object-model error nested in the response body', () => {
    const message = describeBridgeFailure({
      ...ok,
      errors: [],
      response: { Result: { ResponseBody: [{ Error: { Code: 'GeneralException', Message: 'An error occurred.' } }] } },
    });
    expect(message).toContain('GeneralException');
    expect(message).toContain('An error occurred.');
    // A batch can have applied earlier steps before the failing one, so this
    // layer must not claim otherwise the way the outer-error layer does.
    expect(message).not.toContain('Nothing was applied');
    expect(message).toContain('may already have applied');
  });

  test('skips response-body entries that carry no error', () => {
    expect(
      describeBridgeFailure({
        ...ok,
        response: { Result: { ResponseBody: [{ Value: 1 }, { Error: { Code: 'Late' } }] } },
      }),
    ).toContain('Late');
  });

  test('still reports a refusal when the error entry is not the expected shape', () => {
    expect(describeBridgeFailure({ ...ok, errors: ['something unexpected'] })).toContain('unknown error');
  });

  test('reports an HTTP-level failure', () => {
    expect(describeBridgeFailure({ ...ok, ok: false, status: 500 })).toContain('500');
  });

  // A truncated body cannot be parsed, so it yields no error array at all — which
  // would otherwise be indistinguishable from a clean success.
  test('reports a truncated body rather than treating it as success', () => {
    const message = describeBridgeFailure({ ok: true, status: 200, errors: undefined, response: 'abc... (truncated)' });
    expect(message).toContain('truncated');
  });

  test('does not mistake an ordinary string response for a truncated one', () => {
    expect(describeBridgeFailure({ ok: true, status: 200, errors: undefined, response: 'plain body' })).toBeNull();
  });
});

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

describe('buildQueryUrl', () => {
  const base = 'https://host/x/_vti_bin/Svc.json/GetPivotFilterData?waccluster=PUS1';

  test('JSON-encodes a string parameter, quotes included', () => {
    // The service deserializes every GET parameter as JSON, so a string
    // argument travels quoted. Sending it bare fails server-side.
    const url = new URL(buildQueryUrl(base, { fieldId: '6', currentSheetName: 'Sales PowerBI' }));
    expect(url.searchParams.get('fieldId')).toBe('"6"');
    expect(url.searchParams.get('currentSheetName')).toBe('"Sales PowerBI"');
  });

  test('leaves numbers, booleans and null in their bare JSON form', () => {
    const url = new URL(buildQueryUrl(base, { dataSourceIndex: 1, parentId: -1, needConnect: true, chartId: null }));
    expect(url.searchParams.get('dataSourceIndex')).toBe('1');
    expect(url.searchParams.get('parentId')).toBe('-1');
    expect(url.searchParams.get('needConnect')).toBe('true');
    expect(url.searchParams.get('chartId')).toBe('null');
  });

  test('JSON-encodes objects and arrays', () => {
    const url = new URL(buildQueryUrl(base, { cell: { SheetName: 'S', FirstRow: 1 }, filterCriteria: ['0', '0'] }));
    expect(url.searchParams.get('cell')).toBe('{"SheetName":"S","FirstRow":1}');
    expect(url.searchParams.get('filterCriteria')).toBe('["0","0"]');
  });

  test('preserves donor query parameters the service routes on', () => {
    const url = new URL(buildQueryUrl(base, { fieldId: '6' }));
    expect(url.searchParams.get('waccluster')).toBe('PUS1');
  });

  test('skips undefined values rather than sending the string "undefined"', () => {
    const url = new URL(buildQueryUrl(base, { fieldId: '6', missing: undefined }));
    expect(url.searchParams.has('missing')).toBe(false);
  });
});

describe('applyProjection', () => {
  const response = {
    Result: {
      Items: [
        {
          DisplayString: 'All',
          Id: 1,
          State: 2,
          LeafItem: false,
          Noise: 'x',
          Children: [
            { DisplayString: 'JUL - 2026', Id: 15, State: 0, LeafItem: true, Noise: 'x', Children: [] },
            { DisplayString: 'AUG - 2026', Id: 16, State: 1, LeafItem: true, Noise: 'x', Children: [] },
          ],
        },
      ],
    },
  };

  test('flattens a tree into one list, keeping the selectable parent', () => {
    expect(
      applyProjection(response, {
        path: 'Result.Items',
        fields: { name: 'DisplayString', id: 'Id', state: 'State' },
        flattenChildren: 'Children',
      }),
    ).toEqual([
      { name: 'All', id: 1, state: 2 },
      { name: 'JUL - 2026', id: 15, state: 0 },
      { name: 'AUG - 2026', id: 16, state: 1 },
    ]);
  });

  test('drops unlisted fields', () => {
    const [first] = applyProjection(response, {
      path: 'Result.Items',
      fields: { name: 'DisplayString' },
      flattenChildren: 'Children',
    }) as Array<Record<string, unknown>>;
    expect(Object.keys(first as object)).toEqual(['name']);
  });

  test('indexes arrays on a numeric path segment', () => {
    expect(applyProjection(response, { path: 'Result.Items.0.Children.1.DisplayString' })).toBe('AUG - 2026');
  });

  test('returns matched values unchanged when no fields are given', () => {
    const items = applyProjection(response, { path: 'Result.Items.0.Children' }) as unknown[];
    expect(items).toHaveLength(2);
    expect((items[0] as Record<string, unknown>).Noise).toBe('x');
  });

  test('returns null when the path does not resolve, as on an errored response', () => {
    expect(
      applyProjection(
        { Result: null, Errors: [{ MessageIdName: 'PftTokenMissing' }] },
        {
          path: 'Result.PivotFilterItemsList.PivotFilterItems',
          flattenChildren: 'PivotFilterItems',
        },
      ),
    ).toBeNull();
  });

  test('maps a missing source key to undefined rather than failing', () => {
    expect(
      applyProjection(response, { path: 'Result.Items.0', fields: { name: 'DisplayString', gone: 'NoSuchKey' } }),
    ).toEqual({ name: 'All', gone: undefined });
  });
});
