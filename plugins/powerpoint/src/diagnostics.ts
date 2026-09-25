// ---------------------------------------------------------------------------
// Diagnostics — single-attempt upstream probes for a plugin's `diagnose` tool
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { readFrontDoorError, readUpstreamRequestId } from './microsoft-upstream.js';

export const probeResultSchema = z.object({
  name: z.string().describe('Probe name, e.g. "graph:/me"'),
  path: z
    .string()
    .describe(
      'Endpoint label the probe called, as a template such as "/shares/{shareId}/driveItem" — never an encoded id or a full URL',
    ),
  status: z.number().int().nullable().describe('HTTP status of the single attempt; null when no response arrived'),
  ok: z.boolean().describe('Whether the response status was 2xx'),
  latencyMs: z
    .number()
    .int()
    .nonnegative()
    .describe('Milliseconds until the response headers arrived or the request failed'),
  requestId: z
    .string()
    .nullable()
    .describe('Upstream request id (request-id, x-ms-request-id or client-request-id) when the response exposed one'),
  frontDoor: z
    .string()
    .nullable()
    .describe('Microsoft service front door error label (x-proxyerrorlabel) when the response carried one'),
  error: z.string().nullable().describe('"<ErrorName>: <message>" when the request threw instead of responding'),
});

export type ProbeResult = z.infer<typeof probeResultSchema>;

const elapsedMs = (startedAt: number): number => Math.max(0, Math.round(performance.now() - startedAt));

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Runs `run` exactly once — no retry, so the diagnosis shows raw upstream
 * behavior — and always resolves: a thrown error lands in `error` with
 * `status: null`. The response body is cancelled unread; only headers are
 * inspected. `path` is a caller-supplied label for the endpoint and must not
 * contain an encoded share id or a full URL, because probe results are
 * returned to the agent and recorded in the audit log.
 */
export const runProbe = async (name: string, path: string, run: () => Promise<Response>): Promise<ProbeResult> => {
  const startedAt = performance.now();
  try {
    const response = await run();
    const latencyMs = elapsedMs(startedAt);
    void response.body?.cancel().catch(() => undefined);
    return {
      name,
      path,
      status: response.status,
      ok: response.ok,
      latencyMs,
      requestId: readUpstreamRequestId(response.headers),
      frontDoor: readFrontDoorError(response)?.label ?? null,
      error: null,
    };
  } catch (error) {
    return {
      name,
      path,
      status: null,
      ok: false,
      latencyMs: elapsedMs(startedAt),
      requestId: null,
      frontDoor: null,
      error: describeError(error),
    };
  }
};

// ---------------------------------------------------------------------------
// MSAL cache storage mode
// ---------------------------------------------------------------------------

export const msalCacheSchema = z.object({
  state: z
    .enum(['plaintext', 'encrypted', 'mixed', 'empty'])
    .describe(
      'How MSAL stores its localStorage cache. "encrypted" means tokens are readable only inside MSAL, so reading them from the cache cannot work and a tab reload will not help; "plaintext" means cached tokens are readable; "mixed" means both kinds of entry are present; "empty" means no MSAL entries were found',
    ),
  plaintextAccessTokens: z.number().int().nonnegative().describe('MSAL access-token entries stored readable'),
  encryptedEntries: z
    .number()
    .int()
    .nonnegative()
    .describe('MSAL cache entries stored encrypted ({ id, nonce, data }), whatever credential they hold'),
});

export type MsalCacheDescription = z.infer<typeof msalCacheSchema>;

/** The slice of the Web Storage API the cache scan reads. */
type ReadableStorage = Pick<Storage, 'length' | 'key' | 'getItem'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Classifies MSAL's localStorage cache by the shape of each value, never its
 * key, so it holds across MSAL key layouts. A readable access token carries
 * `credentialType: "AccessToken"` and a string `secret`; an encrypted entry
 * (MSAL v4+ at-rest encryption) is `{ id, nonce, data }`. Returns counts only
 * — no key, value or token leaves this function — and never throws.
 */
export const describeMsalCache = (storage: ReadableStorage = globalThis.localStorage): MsalCacheDescription => {
  let plaintextAccessTokens = 0;
  let encryptedEntries = 0;
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      const raw = key === null ? null : storage.getItem(key);
      if (raw === null || raw[0] !== '{') continue;
      let entry: unknown;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      if (entry.credentialType === 'AccessToken' && typeof entry.secret === 'string') plaintextAccessTokens++;
      else if (typeof entry.id === 'string' && typeof entry.nonce === 'string' && typeof entry.data === 'string') {
        encryptedEntries++;
      }
    }
  } catch {
    // Storage access can throw under sandboxing; report what was counted.
  }
  const state =
    plaintextAccessTokens > 0 && encryptedEntries > 0
      ? 'mixed'
      : encryptedEntries > 0
        ? 'encrypted'
        : plaintextAccessTokens > 0
          ? 'plaintext'
          : 'empty';
  return { state, plaintextAccessTokens, encryptedEntries };
};
