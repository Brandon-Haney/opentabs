import { VALID_PLUGIN_NAME } from '../../constants.js';
import { useCallback } from 'react';
import type { PluginState } from '../bridge.js';
import type { ConfirmationData } from '../components/ConfirmationDialog.js';
import type { TabState } from '@opentabs-dev/shared';

const validTabStates: ReadonlySet<string> = new Set<TabState>(['closed', 'unavailable', 'ready']);

interface UseServerNotificationsParams {
  setPlugins: React.Dispatch<React.SetStateAction<PluginState[]>>;
  setActiveTools: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPendingConfirmations: React.Dispatch<React.SetStateAction<ConfirmationData[]>>;
  pendingTabStates: React.RefObject<Map<string, TabState>>;
}

/**
 * Returns a stable callback that processes server notification messages
 * (confirmation.request, tab.stateChanged, tool.invocationStart, tool.invocationEnd).
 */
const useServerNotifications = ({
  setPlugins,
  setActiveTools,
  setPendingConfirmations,
  pendingTabStates,
}: UseServerNotificationsParams): ((data: Record<string, unknown>) => void) =>
  useCallback(
    (data: Record<string, unknown>): void => {
      if (data.method === 'confirmation.request' && data.params) {
        const params = data.params as Record<string, unknown>;
        if (typeof params.id === 'string' && typeof params.tool === 'string' && typeof params.timeoutMs === 'number') {
          const confirmation: ConfirmationData = {
            id: params.id,
            tool: params.tool,
            domain: typeof params.domain === 'string' ? params.domain : null,
            tabId: typeof params.tabId === 'number' ? params.tabId : undefined,
            paramsPreview: typeof params.paramsPreview === 'string' ? params.paramsPreview : '',
            timeoutMs: params.timeoutMs,
            receivedAt: Date.now(),
          };
          setPendingConfirmations(prev => [...prev, confirmation]);
          const removeDelay = params.timeoutMs + 1000;
          setTimeout(() => {
            setPendingConfirmations(prev => prev.filter(c => c.id !== confirmation.id));
          }, removeDelay);
        }
      }

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
    },
    [setPlugins, setActiveTools, setPendingConfirmations, pendingTabStates],
  );

export { useServerNotifications };
