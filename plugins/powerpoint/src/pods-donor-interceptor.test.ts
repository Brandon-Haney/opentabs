import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_REPLAY_DEPTH_GLOBAL,
  installPodsDonorInterceptor,
  PODS_DONOR_GLOBAL,
  PODS_HEAD_SENTINEL,
  PODS_LAST_WRITE_SENTINEL,
  type PodsDonor,
} from './pods-donor-interceptor.js';

const PODS_URL = 'https://usc-powerpoint.officeapps.live.com/pods/PowerPoint.ashx?Op=Edit';

const pollBody = (head: string): string => JSON.stringify({ Mode: 4, srs: [[2, { ExpectedLatestRevisionId: head }]] });
const writeBody = JSON.stringify({ Mode: 4, srs: [[3, { Revisions: [] }]] });

interface TestGlobals {
  [PODS_DONOR_GLOBAL]?: PodsDonor;
  [BRIDGE_REPLAY_DEPTH_GLOBAL]?: number;
}
const g = globalThis as unknown as TestGlobals;

/**
 * Install the interceptor onto fresh fetch/XHR fakes. Both are created per
 * install: the idempotency markers live on the patched function/constructor, so
 * reusing a fake across installs would keep the first install's closure state
 * (head, last write) alive into the next test.
 */
const install = () => {
  const origFetch = vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 }));
  const FakeXhr = class {
    open(_method: string, _url: string | URL): void {}
    setRequestHeader(_name: string, _value: string): void {}
    send(_body?: unknown): void {}
  };
  vi.stubGlobal('fetch', origFetch);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  installPodsDonorInterceptor({ info: () => {} });
  return origFetch;
};

const readSentinel = async (marker: string): Promise<unknown> => {
  const response = await globalThis.fetch(`https://opentabs.invalid/${marker}`);
  return response.json();
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete g[PODS_DONOR_GLOBAL];
  delete g[BRIDGE_REPLAY_DEPTH_GLOBAL];
});

describe('installPodsDonorInterceptor', () => {
  it('stashes the freshest pods POST as the frame donor and serves its head via the sentinel', async () => {
    const origFetch = install();

    await globalThis.fetch(PODS_URL, {
      method: 'POST',
      headers: { 'X-AccessToken': 'tok' },
      body: pollBody('aaa|7'),
    });

    expect(g[PODS_DONOR_GLOBAL]).toMatchObject({
      url: PODS_URL,
      method: 'POST',
      headers: { 'X-AccessToken': 'tok' },
      body: pollBody('aaa|7'),
    });
    expect(origFetch).toHaveBeenCalledTimes(1);

    // The sentinel answers locally — no network round trip.
    await expect(readSentinel(PODS_HEAD_SENTINEL)).resolves.toMatchObject({ head: 'aaa|7' });
    expect(origFetch).toHaveBeenCalledTimes(1);
  });

  it('skips capture entirely while a bridge replay is in flight', async () => {
    const origFetch = install();

    g[BRIDGE_REPLAY_DEPTH_GLOBAL] = 1;
    await globalThis.fetch(PODS_URL, { method: 'POST', body: writeBody });

    // The replayed request still reaches the network, but is never re-captured
    // as the donor — the self-poisoning failure this guard exists to prevent.
    expect(origFetch).toHaveBeenCalledTimes(1);
    expect(g[PODS_DONOR_GLOBAL]).toBeUndefined();
    await expect(readSentinel(PODS_HEAD_SENTINEL)).resolves.toBeNull();
    await expect(readSentinel(PODS_LAST_WRITE_SENTINEL)).resolves.toBeNull();

    // Capture resumes as soon as the replay finishes.
    g[BRIDGE_REPLAY_DEPTH_GLOBAL] = 0;
    await globalThis.fetch(PODS_URL, { method: 'POST', body: pollBody('bbb|2') });
    expect(g[PODS_DONOR_GLOBAL]).toMatchObject({ body: pollBody('bbb|2') });
    await expect(readSentinel(PODS_HEAD_SENTINEL)).resolves.toMatchObject({ head: 'bbb|2' });
  });

  it('retains the last type-3 write while later polls replace the donor', async () => {
    install();

    await globalThis.fetch(PODS_URL, { method: 'POST', body: writeBody });
    await globalThis.fetch(PODS_URL, { method: 'POST', body: pollBody('ccc|1') });

    expect(g[PODS_DONOR_GLOBAL]).toMatchObject({ body: pollBody('ccc|1') });
    await expect(readSentinel(PODS_LAST_WRITE_SENTINEL)).resolves.toMatchObject({ body: writeBody });
  });

  it('captures via the XHR path and honours the replay guard there too', () => {
    install();
    const Xhr = globalThis.XMLHttpRequest;

    const first = new Xhr();
    first.open('POST', PODS_URL);
    first.setRequestHeader('X-Key', 'k');
    first.send(pollBody('ddd|4'));
    expect(g[PODS_DONOR_GLOBAL]).toMatchObject({ headers: { 'X-Key': 'k' }, body: pollBody('ddd|4') });

    g[BRIDGE_REPLAY_DEPTH_GLOBAL] = 1;
    const second = new Xhr();
    second.open('POST', PODS_URL);
    second.send(pollBody('eee|5'));
    expect(g[PODS_DONOR_GLOBAL]).toMatchObject({ body: pollBody('ddd|4') });
  });

  it('ignores non-pods URLs and non-POST methods', async () => {
    install();

    await globalThis.fetch('https://usc-powerpoint.officeapps.live.com/other', {
      method: 'POST',
      body: pollBody('fff|1'),
    });
    await globalThis.fetch(PODS_URL, { method: 'GET' });

    expect(g[PODS_DONOR_GLOBAL]).toBeUndefined();
  });
});
