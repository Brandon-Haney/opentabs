import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LAST_SEEN_URLS_KEY } from './constants.js';
import { _resetForTesting, getLastSeenUrl, loadLastSeenUrlsFromStorage, setLastSeenUrl } from './last-seen-urls.js';

// ---------------------------------------------------------------------------
// In-memory mock of chrome.storage.local
// ---------------------------------------------------------------------------

let store: Record<string, unknown> = {};

const mockChromeStorage = {
  get: vi.fn((key: string) => Promise.resolve({ [key]: store[key] })),
  set: vi.fn((items: Record<string, unknown>) => {
    Object.assign(store, items);
    return Promise.resolve();
  }),
};

(globalThis as Record<string, unknown>).chrome = {
  storage: { local: mockChromeStorage },
};

beforeEach(() => {
  store = {};
  _resetForTesting();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getLastSeenUrl', () => {
  test('returns undefined when no URL has been set', async () => {
    const url = await getLastSeenUrl('slack');
    expect(url).toBeUndefined();
  });
});

describe('setLastSeenUrl + getLastSeenUrl', () => {
  test('round-trip: set then get returns the URL', async () => {
    await setLastSeenUrl('slack', 'https://app.slack.com/client/T123');
    const url = await getLastSeenUrl('slack');
    expect(url).toBe('https://app.slack.com/client/T123');
  });

  test('different plugins have independent URLs', async () => {
    await setLastSeenUrl('slack', 'https://app.slack.com');
    await setLastSeenUrl('discord', 'https://discord.com/channels');
    expect(await getLastSeenUrl('slack')).toBe('https://app.slack.com');
    expect(await getLastSeenUrl('discord')).toBe('https://discord.com/channels');
  });

  test('overwrites previous URL for the same plugin', async () => {
    await setLastSeenUrl('slack', 'https://app.slack.com/old');
    await setLastSeenUrl('slack', 'https://app.slack.com/new');
    expect(await getLastSeenUrl('slack')).toBe('https://app.slack.com/new');
  });

  test('no-op when URL is unchanged (does not write to storage)', async () => {
    await setLastSeenUrl('slack', 'https://app.slack.com');
    const callsBefore = mockChromeStorage.set.mock.calls.length;
    await setLastSeenUrl('slack', 'https://app.slack.com');
    expect(mockChromeStorage.set.mock.calls.length).toBe(callsBefore);
  });

  test('persists to chrome.storage.local', async () => {
    await setLastSeenUrl('slack', 'https://app.slack.com');
    const stored = store[LAST_SEEN_URLS_KEY] as Record<string, string>;
    expect(stored.slack).toBe('https://app.slack.com');
  });
});

describe('loadLastSeenUrlsFromStorage', () => {
  test('restores cache from chrome.storage.local', async () => {
    store[LAST_SEEN_URLS_KEY] = { jira: 'https://myteam.atlassian.net/browse' };
    await loadLastSeenUrlsFromStorage();
    expect(await getLastSeenUrl('jira')).toBe('https://myteam.atlassian.net/browse');
  });

  test('reload after set preserves data through storage round-trip', async () => {
    await setLastSeenUrl('confluence', 'https://myteam.atlassian.net/wiki');
    _resetForTesting();
    await loadLastSeenUrlsFromStorage();
    expect(await getLastSeenUrl('confluence')).toBe('https://myteam.atlassian.net/wiki');
  });

  test('ignores non-object values in storage', async () => {
    store[LAST_SEEN_URLS_KEY] = 'not-an-object';
    await loadLastSeenUrlsFromStorage();
    expect(await getLastSeenUrl('anything')).toBeUndefined();
  });

  test('ignores array values in storage', async () => {
    store[LAST_SEEN_URLS_KEY] = ['https://example.com'];
    await loadLastSeenUrlsFromStorage();
    expect(await getLastSeenUrl('anything')).toBeUndefined();
  });
});

describe('closed state does not clear URL', () => {
  test('URL persists even after _resetForTesting + reload (simulating browser restart)', async () => {
    await setLastSeenUrl('slack', 'https://app.slack.com');
    // Simulate service worker restart: clear in-memory state, reload from storage
    _resetForTesting();
    await loadLastSeenUrlsFromStorage();
    expect(await getLastSeenUrl('slack')).toBe('https://app.slack.com');
  });
});
