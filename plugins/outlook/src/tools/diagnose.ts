import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { describeTokenSources } from '../auth-candidates.js';
import { probeResultSchema } from '../diagnostics.js';
import { AUTH_SLOTS, describeCachedAuth, describeRejectedAuth, PROBE_TARGETS, probeApiBase } from '../outlook-api.js';

/**
 * Read-only by construction: every value comes from the request layer's own
 * descriptors and one unretried probe per API base, none of which route through
 * `cascadeAuth`, so the tool never writes the auth cache or the cascade memory.
 */
export const diagnose = defineTool({
  name: 'diagnose',
  displayName: 'Diagnose Connection',
  description:
    'Diagnose Microsoft 365 connectivity for the Outlook tab without changing anything. Reports the page origin, which MSAL token sources yield candidate tokens (audience, expiry, and a short fingerprint — never the token itself), the token each API slot currently trusts, the candidates rejected this page session, and one unretried GET probe per API base (Graph, Outlook REST, OWS) with HTTP status, latency, the upstream request-id, and any Microsoft front-door error label; each probe is bounded to 10 seconds, so a hung base appears as a TimeoutError probe. Use it when other outlook tools return UPSTREAM_UNAVAILABLE, NETWORK_ERROR, authentication errors, or time out.',
  summary: 'Diagnose Microsoft API connectivity',
  icon: 'stethoscope',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    pageOrigin: z.string().describe('Origin of the Outlook tab the adapter runs in'),
    tokenSources: z
      .array(
        z.object({
          source: z.string().describe('MSAL cache layout the lookup read, e.g. "msal.v3"'),
          clientId: z.string().describe('MSAL client id the lookup was keyed by'),
          knownClient: z.boolean().describe('Whether the client id is one of Outlook’s own'),
          audienceHost: z.string().describe('API host the token’s scope claim grants'),
          present: z.boolean().describe('Whether the lookup yielded an unexpired token'),
          expiresInSec: z.number().int().nullable().describe('Seconds until the token expires; null when absent'),
          fingerprint: z.string().nullable().describe('4-hex-digit fingerprint of the token; null when absent'),
        }),
      )
      .describe('Every MSAL lookup the request layer performs, in cascade order, and the token each yielded'),
    cachedApiBase: z
      .string()
      .nullable()
      .describe(
        'API base the mail slot currently trusts (Graph or Outlook REST); null when no mail call has succeeded yet',
      ),
    cachedSlots: z
      .array(
        z.object({
          slot: z.enum(AUTH_SLOTS).describe('Cache slot'),
          apiBase: z.string().describe('API base of the trusted token'),
          fingerprint: z.string().describe('Fingerprint of the trusted token'),
          expiresAt: z.string().nullable().describe('ISO expiry of the trusted token when known'),
        }),
      )
      .describe('The token each cache slot currently trusts'),
    rejected: z
      .array(
        z.object({
          slot: z.enum(AUTH_SLOTS).describe('Cache slot the rejection applies to'),
          apiBase: z.string().describe('API base that answered 401/403'),
          fingerprint: z.string().describe('Fingerprint of the rejected token'),
          rejectedAt: z.string().describe('ISO time of the rejection'),
        }),
      )
      .describe(
        'Candidates remembered as rejected this page session; the cascade skips them until every candidate is rejected',
      ),
    probes: z
      .array(
        probeResultSchema.extend({
          tokenFingerprint: z
            .string()
            .nullable()
            .describe('Fingerprint of the token the probe was sent with; null when none was available'),
        }),
      )
      .describe('One unretried GET per API base, issued in parallel and each bounded to 10 seconds'),
  }),
  handle: async () => {
    const cachedSlots = describeCachedAuth();
    const probes = await Promise.all(PROBE_TARGETS.map(probeApiBase));
    return {
      pageOrigin: window.location.origin,
      tokenSources: describeTokenSources(),
      cachedApiBase: cachedSlots.find(entry => entry.slot === 'mail')?.apiBase ?? null,
      cachedSlots,
      rejected: describeRejectedAuth(),
      probes,
    };
  },
});
