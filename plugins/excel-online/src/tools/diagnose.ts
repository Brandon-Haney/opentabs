import { defineTool, getCurrentUrl } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type ProbeResult, probeResultSchema } from '../diagnostics.js';
import {
  activeTokenSource,
  describeTokenSources,
  GRAPH_BASE,
  GRAPH_TOKEN_SOURCES,
  isSharePointWorkbook,
  locateWorkbook,
  probeGraph,
  probeWorkbookShare,
  readReloadMarker,
} from '../excel-api.js';

const tokenSourceSchema = z.object({
  source: z.enum(GRAPH_TOKEN_SOURCES).describe('Where the token was read from'),
  present: z.boolean().describe('Whether the source holds a token, expired or not'),
  expiresInSec: z.number().int().nullable().describe('Seconds until expiry; negative once expired; null when absent'),
  audience: z
    .string()
    .nullable()
    .describe('Token audience host (graph.microsoft.com) or application id; null when unreadable'),
  scopes: z.array(z.string()).describe('Delegated scopes granted by the token'),
  fingerprint: z
    .string()
    .nullable()
    .describe('Last 4 hex digits of the token hash — identifies it without revealing it'),
  capturedAgoSec: z
    .number()
    .int()
    .nullable()
    .describe('Seconds since the pre-script captured the token; null for other sources'),
});

const workbookContextSchema = z.object({
  available: z.boolean().describe('Whether the open workbook resolves to a Graph drive item'),
  source: z
    .enum(['url', 'shares'])
    .nullable()
    .describe('How the workbook is identified: driveId/docId in the URL, or a SharePoint sharing URL via /shares'),
});

const reloadMarkerSchema = z.object({
  reason: z.string().describe('Office reload reason (wdrldr)'),
  count: z.number().int().nullable().describe('Office reload count (wdrldc)'),
  subcode: z.string().nullable().describe('Office reload subcode (wdrldsc)'),
});

type PageKind = 'cloud-app' | 'sharepoint' | 'other';

const pageKindOf = (url: URL): PageKind => {
  if (url.hostname === 'excel.cloud.microsoft') return 'cloud-app';
  return isSharePointWorkbook() ? 'sharepoint' : 'other';
};

export const diagnose = defineTool({
  name: 'diagnose',
  displayName: 'Diagnose Connectivity',
  description:
    'Read-only connectivity check for the Excel plugin. Reports the page origin and kind (cloud app vs SharePoint), ' +
    'which Microsoft Graph token sources are present with expiry, audience, scopes and a fingerprint (never token values), ' +
    'whether the open workbook resolves to a drive item, any Office reload marker for this document, and one un-retried ' +
    'probe of Microsoft Graph per endpoint (GET /me, plus /shares/{shareId}/driveItem on SharePoint) with HTTP status, ' +
    'latency, request-id and front-door label. ' +
    'Use when Excel tools fail with UPSTREAM_UNAVAILABLE, NETWORK_ERROR or AUTH_ERROR to tell a Microsoft outage from a missing or expired token.',
  summary: 'Check Microsoft Graph connectivity and auth state',
  icon: 'stethoscope',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    pageOrigin: z.string().describe('Origin of the current tab'),
    pageKind: z.enum(['cloud-app', 'sharepoint', 'other']).describe('Which Excel surface the tab is'),
    tokenSources: z.array(tokenSourceSchema).describe('Every Graph token source, in the order they are tried'),
    activeSource: z.enum(GRAPH_TOKEN_SOURCES).nullable().describe('The source tools currently authenticate with'),
    workbookContext: workbookContextSchema,
    reloadMarker: reloadMarkerSchema.nullable().describe('Present when Office reloaded this document'),
    apiBase: z.string().describe('Microsoft Graph base URL every tool and probe targets'),
    probes: z.array(probeResultSchema).describe('Single-attempt Graph requests, one per endpoint'),
  }),
  handle: async () => {
    const url = new URL(getCurrentUrl());
    const locator = locateWorkbook(url);

    const probeRuns: Promise<ProbeResult>[] = [probeGraph('graph:/me', '/me', '/me', { $select: 'id' })];
    if (locator?.kind === 'shares') probeRuns.push(probeWorkbookShare(locator.sharingUrl));
    const probes = await Promise.all(probeRuns);

    const workbookContext =
      locator === null
        ? { available: false, source: null }
        : locator.kind === 'url'
          ? { available: true, source: 'url' as const }
          : { available: probes[1]?.ok === true, source: 'shares' as const };

    const marker = readReloadMarker();
    return {
      pageOrigin: url.origin,
      pageKind: pageKindOf(url),
      tokenSources: describeTokenSources(),
      activeSource: activeTokenSource(),
      workbookContext,
      reloadMarker: marker === null ? null : { reason: marker.reason, count: marker.count, subcode: marker.subcode },
      apiBase: GRAPH_BASE,
      probes,
    };
  },
});
