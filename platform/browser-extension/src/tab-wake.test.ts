import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockProbeTabReadiness } = vi.hoisted(() => ({
  mockProbeTabReadiness: vi.fn<(tabId: number, pluginName: string) => Promise<boolean>>(),
}));

vi.mock('./tab-state.js', () => ({ probeTabReadiness: mockProbeTabReadiness }));

const mockTabsGet = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>();
const mockTabsReload = vi.fn<(tabId: number) => Promise<void>>().mockResolvedValue(undefined);

(globalThis as Record<string, unknown>).chrome = {
  tabs: { get: mockTabsGet, reload: mockTabsReload },
};

const { isTabAsleep, wakeTabIfAsleep } = await import('./tab-wake.js');

const tab = (fields: Partial<chrome.tabs.Tab>): chrome.tabs.Tab =>
  ({ id: 7, url: 'https://example.atlassian.net/browse/X-1', status: 'complete', ...fields }) as chrome.tabs.Tab;

const ASLEEP = tab({ discarded: true });
const LOADING = tab({ status: 'loading' });
const AWAKE = tab({});

beforeEach(() => {
  mockTabsGet.mockReset();
  mockTabsReload.mockClear();
  mockProbeTabReadiness.mockReset();
});

describe('isTabAsleep', () => {
  test('is true for a discarded tab and a tab not yet restored', () => {
    expect(isTabAsleep(tab({ discarded: true }))).toBe(true);
    expect(isTabAsleep(tab({ status: 'unloaded' }))).toBe(true);
  });

  test('is false for a live tab and for a frozen one, which still holds its page', () => {
    expect(isTabAsleep(AWAKE)).toBe(false);
    expect(isTabAsleep(tab({ frozen: true }))).toBe(false);
  });
});

describe('wakeTabIfAsleep', () => {
  test('leaves an awake tab alone', async () => {
    mockTabsGet.mockResolvedValue(AWAKE);
    const onWaking = vi.fn();
    await wakeTabIfAsleep(7, 'jira', onWaking);
    expect(mockTabsReload).not.toHaveBeenCalled();
    expect(onWaking).not.toHaveBeenCalled();
  });

  test('reloads a sleeping tab and waits for the page and the adapter', async () => {
    mockTabsGet.mockResolvedValueOnce(ASLEEP).mockResolvedValueOnce(LOADING).mockResolvedValue(AWAKE);
    mockProbeTabReadiness.mockResolvedValueOnce(false).mockResolvedValue(true);
    const onWaking = vi.fn();

    await wakeTabIfAsleep(7, 'jira', onWaking);

    expect(onWaking).toHaveBeenCalledOnce();
    expect(mockTabsReload).toHaveBeenCalledWith(7);
    expect(mockProbeTabReadiness).toHaveBeenCalledTimes(2);
    expect(mockProbeTabReadiness).toHaveBeenCalledWith(7, 'jira');
  });

  test('shares one reload between concurrent calls to the same tab', async () => {
    mockTabsGet.mockResolvedValueOnce(ASLEEP).mockResolvedValueOnce(ASLEEP).mockResolvedValue(AWAKE);
    mockProbeTabReadiness.mockResolvedValue(true);

    await Promise.all([wakeTabIfAsleep(7, 'jira', vi.fn()), wakeTabIfAsleep(7, 'jira', vi.fn())]);

    expect(mockTabsReload).toHaveBeenCalledOnce();
  });

  test('returns once the page loads even if the adapter never reports ready', async () => {
    mockTabsGet.mockResolvedValueOnce(ASLEEP).mockResolvedValue(AWAKE);
    mockProbeTabReadiness.mockResolvedValue(false);

    await expect(wakeTabIfAsleep(7, 'jira', vi.fn(), 1_000)).resolves.toBeUndefined();
  });

  test('throws when the page does not finish loading in time', async () => {
    mockTabsGet.mockResolvedValueOnce(ASLEEP).mockResolvedValue(LOADING);

    await expect(wakeTabIfAsleep(7, 'jira', vi.fn(), 600)).rejects.toThrow(
      'Tab 7 was asleep (unloaded by Chrome) and did not finish reloading within 1s',
    );
  });
});
