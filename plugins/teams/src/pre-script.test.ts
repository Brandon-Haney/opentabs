/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://teams.cloud.microsoft/"}
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const futureExpiry = (): string => String(Math.floor(Date.now() / 1000) + 3600);

/** An MSAL access-token cache entry as MSAL stores it in plaintext. */
const accessTokenEntry = (target: string, secret: string): string =>
  JSON.stringify({ credentialType: 'AccessToken', target, secret, expiresOn: futureExpiry() });

const SUBSTRATE_TARGET =
  'https://substrate.office.com/ActivityFeed-Internal.Read https://substrate.office.com/.default';
const SKYPE_TARGET = 'https://api.spaces.skype.com/Authorization.ReadWrite https://api.spaces.skype.com/.default';
const GRAPH_FILES_TARGET =
  'email openid profile https://graph.microsoft.com/ChatMember.Read https://graph.microsoft.com/Files.ReadWrite.All https://graph.microsoft.com/User.ReadBasic.All';
const GRAPH_OTHER_TARGET = 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/.default';

let set: ReturnType<typeof vi.fn>;

// The pre-script patches Storage.prototype.setItem once per realm behind a
// marker; each test restores the native method so every run patches afresh.
const nativeSetItem = Storage.prototype.setItem;
const restoreNativeSetItem = (): void => {
  Storage.prototype.setItem = nativeSetItem;
  delete (Storage.prototype as unknown as Record<string, unknown>).__opentabsTeamsSetItemPatched;
};

/** Run the pre-script the way the IIFE wrapper does: through `_preScriptRunner`. */
const runPreScript = async (): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('__openTabs', {
    _preScriptRunner: (fn: (ctx: unknown) => void) =>
      fn({ set, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }),
  });
  await import('./pre-script.js');
};

/** The value most recently stashed under `key`, or undefined. */
const lastSet = (key: string): unknown => set.mock.calls.filter(([k]) => k === key).at(-1)?.[1];

beforeEach(() => {
  set = vi.fn();
  restoreNativeSetItem();
  localStorage.clear();
});

afterEach(() => {
  restoreNativeSetItem();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('teams pre-script', () => {
  test('captures tokens already in localStorage at document start', async () => {
    localStorage.setItem('msal.2|substrate', accessTokenEntry(SUBSTRATE_TARGET, 'substrate-at-load'));

    await runPreScript();

    expect(lastSet('substrateToken')).toMatchObject({ secret: 'substrate-at-load' });
  });

  test("captures a token this document's MSAL writes after start", async () => {
    await runPreScript();

    localStorage.setItem('msal.2|skype', accessTokenEntry(SKYPE_TARGET, 'skype-written-here'));

    expect(lastSet('enterpriseToken')).toMatchObject({ secret: 'skype-written-here' });
  });

  test('captures a token another same-origin document writes, reported as a storage event', async () => {
    await runPreScript();

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'msal.2|substrate',
        newValue: accessTokenEntry(SUBSTRATE_TARGET, 'substrate-from-other-tab'),
        storageArea: localStorage,
      }),
    );

    expect(lastSet('substrateToken')).toMatchObject({ secret: 'substrate-from-other-tab' });
  });

  test('captures the Graph token that can write files, and no other Graph token', async () => {
    localStorage.setItem('msal.2|graph-other', accessTokenEntry(GRAPH_OTHER_TARGET, 'graph-user-read'));
    localStorage.setItem('msal.2|graph-files', accessTokenEntry(GRAPH_FILES_TARGET, 'graph-files'));

    await runPreScript();

    expect(set.mock.calls.filter(([k]) => k === 'graphToken')).toHaveLength(1);
    expect(lastSet('graphToken')).toMatchObject({ secret: 'graph-files' });
  });

  test('ignores storage events for sessionStorage and for removed entries', async () => {
    await runPreScript();

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'msal.2|substrate',
        newValue: accessTokenEntry(SUBSTRATE_TARGET, 'session-scoped'),
        storageArea: sessionStorage,
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'msal.2|substrate', newValue: null, storageArea: localStorage }),
    );

    expect(lastSet('substrateToken')).toBeUndefined();
  });
});
