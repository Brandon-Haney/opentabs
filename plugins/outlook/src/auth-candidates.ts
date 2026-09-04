// ---------------------------------------------------------------------------
// Auth candidates — MSAL token discovery for Graph and Outlook REST
// ---------------------------------------------------------------------------

import { getLocalStorage } from '@opentabs-dev/plugin-sdk';
import { tokenFingerprint } from './token-fingerprint.js';

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
export const OUTLOOK_API_BASE = 'https://outlook.office.com/api/v2.0';

/** Outlook enterprise MSAL client id. */
const MSAL_CLIENT_ID = '9199bf20-a13f-4107-85dc-02114787ef48';
/** Outlook consumer MSAL client id. */
const MSAL_CLIENT_ID_CONSUMER = '2821b473-fe24-4c86-ba16-62834d6e80c3';

const KNOWN_CLIENT_IDS: ReadonlySet<string> = new Set([MSAL_CLIENT_ID, MSAL_CLIENT_ID_CONSUMER]);

/** The two API hosts a token's scope claim can grant. */
export type AudienceHost = 'graph.microsoft.com' | 'outlook.office.com';

const API_BASE_BY_HOST: Record<AudienceHost, string> = {
  'graph.microsoft.com': GRAPH_API_BASE,
  'outlook.office.com': OUTLOOK_API_BASE,
};

/** Which MSAL cache layout an entry was read from. */
export type MsalCacheVersion = 'v1' | 'v2' | 'v3';

export interface OutlookAuth {
  token: string;
  /** The API base URL this token works with (Graph or Outlook REST). */
  apiBase: string;
}

/** An OutlookAuth plus where it came from, so diagnostics can describe it without the secret. */
export interface OutlookAuthCandidate extends OutlookAuth {
  cache: MsalCacheVersion;
  clientId: string;
  /** Token expiry as epoch seconds, from the MSAL entry. */
  expiresOn: number;
}

/**
 * Enumerate every MSAL client id whose token-index key starts with `prefix`.
 * The SDK's `findLocalStorageEntry` returns only the first match, which silently
 * drops every additional client id present when a user has multiple Microsoft
 * apps signed in.
 */
const findAllMsalClientIds = (prefix: string): string[] => {
  const ids: string[] = [];
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) {
        ids.push(key.slice(prefix.length));
      }
    }
  } catch {
    // SecurityError or missing localStorage — nothing we can do
  }
  return ids;
};

/**
 * True when the AAD scope claim (space-separated) contains at least one scope
 * whose URL hostname equals `host`. Each scope is parsed as a URL and compared
 * by `hostname` rather than substring-matched so a malicious value like
 * `https://attacker.com/graph.microsoft.com/foo` cannot satisfy the check.
 */
const scopeClaimHasHost = (target: string, host: string): boolean => {
  for (const scope of target.split(/\s+/)) {
    if (scope.length === 0) continue;
    try {
      if (new URL(scope).hostname.toLowerCase() === host) return true;
    } catch {
      // non-URL scopes (openid, profile, email, ...) — skip
    }
  }
  return false;
};

/**
 * Strict numeric coercion of an MSAL `expiresOn` (epoch seconds): `Number(...)`
 * returns NaN for trailing garbage where `Number.parseInt` would accept
 * '9999999999junk' as a giant future expiry. Null when missing, malformed or past.
 */
const readUnexpiredExpiresOn = (value: unknown): number | null => {
  const expiresOn = Number(value);
  if (!Number.isInteger(expiresOn) || expiresOn <= 0 || expiresOn * 1000 < Date.now()) return null;
  return expiresOn;
};

