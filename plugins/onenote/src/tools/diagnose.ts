import { defineTool, getCurrentUrl } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { probeResultSchema } from '../diagnostics.js';
import { describeTokenSources, GRAPH_BASE, isOneNoteTab, ONENOTE_TOKEN_SOURCES, probeGraph } from '../onenote-api.js';

const PAGE_KINDS = ['cloud-app', 'sharepoint', 'other'] as const;
type PageKind = (typeof PAGE_KINDS)[number];

const tokenSourceSchema = z.object({
  source: z.enum(ONENOTE_TOKEN_SOURCES).describe('Where the token was read from'),
  present: z.boolean().describe('Whether the source currently holds a token'),
  expiresInSec: z
    .number()
    .int()
    .nullable()
    .describe('Seconds until the expiry the source records (negative when expired); null when it records none'),
  audience: z.string().nullable().describe('Host of the token audience (aud) claim'),
  fingerprint: z
    .string()
    .nullable()
    .describe('Last 4 hex characters of an FNV-1a hash of the token — identifies the token without revealing it'),
  scopes: z.array(z.string()).describe('Scopes granted to the token (scp claim)'),
  notesScope: z
    .boolean()
    .describe('Whether the token carries a OneNote (Notes) scope, required by every /onenote Graph endpoint'),
});

/** The page URL the plugin runs in, or null when it does not parse. */
const parsePageUrl = (): URL | null => {
  try {
    return new URL(getCurrentUrl());
  } catch {
    return null;
  }
};

/** The page's origin; null when the URL does not parse or its origin is opaque (about:, data:, file:). */
const pageOrigin = (url: URL | null): string | null => (url === null || url.origin === 'null' ? null : url.origin);

const pageKind = (url: URL | null): PageKind => {
  if (url === null) return 'other';
  const host = url.hostname.toLowerCase();
  if (host === 'onenote.cloud.microsoft') return 'cloud-app';
  if (host.endsWith('.sharepoint.com')) return 'sharepoint';
  return 'other';
};

export const diagnose = defineTool({
  name: 'diagnose',
  displayName: 'Diagnose Connectivity',
  description:
    'Check OneNote connectivity and auth state without changing anything. Reports the page origin and kind, every Graph token source (present, expiry, audience, scopes and whether a Notes scope is granted — never the token itself), which source the tools use, and a single-attempt probe of the Notes-scoped Graph endpoint the tools depend on. Use this when OneNote tools fail with auth or upstream errors.',
  summary: 'Check Microsoft Graph connectivity and auth state',
  icon: 'stethoscope',
  group: 'Account',
  input: z.object({}),
  output: z.object({
    pageOrigin: z.string().nullable().describe('Origin of the current tab (never the path or query)'),
    pageKind: z
      .enum(PAGE_KINDS)
      .describe('"cloud-app" for onenote.cloud.microsoft, "sharepoint" for a SharePoint/OneDrive-hosted notebook'),
    isOneNoteTab: z.boolean().describe('Whether the current tab is recognized as a OneNote notebook'),
    tokenSources: z.array(tokenSourceSchema).describe('Every token source, in the order the plugin consults them'),
    activeSource: z
      .enum(ONENOTE_TOKEN_SOURCES)
      .nullable()
      .describe('The source whose token the tools use right now; null when none is usable'),
    apiBase: z.string().describe('Graph API base every tool calls (fixed — OneNote has no API-base cascade)'),
    probes: z.array(probeResultSchema).describe('Single-attempt probes, one per API base'),
  }),
  handle: async () => {
    const url = parsePageUrl();
    const { sources, activeSource } = describeTokenSources();
    const probe = await probeGraph('graph:/me/onenote/notebooks', '/me/onenote/notebooks', {
      $top: 1,
      $select: 'id',
    });
    return {
      pageOrigin: pageOrigin(url),
      pageKind: pageKind(url),
      isOneNoteTab: isOneNoteTab(),
      tokenSources: sources,
      activeSource,
      apiBase: GRAPH_BASE,
      probes: [probe],
    };
  },
});
