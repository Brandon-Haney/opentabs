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
    const world = (params.world as string) === 'MAIN' ? 'MAIN' : 'ISOLATED';
    const returnExpression = typeof params.returnExpression === 'string' ? params.returnExpression : null;

    // MV3 CSP blocks eval/Function in content scripts. This tool returns
    // structured page inspection data via a pre-compiled function, with an
    // optional returnExpression for extracting specific DOM values using a
    // limited set of known accessors.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scriptPromise = chrome.scripting.executeScript({
      target: { tabId },
      world,
      func: (expr: string | null) => {
        const pageInfo = {
          title: document.title,
          url: window.location.href,
          origin: window.location.origin,
          readyState: document.readyState,
          characterSet: document.characterSet,
          contentType: document.contentType,
          cookieEnabled: navigator.cookieEnabled,
          documentElementHTML: document.documentElement.outerHTML.slice(0, 500),
        };

        if (!expr) return pageInfo;

        try {
          const roots: Record<string, unknown> = {
            document,
            window,
            location: window.location,
            navigator,
          };

          // Defense-in-depth: reject property names that could traverse
          // prototype chains (e.g., "constructor.constructor" → Function).
          // This is not a security boundary (results are serialized, not
          // executed), but prevents accidental exposure of internal objects.
          const blockedProps = new Set(['__proto__', 'constructor', 'prototype']);
          const maxDepth = 10;

          const parts = expr.split('.');
          if (parts.length > maxDepth + 1) {
            return { ...pageInfo, expression: expr, expressionError: `Expression too deep (max ${maxDepth} levels)` };
          }

          const rootKey = parts[0];
          if (!rootKey || !(rootKey in roots)) {
            return { ...pageInfo, expression: expr, expressionError: `Unknown root: ${rootKey ?? '(empty)'}` };
          }

          let current: unknown = roots[rootKey];
          for (let i = 1; i < parts.length; i++) {
            if (current === null || current === undefined) break;
            const part = parts[i];
            if (!part) break;
            if (blockedProps.has(part)) {
              return { ...pageInfo, expression: expr, expressionError: `Property "${part}" is not allowed` };
            }
            current = (current as Record<string, unknown>)[part];
          }

          let expressionValue: unknown;
          if (current === null || current === undefined || typeof current !== 'object') {
            expressionValue = current;
          } else {
            const str = JSON.stringify(current, null, 2);
            expressionValue = str.length > 2000 ? str.slice(0, 2000) + '... (truncated)' : JSON.parse(str);
          }

          return { ...pageInfo, expression: expr, expressionValue };
        } catch (e) {
          return { ...pageInfo, expression: expr, expressionError: e instanceof Error ? e.message : String(e) };
        }
      },
      args: [returnExpression],
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`));
      }, SCRIPT_TIMEOUT_MS);
    });

    let results: Awaited<typeof scriptPromise>;
    try {
      results = await Promise.race([scriptPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
    const result = results[0]?.result;
    sendToServer({ jsonrpc: '2.0', result: { value: result }, id });
  } catch (err) {
    sendToServer({
      jsonrpc: '2.0',
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      id,
    });
  }
};
