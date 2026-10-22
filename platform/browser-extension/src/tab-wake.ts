import { TAB_WAKE_TIMEOUT_MS } from './constants.js';
import { isTabScriptable } from './tab-matching.js';
import { probeTabReadiness } from './tab-state.js';

/**
 * Wakes tabs Chrome has put to sleep so a tool call can run in them.
 *
 * Memory Saver discards background tabs, and a restored session leaves tabs
 * `unloaded` until they are opened. Such a tab still shows in the tab strip,
 * but it holds no page, so no adapter can run there and `executeScript`
 * rejects. Reloading it in the background brings the page back without
 * switching to it. Nothing is lost, because Chrome already threw the page away.
 *
 * A frozen tab is left alone. It still holds its page, possibly with unsaved
 * input, and a reload would discard it.
 */

const LOAD_POLL_INTERVAL_MS = 250;
const READY_POLL_INTERVAL_MS = 500;

/** Whether Chrome has unloaded the tab's page (discarded, or not yet restored). */
export const isTabAsleep = (tab: chrome.tabs.Tab): boolean => tab.discarded === true || tab.status === 'unloaded';

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Wakes in progress, by tab: concurrent calls to one sleeping tab share one reload. */
const wakesInFlight = new Map<number, Promise<void>>();

/**
 * Reload a sleeping tab and wait until its page has loaded and the plugin's
 * adapter reports ready. The adapter is injected by the extension's normal
 * page-load handling. Throws when the page does not load in time. A page that
 * loads but whose adapter is still not ready (the user is signed out) returns
 * normally, so the call that follows reports the adapter's own not-ready error.
 */
const reloadAndWait = async (tabId: number, pluginName: string, timeoutMs: number): Promise<void> => {
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    await delay(LOAD_POLL_INTERVAL_MS);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && isTabScriptable(tab)) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Tab ${tabId} was asleep (unloaded by Chrome) and did not finish reloading within ${Math.round(timeoutMs / 1000)}s`,
      );
    }
  }

  while (Date.now() < deadline) {
    if (await probeTabReadiness(tabId, pluginName).catch(() => false)) return;
    await delay(READY_POLL_INTERVAL_MS);
  }
};

/**
 * Make sure the tab holds a live page before a tool runs in it. A tab that is
 * awake returns at once. A sleeping tab is reloaded in the background, with
 * `onWaking` called first so the caller can tell the client why the call waits.
 */
export const wakeTabIfAsleep = async (
  tabId: number,
  pluginName: string,
  onWaking: (message: string) => void,
  timeoutMs: number = TAB_WAKE_TIMEOUT_MS,
): Promise<void> => {
  const tab = await chrome.tabs.get(tabId);
  if (!isTabAsleep(tab)) return;

  onWaking(`Reloading tab ${tabId}, which Chrome put to sleep to save memory`);
  let wake = wakesInFlight.get(tabId);
  if (!wake) {
    wake = reloadAndWait(tabId, pluginName, timeoutMs).finally(() => wakesInFlight.delete(tabId));
    wakesInFlight.set(tabId, wake);
  }
  await wake;
};
