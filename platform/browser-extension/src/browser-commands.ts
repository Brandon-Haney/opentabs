import { SCRIPT_TIMEOUT_MS } from './constants.js';
import { sendToServer } from './messaging.js';
import { isBlockedUrlScheme } from '@opentabs-dev/shared';

export const handleBrowserListTabs = async (id: string | number): Promise<void> => {
  try {
    const tabs = await chrome.tabs.query({});
    const result = tabs.map(tab => ({
      id: tab.id,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: tab.active,
      windowId: tab.windowId,
    }));
    sendToServer({ jsonrpc: '2.0', result, id });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};

export const handleBrowserOpenTab = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const url = params.url;
    if (typeof url !== 'string') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid url parameter' }, id });
      return;
    }
    if (isBlockedUrlScheme(url)) {
      sendToServer({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: 'URL scheme not allowed (javascript:, data:, file:, chrome:, blob: are blocked)',
        },
        id,
      });
      return;
    }
    const tab = await chrome.tabs.create({ url });
    sendToServer({
      jsonrpc: '2.0',
      result: { id: tab.id, title: tab.title ?? '', url: tab.url ?? url, windowId: tab.windowId },
      id,
    });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};

export const handleBrowserCloseTab = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid tabId parameter' }, id });
      return;
    }
    await chrome.tabs.remove(tabId);
    sendToServer({ jsonrpc: '2.0', result: { ok: true }, id });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};

export const handleBrowserNavigateTab = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const tabId = params.tabId;
    const url = params.url;
    if (typeof tabId !== 'number') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid tabId parameter' }, id });
      return;
    }
    if (typeof url !== 'string') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid url parameter' }, id });
      return;
    }
    if (isBlockedUrlScheme(url)) {
      sendToServer({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: 'URL scheme not allowed (javascript:, data:, file:, chrome:, blob: are blocked)',
        },
        id,
      });
      return;
    }
    const tab = await chrome.tabs.update(tabId, { url });
    sendToServer({
      jsonrpc: '2.0',
      result: { id: tab?.id ?? tabId, title: tab?.title ?? '', url: tab?.url ?? url },
      id,
    });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};

export const handleBrowserFocusTab = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid tabId parameter' }, id });
      return;
    }
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab) {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: `Tab ${tabId} not found` }, id });
      return;
    }
    await chrome.windows.update(tab.windowId, { focused: true });
    sendToServer({
      jsonrpc: '2.0',
      result: { id: tab.id, title: tab.title ?? '', url: tab.url ?? '', active: true },
      id,
    });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};

export const handleBrowserGetTabInfo = async (params: Record<string, unknown>, id: string | number): Promise<void> => {
  try {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid tabId parameter' }, id });
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    sendToServer({
      jsonrpc: '2.0',
      result: {
        id: tab.id,
        title: tab.title ?? '',
        url: tab.url ?? '',
        status: tab.status ?? '',
        active: tab.active,
        windowId: tab.windowId,
        favIconUrl: tab.favIconUrl ?? '',
        incognito: tab.incognito,
      },
      id,
    });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};

export const handleBrowserExecuteScript = async (
  params: Record<string, unknown>,
  id: string | number,
): Promise<void> => {
  try {
    const tabId = params.tabId;
    if (typeof tabId !== 'number') {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid tabId parameter' }, id });
      return;
    }
    const execFile = params.execFile;
    if (typeof execFile !== 'string' || execFile.length === 0) {
      sendToServer({ jsonrpc: '2.0', error: { code: -32602, message: 'Missing or invalid execFile parameter' }, id });
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Step 1: Inject the exec file into the tab's MAIN world (bypasses page CSP)
    const injectPromise = (async () => {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: [`adapters/${execFile}`],
      });

      // Step 2: Read the result. For sync code, __lastExecResult is set
      // immediately by the wrapper. For async code (Promises), the wrapper
      // sets __lastExecAsync=true and resolves __lastExecResult when the
      // Promise settles. Poll until the result is available.
      const maxAsyncWait = 10_000;
      const pollInterval = 50;
      let elapsed = 0;

      while (elapsed <= maxAsyncWait) {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | {
                  __lastExecResult?: { value?: unknown; error?: string };
                  __lastExecAsync?: boolean;
                }
              | undefined;
            if (!ot) return { pending: false, result: { error: '__openTabs not found' } };

            const result = ot.__lastExecResult;
            const isAsync = ot.__lastExecAsync === true;

            // Result available (sync or async resolved) — read and clean up
            if (result && ('value' in result || 'error' in result)) {
              const captured = { ...result };
              // undefined is dropped by structured cloning — normalize to null
              if (captured.value === undefined) captured.value = null;
              // Serialize non-primitive values
              if (captured.value !== null && typeof captured.value === 'object') {
                try {
                  const json = JSON.stringify(captured.value);
                  captured.value = json.length > 50_000 ? json.slice(0, 50_000) + '... (truncated)' : JSON.parse(json);
                } catch {
                  captured.value = String(captured.value);
                }
              }
              // Clean up globals
              delete ot.__lastExecResult;
              delete ot.__lastExecAsync;
              return { pending: false, result: captured };
            }

            // Async code hasn't resolved yet — keep polling
            if (isAsync) return { pending: true };

            // Sync code produced no __lastExecResult (should not happen)
            return { pending: false, result: { error: 'No result captured' } };
          },
        });

        const first = results[0] as { result?: { pending: boolean; result?: unknown } } | undefined;
        const data = first?.result;

        if (data && !data.pending) {
          return { value: data.result };
        }

        // Still pending — wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsed += pollInterval;
      }

      // Async timed out — clean up and report error
      await chrome.scripting
        .executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
            if (ot) {
              delete ot.__lastExecResult;
              delete ot.__lastExecAsync;
            }
          },
        })
        .catch(() => {});

      return { value: { error: `Async code did not resolve within ${maxAsyncWait}ms` } };
    })();

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`));
      }, SCRIPT_TIMEOUT_MS);
    });

    let result: unknown;
    try {
      result = await Promise.race([injectPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    sendToServer({ jsonrpc: '2.0', result, id });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};
