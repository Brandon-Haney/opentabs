import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).chrome = {
  tabs: { onRemoved: { addListener: () => {} } },
};

vi.mock('./pods-model.js', async importOriginal => {
  const mod = await importOriginal<typeof import('./pods-model.js')>();
  return { ...mod, readPodsModel: vi.fn() };
});
vi.mock('./pods-bridge.js', async importOriginal => {
  const mod = await importOriginal<typeof import('./pods-bridge.js')>();
  return { ...mod, runPodsWriteConfirmed: vi.fn() };
});

const { findErrorHint, PODS_ACTION_VERSION, runPodsAction } = await import('./pods-actions.js');
const { FrameBridgeValidationError } = await import('./frame-bridge-rpc.js');
const { readPodsModel } = await import('./pods-model.js');
const { runPodsWriteConfirmed } = await import('./pods-bridge.js');

import type { PodsBridgeResult, PodsWriteConfirmation } from './pods-bridge.js';
import type { PodsModel } from './pods-model.js';

const mockRead = vi.mocked(readPodsModel);
const mockWrite = vi.mocked(runPodsWriteConfirmed);

const REF_A = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{58}';
const REF_B = '{d55934be-57c9-4c97-8e07-bf34a0bb3f76}{59}';

/** A minimal live deck: root, one templatable slide, one paragraph with its run, one named shape. */
const model = (): PodsModel => ({
  totalObjects: 9,
  objects: [
    {
      classId: 393271,
      objectId: '23069e19-9218-5ae4-9815-d8ceaade97df|4',
      properties: [536889540, '{b3ab583c-77cd-428d-9371-02c2ea7c058b}{2}', 603986975, `${REF_A},${REF_B}`],
    },
    {
      classId: 393227,
      objectId: 'd55934be-57c9-4c97-8e07-bf34a0bb3f76|58',
      properties: [335562835, '2147483648', 335562836, '2147483656'],
    },
    {
      classId: 393230,
      objectId: 'p|1',
      properties: [469769250, 'Workstream', 603987475, '{e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082}{7}'],
    },
    {
      classId: 1179725,
      objectId: 'e6b8a11d-1fe8-49e2-b5d9-28e6e5a5d082|7',
      properties: [268442635, '22'],
    },
    { classId: 1074135132, objectId: 's|1', properties: [469780826, 'Title 1'] },
  ],
});

const baseParams = {
  tabId: 5,
  v: PODS_ACTION_VERSION,
  frameUrlIncludes: 'powerpoint.officeapps.live.com',
  donorGlobal: '__otbPptPodsDonor',
  headSentinel: '__otb_pods_head__',
  modelReadBody: '{"Mode":4,"srs":[[2,{}]]}',
};

const acceptedResult = (extra?: Partial<PodsBridgeResult>): PodsBridgeResult => ({
  frameId: 1,
  status: 200,
  ok: true,
  head: 'head|1',
  statusCode: 0,
  retries: 0,
  applied: true,
  ...extra,
});

beforeEach(() => {
  mockRead.mockReset();
  mockWrite.mockReset();
  mockRead.mockResolvedValue(model());
});

describe('runPodsAction', () => {
  it('rejects a directive newer than this engine with rebuild instructions', async () => {
    await expect(
      runPodsAction({ ...baseParams, v: PODS_ACTION_VERSION + 1, action: 'format_text', args: {} }),
    ).rejects.toThrow(/Rebuild the extension/);
  });

  it('rejects an unknown action by name, loudly', async () => {
    await expect(runPodsAction({ ...baseParams, action: 'reticulate_splines', args: {} })).rejects.toThrow(
      /no pods action "reticulate_splines"/,
    );
  });

  it('runs a read action against one model read and never touches the write path', async () => {
    const result = await runPodsAction({ ...baseParams, action: 'read_outline', args: {} });
    expect(result).toMatchObject({ action: 'read_outline', slideCount: 2, shapeTotal: 1 });
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('a dry run resolves and constructs but never writes', async () => {
    const result = await runPodsAction({ ...baseParams, action: 'add_slide', args: {}, dryRun: true });
    expect(result).toMatchObject({ action: 'add_slide', dryRun: true, slideCountBefore: 2 });
    expect((result as { body?: unknown }).body).toBeDefined();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('a write action passes the spec idempotency through and decorates the result with its summary', async () => {
    mockWrite.mockResolvedValue(acceptedResult());
    const result = await runPodsAction({ ...baseParams, action: 'delete_slide', args: { slideIndex: 1 } });
    expect(result).toMatchObject({
      action: 'delete_slide',
      applied: true,
      slideIndex: 1,
      removedRef: REF_A,
      slideCountBefore: 2,
    });
    const confirmation = mockWrite.mock.calls[0]?.[1] as PodsWriteConfirmation<PodsModel>;
    expect(confirmation.idempotent).toBe(false);
  });

  it('supplies the model-reported head as the bridge headSource, so a frozen sentinel is never load-bearing', async () => {
    mockRead.mockResolvedValue({ ...model(), latestRevisionId: 'model-head|7' });
    mockWrite.mockResolvedValue(acceptedResult());
    await runPodsAction({ ...baseParams, action: 'delete_slide', args: { slideIndex: 1 } });
    const bridgeParams = mockWrite.mock.calls[0]?.[0] as { headSource?: () => Promise<string | null> };
    expect(bridgeParams.headSource).toBeTypeOf('function');
    await expect(bridgeParams.headSource?.()).resolves.toBe('model-head|7');
  });

  it('invalid args are rejected by the action own parser before any read', async () => {
    await expect(runPodsAction({ ...baseParams, action: 'delete_slide', args: { slideIndex: 0 } })).rejects.toThrow(
      FrameBridgeValidationError,
    );
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('appends the plugin-supplied hint to a decoded failure', async () => {
    mockWrite.mockResolvedValue(
      acceptedResult({
        statusCode: 124,
        applied: false,
        serverError: { code: 157, source: 2 },
        failure: 'pods write rejected with StatusCode 124 (ServerError 157/2)',
      }),
    );
    const result = await runPodsAction({
      ...baseParams,
      action: 'format_text',
      args: { text: 'Workstream', bold: true },
      errorHints: { 'se:157/2': 'Reload the deck tab and retry.' },
    });
    expect((result as { failure?: string }).failure).toBe(
      'pods write rejected with StatusCode 124 (ServerError 157/2) Reload the deck tab and retry.',
    );
  });
});

describe('findErrorHint', () => {
  const result = acceptedResult({ statusCode: 124, serverError: { code: 157, source: 2 } });

  it('matches most-specific first: code/source, then code, then statusCode', () => {
    expect(findErrorHint({ 'se:157/2': 'exact', 'se:157': 'code', 'sc:124': 'status' }, result)).toBe('exact');
    expect(findErrorHint({ 'se:157': 'code', 'sc:124': 'status' }, result)).toBe('code');
    expect(findErrorHint({ 'sc:124': 'status' }, result)).toBe('status');
  });

  it('returns undefined with no hints or no match', () => {
    expect(findErrorHint(undefined, result)).toBeUndefined();
    expect(findErrorHint({ 'se:999': 'nope' }, result)).toBeUndefined();
  });
});
