import { getConnectionState, fetchConfigState, handleServerResponse, rejectAllPending } from './bridge.js';
import { DisconnectedState, EmptyState, LoadingState } from './components/EmptyStates.js';
import { Footer } from './components/Footer.js';
import { Header } from './components/Header.js';
import { PluginList } from './components/PluginList.js';
import { VersionMismatchBanner } from './components/VersionMismatchBanner.js';
import { VALID_PLUGIN_NAME } from '../constants.js';
import { SIDE_PANEL_PROTOCOL_VERSION } from '@opentabs-dev/shared';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { PluginState } from './bridge.js';
import type { InternalMessage } from '../types.js';
import type { TabState } from '@opentabs-dev/shared';

const validTabStates: ReadonlySet<string> = new Set<TabState>(['closed', 'unavailable', 'ready']);

const App = () => {
  const [connected, setConnected] = useState(false);
  const [plugins, setPlugins] = useState<PluginState[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTools, setActiveTools] = useState<Set<string>>(new Set());
  const [versionMismatch, setVersionMismatch] = useState(false);

  const lastFetchRef = useRef(0);
  /** Buffer tab.stateChanged notifications that arrive before fetchConfigState resolves. */
  const pendingTabStates = useRef<Map<string, TabState>>(new Map());

  /** Refs for sp:getState handler — reads latest values without adding useEffect dependencies */
  const connectedRef = useRef(connected);
  const loadingRef = useRef(loading);
  const pluginsRef = useRef(plugins);

  useEffect(() => {
    connectedRef.current = connected;
    loadingRef.current = loading;
    pluginsRef.current = plugins;
  });

  const loadPlugins = useCallback(() => {
    const now = Date.now();
    if (now - lastFetchRef.current < 200) return;
    lastFetchRef.current = now;
    fetchConfigState()
      .then(result => {
        let updatedPlugins = result.plugins;
        if (pendingTabStates.current.size > 0) {
          updatedPlugins = updatedPlugins.map(p => {
            const buffered = pendingTabStates.current.get(p.name);
            return buffered ? { ...p, tabState: buffered } : p;
          });
          pendingTabStates.current.clear();
        }
        setPlugins(updatedPlugins);
        if (result.protocolVersion !== undefined && result.protocolVersion !== SIDE_PANEL_PROTOCOL_VERSION) {
          setVersionMismatch(true);
        } else if (result.protocolVersion !== undefined) {
          setVersionMismatch(false);
        }
      })
      .catch(() => {
        // Server may not be ready yet
      });
  }, []);

  useEffect(() => {
    void getConnectionState().then(isConnected => {
      setConnected(isConnected);
      if (isConnected) {
        loadPlugins();
      }
      setLoading(false);
    });

    /** Process tab state and tool invocation notifications from the server. */
    const handleNotification = (data: Record<string, unknown>): void => {
      // tab.stateChanged notification
      if (data.method === 'tab.stateChanged' && data.params) {
        const params = data.params as Record<string, unknown>;
        if (
          typeof params.plugin === 'string' &&
          typeof params.state === 'string' &&
          validTabStates.has(params.state) &&
          VALID_PLUGIN_NAME.test(params.plugin)
        ) {
          const pluginName = params.plugin;
          const newState = params.state as TabState;
          setPlugins(prev => {
            if (prev.length === 0) {
              pendingTabStates.current.set(pluginName, newState);
              return prev;
            }
            return prev.map(p => (p.name === pluginName ? { ...p, tabState: newState } : p));
          });
        }
      }

      // tool.invocationStart notification
      if (data.method === 'tool.invocationStart' && data.params) {
        const params = data.params as Record<string, unknown>;
        if (
          typeof params.plugin === 'string' &&
          typeof params.tool === 'string' &&
          VALID_PLUGIN_NAME.test(params.plugin)
        ) {
          const toolKey = `${params.plugin}:${params.tool}`;
          setActiveTools(prev => new Set(prev).add(toolKey));
        }
      }

      // tool.invocationEnd notification
      if (data.method === 'tool.invocationEnd' && data.params) {
        const params = data.params as Record<string, unknown>;
        if (
          typeof params.plugin === 'string' &&
          typeof params.tool === 'string' &&
          VALID_PLUGIN_NAME.test(params.plugin)
        ) {
          const toolKey = `${params.plugin}:${params.tool}`;
          setActiveTools(prev => {
            const next = new Set(prev);
            next.delete(toolKey);
            return next;
          });
        }
      }
    };

    const listener = (
      message: InternalMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | undefined => {
      if (message.type === 'sp:getState') {
        const rootEl = document.getElementById('root');
        const html = rootEl ? rootEl.innerHTML.slice(0, 50000) : '';
        const currentPlugins = pluginsRef.current;
        sendResponse({
          state: {
            connected: connectedRef.current,
            loading: loadingRef.current,
            pluginCount: currentPlugins.length,
            plugins: currentPlugins.map(p => ({ name: p.name, tabState: p.tabState })),
          },
          html,
        });
        return true;
      }

      if (message.type === 'sp:connectionState') {
        const isConnected = message.data.connected;
        setConnected(isConnected);
        if (isConnected) {
          loadPlugins();
        } else {
          setPlugins([]);
          setActiveTools(new Set());
          setVersionMismatch(false);
          rejectAllPending();
        }
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === 'sp:serverMessage') {
        const data = message.data;

        // Route responses to the bridge's pending-request map (matched by ID)
        if (handleServerResponse(data)) {
          sendResponse({ ok: true });
          return true;
        }

        // plugins.changed notification — refetch the full plugin list
        if (data.method === 'plugins.changed') {
          loadPlugins();
          sendResponse({ ok: true });
          return true;
        }

        handleNotification(data);
        sendResponse({ ok: true });
        return true;
      }

      // Fallback: ws:message is broadcast by the offscreen document to all
      // extension contexts. When the side panel is opened as a regular
      // extension page (not via chrome.sidePanel.open), the background's
      // forwardToSidePanel may not reliably deliver sp:serverMessage.
      // Handling ws:message directly ensures notifications always arrive.
      if (message.type === 'ws:message') {
        const wsData = message.data as Record<string, unknown> | undefined;
        if (wsData?.method === 'sync.full') {
          // The MCP server already has plugin data when it sends sync.full,
          // so config.getState can be called immediately — no delay needed.
          loadPlugins();
        }
        return false;
      }

      // Not a side-panel message — don't call sendResponse, return false
      return false;
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [loadPlugins]);

  return (
    <div className="flex min-h-screen flex-col text-gray-200">
      <Header connected={connected} />
      {versionMismatch && <VersionMismatchBanner />}
      <main className="flex-1 px-3 py-2">
        {loading ? (
          <LoadingState />
        ) : !connected ? (
          <DisconnectedState />
        ) : plugins.length === 0 ? (
          <EmptyState />
        ) : (
          <PluginList plugins={plugins} activeTools={activeTools} setPlugins={setPlugins} />
        )}
      </main>
      <Footer />
    </div>
  );
};

export { App };
