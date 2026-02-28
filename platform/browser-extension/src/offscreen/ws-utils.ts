/**
 * Validate that a WebSocket URL from /ws-info has the expected origin.
 * Rejects URLs with a different host than the source or non-WebSocket protocols.
 */
export const isValidWsOrigin = (wsUrl: string, httpBase: string): boolean => {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      console.warn(`[opentabs:offscreen] Rejected wsUrl with invalid protocol: ${parsed.protocol}`);
      return false;
    }
    const source = new URL(httpBase);
    if (parsed.host !== source.host) {
      console.warn(
        `[opentabs:offscreen] Rejected wsUrl with mismatched host: ${parsed.host} (expected ${source.host})`,
      );
      return false;
    }
    if (parsed.pathname !== '/ws') {
      console.warn(`[opentabs:offscreen] Rejected wsUrl with invalid path: ${parsed.pathname}`);
      return false;
    }
    return true;
  } catch {
    console.warn('[opentabs:offscreen] Rejected wsUrl: failed to parse URL');
    return false;
  }
};

/** Convert a WebSocket URL to its HTTP base URL (e.g., ws://localhost:9515/ws → http://localhost:9515) */
export const wsToHttpBase = (wsUrl: string): string => wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');
