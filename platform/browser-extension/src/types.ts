import type { TrustTier, WireToolDef } from '@opentabs-dev/shared';

// ---------------------------------------------------------------------------
// Internal Chrome extension message types — discriminated union
//
// All chrome.runtime.sendMessage calls between the background script,
// offscreen document, and side panel use these typed messages. Adding a
// new message type here gives exhaustiveness checking at every handler site.
// ---------------------------------------------------------------------------

/** Offscreen → Background: request the MCP server WebSocket URL */
export interface OffscreenGetUrlMessage {
  type: 'offscreen:getUrl';
}

/** Background → Offscreen: WebSocket connection state changed */
export interface WsStateMessage {
  type: 'ws:state';
  connected: boolean;
}

/** Background/Offscreen: relay a JSON-RPC message from the MCP server */
export interface WsDataMessage {
  type: 'ws:message';
  data: Record<string, unknown>;
}

/** Offscreen/Side panel → Background → Offscreen: send a JSON-RPC message to the MCP server */
export interface WsSendMessage {
  type: 'ws:send';
  data: unknown;
}

/** Background → Offscreen: query WebSocket connection state */
export interface WsGetStateMessage {
  type: 'ws:getState';
}

/** Background → Offscreen: change the MCP server WebSocket URL */
export interface WsSetUrlMessage {
  type: 'ws:setUrl';
  url: string;
}

/** Side panel → Background: send a JSON-RPC message to the MCP server */
export interface BgSendMessage {
  type: 'bg:send';
  data: unknown;
}

/** Side panel → Background: query WebSocket connection state */
export interface BgGetConnectionStateMessage {
  type: 'bg:getConnectionState';
}

/** Background → Offscreen: request log entries from the offscreen LogCollector */
export interface BgGetLogsMessage {
  type: 'bg:getLogs';
  options?: {
    level?: 'log' | 'warn' | 'error' | 'info';
    source?: 'background' | 'offscreen' | 'side-panel';
    since?: number;
    limit?: number;
  };
}

/** Background → Side panel: request current React state and rendered HTML */
export interface SpGetStateMessage {
  type: 'sp:getState';
}

/** Background → Side panel: WebSocket connection state update */
export interface SpConnectionStateMessage {
  type: 'sp:connectionState';
  data: { connected: boolean };
}

/** Background → Side panel: forwarded JSON-RPC message from the MCP server */
export interface SpRelayMessage {
  type: 'sp:serverMessage';
  data: Record<string, unknown>;
}

/** All internal message types flowing through chrome.runtime.sendMessage */
export type InternalMessage =
  | OffscreenGetUrlMessage
  | WsStateMessage
  | WsDataMessage
  | WsSendMessage
  | WsGetStateMessage
  | WsSetUrlMessage
  | BgSendMessage
  | BgGetConnectionStateMessage
  | BgGetLogsMessage
  | SpGetStateMessage
  | SpConnectionStateMessage
  | SpRelayMessage;

/** Lightweight plugin metadata stored in the `plugins_meta` index (no IIFE content) */
export interface PluginMeta {
  name: string;
  version: string;
  displayName?: string;
  urlPatterns: string[];
  trustTier: TrustTier;
  sourcePath?: string;
  adapterHash?: string;
  tools: WireToolDef[];
}