/** The `accessToken` key list from an MSAL token-index entry; empty when absent or malformed. */
const readTokenIndex = (indexKey: string): string[] => {
  const raw = getLocalStorage(indexKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { accessToken?: unknown };
    return Array.isArray(parsed.accessToken) ? parsed.accessToken.filter(key => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Return unexpired access tokens whose target scope claim grants the given host
 * from the MSAL v2 or v3 cache. Both versions share the same entry shape
 * (`secret`, `target`, `expiresOn`); only the index-key prefix differs.
 */
const findMsalModernTokens = (version: '2' | '3', clientId: string, host: AudienceHost): OutlookAuthCandidate[] => {
  const matches: OutlookAuthCandidate[] = [];
  for (const key of readTokenIndex(`msal.${version}.token.keys.${clientId}`)) {
    const raw = getLocalStorage(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) continue;

      const target: string = parsed.target ?? '';
      if (!scopeClaimHasHost(target, host)) continue;

      const expiresOn = readUnexpiredExpiresOn(parsed.expiresOn);
      if (expiresOn === null) continue;

      matches.push({
        token: parsed.secret,
        apiBase: API_BASE_BY_HOST[host],
        cache: `v${version}`,
        clientId,
        expiresOn,
      });
    } catch {
      // skip invalid entries
    }
  }
  return matches;
};

/** Search the MSAL v1 token cache for valid Graph API access tokens. */
const findMsalV1Tokens = (clientId: string): OutlookAuthCandidate[] => {
  const matches: OutlookAuthCandidate[] = [];
  for (const key of readTokenIndex(`msal.token.keys.${clientId}`)) {
    if (!/(?:^|[\s/])graph\.microsoft\.com(?:[/\s]|$)/.test(key)) continue;
    const raw = getLocalStorage(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) continue;
      const expiresOn = readUnexpiredExpiresOn(parsed.expiresOn);
      if (expiresOn === null) continue;
      matches.push({ token: parsed.secret, apiBase: GRAPH_API_BASE, cache: 'v1', clientId, expiresOn });
    } catch {
      // skip invalid entries
    }
  }
  return matches;
};

/**
 * Return every MSAL-cached token plausibly usable against Graph or Outlook REST,
 * deduplicated by secret (the first provenance wins) and ordered by preference
 * (v3 enterprise → v2 enterprise → v1 consumer → other client ids). `api()`
 * cascades through the list on 401/403; the first token the API accepts is
 * cached for subsequent calls.
 */
export const collectAuthCandidates = (): OutlookAuthCandidate[] => {
  const all: OutlookAuthCandidate[] = [];

  // Enterprise, known client id — v3 then v2, Graph then Outlook REST per version
  for (const version of ['3', '2'] as const) {
    all.push(...findMsalModernTokens(version, MSAL_CLIENT_ID, 'graph.microsoft.com'));
    all.push(...findMsalModernTokens(version, MSAL_CLIENT_ID, 'outlook.office.com'));
  }

  // Consumer v1
  all.push(...findMsalV1Tokens(MSAL_CLIENT_ID_CONSUMER));

  // Fallback: every other client id present in localStorage, modern then v1.
  // Enumerate (not first-match) so users with multiple Microsoft apps signed in
  // surface every token, not just the first index key the iterator hits.
  for (const version of ['3', '2'] as const) {
    for (const cid of findAllMsalClientIds(`msal.${version}.token.keys.`)) {
      if (cid === MSAL_CLIENT_ID) continue;
      all.push(...findMsalModernTokens(version, cid, 'graph.microsoft.com'));
      all.push(...findMsalModernTokens(version, cid, 'outlook.office.com'));
    }
  }
  for (const cid of findAllMsalClientIds('msal.token.keys.')) {
    if (cid === MSAL_CLIENT_ID_CONSUMER) continue;
    all.push(...findMsalV1Tokens(cid));
  }

  // Deduplicate by token — multiple lookups can surface the same secret
  const seen = new Set<string>();
  return all.filter(c => {
    if (seen.has(c.token)) return false;
    seen.add(c.token);
    return true;
  });
};

/** One MSAL lookup (cache version × client id × audience) and the token it yielded, if any. */
export interface TokenSourceDescriptor {
  /** The MSAL cache layout, e.g. `msal.v3`. */
  source: string;
  clientId: string;
  /** Whether the client id is one of Outlook's own (enterprise or consumer). */
  knownClient: boolean;
  audienceHost: string;
  /** Whether the lookup yielded an unexpired token. */
  present: boolean;
  /** Seconds until the token expires; null when no token is present. */
  expiresInSec: number | null;
  /** Fingerprint of the token (see token-fingerprint.ts); null when no token is present. */
  fingerprint: string | null;
}

/** The lookups `collectAuthCandidates` always performs, in its preference order. */
const KNOWN_LOOKUPS: readonly Pick<TokenSourceDescriptor, 'source' | 'clientId' | 'audienceHost'>[] = [
  { source: 'msal.v3', clientId: MSAL_CLIENT_ID, audienceHost: 'graph.microsoft.com' },
  { source: 'msal.v3', clientId: MSAL_CLIENT_ID, audienceHost: 'outlook.office.com' },
  { source: 'msal.v2', clientId: MSAL_CLIENT_ID, audienceHost: 'graph.microsoft.com' },
  { source: 'msal.v2', clientId: MSAL_CLIENT_ID, audienceHost: 'outlook.office.com' },
  { source: 'msal.v1', clientId: MSAL_CLIENT_ID_CONSUMER, audienceHost: 'graph.microsoft.com' },
];

const describeCandidate = (candidate: OutlookAuthCandidate, now: number): TokenSourceDescriptor => ({
  source: `msal.${candidate.cache}`,
  clientId: candidate.clientId,
  knownClient: KNOWN_CLIENT_IDS.has(candidate.clientId),
  audienceHost: new URL(candidate.apiBase).host,
  present: true,
  expiresInSec: Math.max(0, Math.round(candidate.expiresOn - now / 1000)),
  fingerprint: tokenFingerprint(candidate.token),
});

const sameLookup = (
  a: Pick<TokenSourceDescriptor, 'source' | 'clientId' | 'audienceHost'>,
  b: Pick<TokenSourceDescriptor, 'source' | 'clientId' | 'audienceHost'>,
): boolean => a.source === b.source && a.clientId === b.clientId && a.audienceHost === b.audienceHost;

/**
 * Describes every token source for the diagnose tool: one row per candidate
 * token (in cascade order), plus a `present: false` row for each of Outlook's
 * own lookups that yielded nothing, so a missing token is visible rather than
 * silently absent. Never includes a secret.
 */
export const describeTokenSources = (now = Date.now()): TokenSourceDescriptor[] => {
  const rows = collectAuthCandidates().map(candidate => describeCandidate(candidate, now));
  const known: TokenSourceDescriptor[] = [];
  for (const lookup of KNOWN_LOOKUPS) {
    const found = rows.filter(row => sameLookup(row, lookup));
    known.push(
      ...(found.length > 0
        ? found
        : [{ ...lookup, knownClient: true, present: false, expiresInSec: null, fingerprint: null }]),
    );
  }
  const others = rows.filter(row => !KNOWN_LOOKUPS.some(lookup => sameLookup(row, lookup)));
  return [...known, ...others];
};
