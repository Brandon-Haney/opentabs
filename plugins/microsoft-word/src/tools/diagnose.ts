import { defineTool, getCurrentUrl } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { probeResultSchema } from '../diagnostics.js';
import {
  activeTokenSource,
  describeDocumentContextSource,
  describePageKind,
  describeTokenSources,
  GRAPH_API_BASE,
  GRAPH_TOKEN_SOURCES,
  probeCurrentUser,
  probeSharedDocumentItem,
  readReloadMarker,
} from '../microsoft-word-api.js';

const tokenSourceSchema = z.object({
  source: z.enum(GRAPH_TOKEN_SOURCES).describe('Where the token comes from'),
  present: z.boolean().describe('Whether this source holds a token, live or expired'),
  expiresInSec: z.number().int().nullable().describe('Seconds until the token expires (negative once expired)'),
  audience: z.string().nullable().describe('Host of the token audience claim, or the raw claim when it is not a URL'),
  fingerprint: z.string().nullable().describe('Last 4 hex characters of the token FNV-1a hash — never the token'),
  capturedAgoSec: z.number().int().nullable().describe('Seconds since the pre-script captured the token'),
});

/**
 * Read-only connectivity and auth diagnosis. Every probe is a single attempt
 * with no retry so the output shows raw upstream behavior, and nothing in the
 * output identifies the document: the page is reduced to its origin, the
 * shares probe records a path template, and tokens appear as fingerprints.
 */
export const diagnose = defineTool({
  name: 'diagnose',
  displayName: 'Diagnose Connectivity',
  description:
    'Read-only connectivity check for the Word plugin. Reports the page origin and kind (word.cloud.microsoft app vs SharePoint/OneDrive-hosted document), ' +
    'which Microsoft Graph token sources hold a token with its expiry, audience and fingerprint (never token values), which source the tools use, ' +
    'whether the open document resolves to a drive item, any Office reload marker on the page, and one un-retried probe per Graph endpoint the tools depend on ' +
    'with HTTP status, latency and upstream request-id. Use when Word tools fail with UPSTREAM_UNAVAILABLE, NETWORK_ERROR or AUTH_ERROR to tell a Microsoft outage ' +
    'from a missing or expired token. Makes no changes.',
  summary: 'Check Microsoft Graph connectivity and auth state',
  icon: 'stethoscope',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    pageOrigin: z.string().describe('Origin of the current tab'),
    pageKind: z.enum(['cloud-app', 'sharepoint', 'other']).describe('Which Word surface the tab is'),
    apiBase: z.string().describe('Microsoft Graph base URL every tool and probe targets'),
    tokenSources: z.array(tokenSourceSchema),
    activeSource: z
      .enum(GRAPH_TOKEN_SOURCES)
      .nullable()
      .describe('Token source the tools currently use; null when none is usable'),
    documentContext: z.object({
      available: z.boolean().describe('Whether the open document resolves to a drive item'),
      source: z
        .enum(['url', 'shares'])
        .nullable()
        .describe(
          'How the document ids are found: URL query, Graph /shares resolution, or null on a page without a document',
        ),
    }),
    reloadMarker: z
      .object({
        reason: z.string(),
        count: z.number().int().nullable(),
        subcode: z.string().nullable(),
      })
      .nullable()
      .describe('Office wdrldr/wdrldc/wdrldsc reload marker for this document load, when present'),
    probes: z.array(probeResultSchema),
  }),
  handle: async () => {
    const contextSource = describeDocumentContextSource();
    const [userProbe, sharesProbe] = await Promise.all([
      probeCurrentUser(),
      contextSource === 'shares' ? probeSharedDocumentItem() : null,
    ]);
    const marker = readReloadMarker();
    return {
      pageOrigin: new URL(getCurrentUrl()).origin,
      pageKind: describePageKind(),
      apiBase: GRAPH_API_BASE,
      tokenSources: describeTokenSources(),
      activeSource: activeTokenSource(),
      documentContext: {
        available: contextSource === 'url' || sharesProbe?.ok === true,
        source: contextSource,
      },
      reloadMarker: marker === null ? null : { reason: marker.reason, count: marker.count, subcode: marker.subcode },
      probes: sharesProbe === null ? [userProbe] : [userProbe, sharesProbe],
    };
  },
});
