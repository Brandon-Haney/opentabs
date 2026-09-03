import { defineTool, getCurrentUrl } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type ProbeResult, probeResultSchema } from '../diagnostics.js';
import { describePageIdentity, PAGE_IDENTITY_KINDS } from '../page-identity.js';
import {
  DRIVE_ID_SOURCES,
  type DriveIdSource,
  describeActiveTokenSource,
  describeDriveIdSource,
  describeTokenSources,
  encodeShareId,
  GRAPH_BASE,
  GRAPH_TOKEN_SOURCES,
  getCurrentItemId,
  isSharePoint,
  isSharePointPresentation,
  probeGraph,
  readReloadMarker,
} from '../powerpoint-api.js';
import { listSessions } from '../session.js';

const PAGE_KINDS = ['cloud-app', 'sharepoint', 'other'] as const;
type PageKind = (typeof PAGE_KINDS)[number];

const pageKindOf = (url: URL): PageKind => {
  if (isSharePointPresentation()) return 'sharepoint';
  if (url.hostname.toLowerCase() === 'powerpoint.cloud.microsoft') return 'cloud-app';
  return 'other';
};

const tokenSourceStatusSchema = z.object({
  source: z.enum(GRAPH_TOKEN_SOURCES).describe('Where the token was read from'),
  present: z.boolean().describe('Whether this source holds a token at all, live or expired'),
  expiresInSec: z.number().int().nullable().describe('Seconds until the token expires (negative once expired)'),
  audience: z.string().nullable().describe('Host of the token audience, e.g. graph.microsoft.com'),
  fingerprint: z
    .string()
    .nullable()
    .describe('4 hex digits identifying the token so sources can be compared; reveals nothing about it'),
});

export const diagnose = defineTool({
  name: 'diagnose',
  displayName: 'Diagnose Connectivity',
  description:
    'Read-only connectivity check for the PowerPoint plugin: page origin and kind (cloud app vs SharePoint), who ' +
    'the page is signed in as (a member of the hosting tenant, a B2B guest, or an anonymous sharing-link visitor — ' +
    'on which Graph is unreachable and only the live tools work), which ' +
    'Microsoft Graph token sources are present with expiry, audience and fingerprint (never token values), how the ' +
    'open presentation resolves to a drive, any Office reload marker for this document, the number of open batched ' +
    'edit sessions, and one un-retried probe of Microsoft Graph with HTTP status, latency and request-id. Use when ' +
    'PowerPoint tools fail with UPSTREAM_UNAVAILABLE, NETWORK_ERROR or AUTH_ERROR.',
  summary: 'Check Microsoft Graph connectivity and auth state',
  icon: 'stethoscope',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    pageOrigin: z.string().describe('Origin of the tab the plugin runs in'),
    pageKind: z.enum(PAGE_KINDS).describe('powerpoint.cloud.microsoft, a SharePoint/OneDrive presentation, or other'),
    identity: z.object({
      kind: z
        .enum(PAGE_IDENTITY_KINDS)
        .describe(
          'A member of the hosting tenant, a B2B guest of it, an anonymous sharing-link visitor (no sign-in on the page, so Graph is unreachable and only the live tools work), or unknown',
        ),
      tenantId: z.string().nullable().describe('Azure AD tenant hosting the page'),
      canEdit: z.boolean().nullable().describe('Whether the WOPI host opened the file for editing'),
    }),
    apiBase: z.string().describe('Microsoft Graph base URL every PowerPoint request targets'),
    tokenSources: z.array(tokenSourceStatusSchema).describe('Every Graph token source, in the order they are tried'),
    activeSource: z
      .enum(GRAPH_TOKEN_SOURCES)
      .nullable()
      .describe('The source whose token requests would use right now; null when none is usable'),
    presentationContext: z.object({
      available: z.boolean().describe('Whether the tab resolves to a drive that file tools can default to'),
      driveIdSource: z
        .enum(DRIVE_ID_SOURCES)
        .nullable()
        .describe('How the drive id is derived: URL query, WOPI context, MSAL account, or a Graph /shares lookup'),
      itemIdFromWopi: z.boolean().describe('Whether the SharePoint WOPI context exposes the open file item id'),
    }),
    reloadMarker: z
      .object({
        reason: z.string().describe('Office reload reason (wdrldr)'),
        count: z.number().int().nullable().describe('Reload count (wdrldc)'),
        subcode: z.string().nullable().describe('Reload subcode (wdrldsc)'),
      })
      .nullable()
      .describe('The Office reload marker for this document, when the web app reloaded it'),
    openSessions: z.number().int().nonnegative().describe('Batched edit sessions currently open in this tab'),
    probes: z.array(probeResultSchema).describe('Single-attempt Graph requests with status, latency and request-id'),
  }),
  handle: async () => {
    const url = new URL(getCurrentUrl());
    const probes: ProbeResult[] = [await probeGraph('graph:/me', '/me', '/me', { $select: 'id' })];

    // The /shares lookup is what drive resolution falls back to on SharePoint
    // when nothing on the page exposes the drive id; probing it here both shows
    // the raw upstream behavior and tells whether that fallback would succeed.
    const knownSource = describeDriveIdSource();
    let driveIdSource: DriveIdSource | null = knownSource;
    if (knownSource === null && isSharePoint()) {
      const sharesProbe = await probeGraph(
        'graph:/shares',
        '/shares/{shareId}/driveItem',
        `/shares/${encodeShareId(url.href)}/driveItem`,
        { $select: 'id,parentReference' },
      );
      probes.push(sharesProbe);
      if (sharesProbe.ok) driveIdSource = 'shares';
    }

    const marker = readReloadMarker();

    return {
      pageOrigin: url.origin,
      pageKind: pageKindOf(url),
      identity: describePageIdentity(),
      apiBase: GRAPH_BASE,
      tokenSources: describeTokenSources(),
      activeSource: describeActiveTokenSource(),
      presentationContext: {
        available: driveIdSource !== null,
        driveIdSource,
        itemIdFromWopi: getCurrentItemId() !== null,
      },
      reloadMarker: marker === null ? null : { reason: marker.reason, count: marker.count, subcode: marker.subcode },
      openSessions: listSessions().length,
      probes,
    };
  },
});
