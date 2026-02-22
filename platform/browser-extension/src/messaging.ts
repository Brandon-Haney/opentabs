import type { InternalMessage, SpConnectionStateMessage, SpRelayMessage } from './extension-messages.js';

/** Messages that can be forwarded to the side panel */
type SidePanelMessage = SpConnectionStateMessage | SpRelayMessage;

/** Send a JSON-RPC message to the MCP server via offscreen WebSocket */
export const sendToServer = (data: unknown): void => {
  const method = (data as { method?: string }).method ?? 'unknown';
  chrome.runtime.sendMessage({ type: 'ws:send', data } satisfies InternalMessage).catch((err: unknown) => {
    console.warn(`[opentabs] sendToServer failed for "${method}":`, err);
  });
};

/** Forward a message to the side panel (fire-and-forget) */
export const forwardToSidePanel = (message: SidePanelMessage): void => {
  const type = message.type;
  chrome.runtime.sendMessage(message).catch((err: unknown) => {
    console.warn(`[opentabs] forwardToSidePanel failed for "${type}":`, err);
  });
};
