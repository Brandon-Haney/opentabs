import { bgLogCollector } from './bg-log-state.js';
import { KEEPALIVE_ALARM, KEEPALIVE_INTERVAL_MINUTES, PLUGINS_META_KEY, WS_CONNECTED_KEY } from './constants.js';
import { injectPluginsIntoTab, reinjectStoredPlugins } from './iife-injection.js';
import { handleServerMessage } from './message-router.js';
import { forwardToSidePanel, sendToServer } from './messaging.js';
import { invalidatePluginCache } from './plugin-storage.js';
import { checkTabStateChanges, clearTabStateCache, sendTabSyncAll } from './tab-state.js';
import type { InternalMessage } from './types.js';

/**
 * In-memory cache of wsConnected. Authoritative state is in chrome.storage.session
 * so it survives MV3 service worker suspension. This cache avoids async reads
 * on every message handler invocation.
 */
let wsConnected = false;

/** Restore wsConnected from chrome.storage.session on service worker wake */
chrome.storage.session
  .get(WS_CONNECTED_KEY)
  .then(data => {
    if (typeof data[WS_CONNECTED_KEY] === 'boolean') {
      wsConnected = data[WS_CONNECTED_KEY];
    }
  })
  .catch(() => {
    // storage.session may not be available in all contexts
  });

/** Persist wsConnected to chrome.storage.session */
const persistWsConnected = (connected: boolean): void => {
  wsConnected = connected;
  chrome.storage.session.set({ [WS_CONNECTED_KEY]: connected }).catch(() => {
    // Best-effort persistence
  });
};

let creatingOffscreen: Promise<void> | null = null;

const ensureOffscreenDocument = async (): Promise<void> => {
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    // Always attempt creation — chrome.runtime.getContexts() can return
    // stale references to a dying offscreen document immediately after
    // chrome.runtime.reload(), causing the check to pass even though
    // no live offscreen document exists. The createDocument call is
    // idempotent: if one already exists, it throws and we catch below.
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Maintain persistent WebSocket connection to MCP server',
      });
    } catch {
      // Already exists — expected when multiple callers race
      // (onInstalled, onStartup, top-level) or on normal startup
      // where the document survived service worker suspension.
    }
  })();

  await creatingOffscreen;
  creatingOffscreen = null;
};

const setupKeepaliveAlarm = async (): Promise<void> => {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    await chrome.alarms.create(KEEPALIVE_ALARM, {
      periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
    });
  }
};

// --- Tab event listeners ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Inject adapters before checking tab state so computePluginTabState
    // finds the adapter and can call isReady(). Without this sequencing,
    // the state check races with injection and often reports 'unavailable'
    // even when the adapter would pass isReady().
    injectPluginsIntoTab(tabId, tab.url)
      .then(() => checkTabStateChanges(tabId, changeInfo))
      .catch((err: unknown) => console.warn('[opentabs] tab injection failed:', err));
  } else if (changeInfo.url) {
    checkTabStateChanges(tabId, changeInfo).catch((err: unknown) =>
      console.warn('[opentabs] tab state check failed:', err),
    );
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  checkTabStateChanges(tabId, undefined, true).catch((err: unknown) =>
    console.warn('[opentabs] tab state check failed:', err),
  );
});

// --- Message routing (offscreen, side panel, content scripts) ---

chrome.runtime.onMessage.addListener((message: InternalMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'offscreen:getUrl': {
      (async () => {
        const stored: Record<string, unknown> = await chrome.storage.local
          .get('mcpServerUrl')
          .catch(() => ({}) as Record<string, unknown>);
        const baseWsUrl = typeof stored.mcpServerUrl === 'string' ? stored.mcpServerUrl : 'ws://localhost:9515/ws';

        const httpBase = baseWsUrl.replace(/^ws/, 'http').replace(/\/ws(\?.*)?$/, '');
        try {
          const res = await fetch(`${httpBase}/ws-info`, { signal: AbortSignal.timeout(3_000) });
          if (res.ok) {
            const wsInfo = (await res.json()) as { wsUrl?: string };
            if (typeof wsInfo.wsUrl === 'string' && wsInfo.wsUrl !== '') {
              sendResponse({ url: wsInfo.wsUrl });
              return;
            } else if (typeof wsInfo.wsUrl === 'string') {
              console.warn('[opentabs:background] /ws-info returned empty wsUrl, using fallback URL');
            }
          }
        } catch {
          // Server may not be running yet — fall back to unauthenticated URL
        }
        sendResponse({ url: baseWsUrl });
      })().catch(() => {
        sendResponse({ url: 'ws://localhost:9515/ws' });
      });
      return true;
    }

    case 'ws:state': {
      const wasConnected = wsConnected;
      const nowConnected = message.connected;
      persistWsConnected(nowConnected);
      forwardToSidePanel({ type: 'sp:connectionState', data: { connected: nowConnected } });
      if (nowConnected && !wasConnected) {
        sendTabSyncAll().catch((err: unknown) => console.warn('[opentabs] tab sync failed:', err));
      }
      if (!nowConnected && wasConnected) {
        clearTabStateCache();
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'ws:message': {
      handleServerMessage(message.data);
      sendResponse({ ok: true });
      return true;
    }

    case 'bg:send': {
      sendToServer(message.data);
      sendResponse({ ok: true });
      return true;
    }

    case 'bg:getConnectionState': {
      sendResponse({ connected: wsConnected });
      return true;
    }

    case 'bg:getLogs': {
      sendResponse({ entries: bgLogCollector.getEntries(message.options), stats: bgLogCollector.getStats() });
      return true;
    }

    // Messages handled by other listeners (offscreen, side panel) — not
    // processed here, but included for exhaustiveness so TypeScript flags
    // any new InternalMessage variant that isn't routed somewhere.
    case 'ws:send':
    case 'ws:getState':
    case 'ws:setUrl':
    case 'sp:getState':
    case 'sp:connectionState':
    case 'sp:serverMessage':
      return false;
  }
});

// --- Extension lifecycle ---

chrome.alarms.onAlarm.addListener(() => {
  // Keepalive tick: re-ensure the offscreen document exists so the WebSocket
  // connection recovers automatically if Chrome terminates it under memory pressure.
  ensureOffscreenDocument().catch((err: unknown) => console.warn('[opentabs] offscreen creation failed:', err));
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureOffscreenDocument();
    await setupKeepaliveAlarm();
    await reinjectStoredPlugins();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureOffscreenDocument();
    await setupKeepaliveAlarm();
    await reinjectStoredPlugins();
  })();
});

ensureOffscreenDocument().catch((err: unknown) => console.warn('[opentabs] offscreen creation failed:', err));
setupKeepaliveAlarm().catch((err: unknown) => console.warn('[opentabs] keepalive alarm failed:', err));
reinjectStoredPlugins().catch((err: unknown) => console.warn('[opentabs] plugin reinjection failed:', err));

// Relay MCP server URL changes to the offscreen document, and invalidate
// the plugin metadata cache when storage is modified from another context
// (e.g., DevTools, another extension page).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (typeof changes.mcpServerUrl?.newValue === 'string') {
    const newUrl = changes.mcpServerUrl.newValue;
    chrome.runtime.sendMessage({ type: 'ws:setUrl', url: newUrl } satisfies InternalMessage).catch(() => {
      // Offscreen may not be ready yet
    });
  }

  if (changes[PLUGINS_META_KEY]) {
    invalidatePluginCache();
  }
});
