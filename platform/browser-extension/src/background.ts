import { initBackgroundMessageHandlers, restoreWsConnectedState } from './background-message-handlers.js';
import { initConfirmationBadge } from './confirmation-badge.js';
import {
  buildWsUrl,
  KEEPALIVE_ALARM,
  KEEPALIVE_INTERVAL_MINUTES,
  PLUGINS_META_KEY,
  SERVER_PORT_KEY,
} from './constants.js';
import { injectPluginsIntoTab, reinjectStoredPlugins } from './iife-injection.js';
import { invalidatePluginCache } from './plugin-storage.js';
import { initSidePanelToggle } from './side-panel-toggle.js';
import { checkTabChanged, checkTabRemoved } from './tab-state.js';
import type { InternalMessage } from './extension-messages.js';

// --- Side panel toggle ---

initSidePanelToggle();

// --- WebSocket connection state ---

restoreWsConnectedState();

// --- Offscreen document management ---

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
      .then(() => checkTabChanged(tabId, changeInfo))
      .catch((err: unknown) => console.warn('[opentabs] tab injection failed:', err));
  } else if (changeInfo.url) {
    checkTabChanged(tabId, changeInfo).catch((err: unknown) => console.warn('[opentabs] tab state check failed:', err));
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  checkTabRemoved(tabId).catch((err: unknown) => console.warn('[opentabs] tab state check failed:', err));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // Chrome fires onReplaced when a prerendered page promotes to a visible tab.
  // Handle the removed tab as closed, then inject adapters into the replacement
  // and recompute state — same sequencing as the onUpdated status=complete path.
  checkTabRemoved(removedTabId).catch((err: unknown) =>
    console.warn('[opentabs] tab state check failed for replaced tab:', err),
  );
  chrome.tabs
    .get(addedTabId)
    .then(async tab => {
      if (tab.url) {
        await injectPluginsIntoTab(addedTabId, tab.url);
      }
      await checkTabChanged(addedTabId, { status: 'complete' });
    })
    .catch((err: unknown) => console.warn('[opentabs] tab replacement handling failed:', err));
});

// --- Message routing (offscreen, side panel, content scripts) ---

initBackgroundMessageHandlers();

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
  })().catch((err: unknown) => console.warn('[opentabs] onInstalled failed:', err));
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureOffscreenDocument();
    await setupKeepaliveAlarm();
    await reinjectStoredPlugins();
  })().catch((err: unknown) => console.warn('[opentabs] onStartup failed:', err));
});

ensureOffscreenDocument().catch((err: unknown) => console.warn('[opentabs] offscreen creation failed:', err));
setupKeepaliveAlarm().catch((err: unknown) => console.warn('[opentabs] keepalive alarm failed:', err));
reinjectStoredPlugins().catch((err: unknown) => console.warn('[opentabs] plugin reinjection failed:', err));
initConfirmationBadge();

// Relay MCP server URL changes to the offscreen document, and invalidate
// the plugin metadata cache when storage is modified from another context
// (e.g., DevTools, another extension page).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const portChange = changes[SERVER_PORT_KEY];
  if (
    typeof portChange?.newValue === 'number' &&
    Number.isInteger(portChange.newValue) &&
    portChange.newValue >= 1 &&
    portChange.newValue <= 65535
  ) {
    const newUrl = buildWsUrl(portChange.newValue);
    chrome.runtime.sendMessage({ type: 'ws:setUrl', url: newUrl } satisfies InternalMessage).catch(() => {
      // Offscreen may not be ready yet
    });
  }

  if (changes[PLUGINS_META_KEY]) {
    invalidatePluginCache();
  }
});
