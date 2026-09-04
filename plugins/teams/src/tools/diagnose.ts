import { defineTool, getCurrentUrl } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { probeResultSchema } from '../diagnostics.js';
import {
  describeTokenSources,
  detectEnvironment,
  getCachedChatServiceBase,
  getChatServiceBase,
  probeAuthz,
  probeChatService,
  probeSubstrate,
  TEAMS_TOKEN_SOURCES,
} from '../teams-api.js';

const tokenSourceSchema = z.object({
  source: z.enum(TEAMS_TOKEN_SOURCES).describe('Credential source the adapter reads'),
  present: z.boolean().describe('Whether a value is currently held for this source'),
  expiresInSec: z
    .number()
    .int()
    .nullable()
    .describe('Seconds until the credential expires (negative once expired); null when unknown or not a token'),
  audienceHost: z
    .string()
    .nullable()
    .describe('Host of the token audience, or the application id it names; null when the token carries none'),
  fingerprint: z
    .string()
    .nullable()
    .describe('Last four hex digits of an FNV-1a hash of the secret — tells tokens apart without revealing them'),
});

export const diagnose = defineTool({
  name: 'diagnose',
  displayName: 'Diagnose Connectivity',
  description:
    'Read-only connectivity check for the Teams plugin: reports the page origin, which auth tokens the pre-script has captured (presence, expiry and a fingerprint — never values), and a single un-retried probe each of the authsvc token exchange, the chat service and Substrate search with HTTP status, latency and upstream request-id. Use when Teams tools fail with UPSTREAM_UNAVAILABLE, NETWORK_ERROR or AUTH_ERROR to tell a Microsoft outage from a missing token.',
  summary: 'Check Teams connectivity and auth state',
  icon: 'stethoscope',
  group: 'People',
  input: z.object({}),
  output: z.object({
    pageOrigin: z.string().describe('Origin of the Teams tab the plugin runs in'),
    environment: z.enum(['consumer', 'enterprise']).describe('Teams flavor detected from the page hostname'),
    chatServiceOrigin: z.string().describe('Origin of the chat service base the plugin resolves requests to'),
    cachedApiBase: z
      .string()
      .nullable()
      .describe('Enterprise chat service base discovered from localStorage and held in memory; null when none'),
    tokenSources: z.array(tokenSourceSchema).describe('Every credential source, without secrets'),
    probes: z
      .array(probeResultSchema)
      .describe(
        'One single-attempt request per API base; the chat-service probe sends the Skype JWT the authsvc probe minted or one already held, never a second exchange',
      ),
  }),
  handle: async () => {
    // The authsvc probe settles first: the chat-service probe reuses the JWT it
    // minted (or one already held) rather than exchanging a second time.
    const [authsvc, substrate] = await Promise.all([probeAuthz(), probeSubstrate()]);
    const chatsvc = await probeChatService(authsvc);
    return {
      pageOrigin: new URL(getCurrentUrl()).origin,
      environment: detectEnvironment(),
      chatServiceOrigin: new URL(getChatServiceBase()).origin,
      cachedApiBase: getCachedChatServiceBase(),
      tokenSources: describeTokenSources(),
      probes: [authsvc, chatsvc, substrate],
    };
  },
});
