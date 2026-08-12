/**
 * MakerWorld API wrapper.
 *
 * MakerWorld is a Next.js app over a same-origin REST API split into named
 * microservices: `https://makerworld.com/api/v1/<service>/<path>`. Every request
 * is authenticated by the session cookie alone — there is no bearer token and no
 * CSRF header, so `credentials: 'include'` (which the SDK fetch helpers set) is
 * the whole auth story. The four `X-BBL-*` headers below are what the site's own
 * client sends; some endpoints reject requests without them.
 */

import {
  buildQueryString,
  fetchFromPage,
  fetchJSON,
  getCookie,
  getPageGlobal,
  ToolError,
  waitUntil,
} from '@opentabs-dev/plugin-sdk';

/** Named backend services behind /api/v1 that this plugin calls. */
export type MakerWorldService =
  | 'comment-service'
  | 'design-service'
  | 'design-user-service'
  | 'point-service'
  | 'user-service';

/** Headers MakerWorld's own web client sends on every API call. */
const CLIENT_HEADERS: Record<string, string> = {
  'X-BBL-Client-Type': 'web',
  'X-BBL-Client-Version': '00.00.00.01',
  'X-BBL-App-Source': 'makerworld',
  'X-BBL-Client-Name': 'MakerWorld',
};

/** Query parameter values the API accepts. `undefined` entries are dropped by buildQueryString. */
type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Whether the visitor is signed in.
 *
 * `IS_MW_USER` is a non-HttpOnly cookie the site sets for authenticated
 * sessions; the session cookie itself is HttpOnly and invisible to scripts.
 */
export const isAuthenticated = (): boolean => getCookie('IS_MW_USER') !== null;

/** Wait for the session cookie to appear during page hydration. */
export const waitForAuth = async (): Promise<boolean> => {
  try {
    await waitUntil(() => isAuthenticated(), { interval: 500, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const buildUrl = (service: MakerWorldService, path: string, query?: QueryParams): string => {
  const base = `https://makerworld.com/api/v1/${service}${path}`;
  const qs = query ? buildQueryString(query) : '';
  return qs ? `${base}?${qs}` : base;
};

interface ApiOptions {
  /** HTTP method — defaults to GET */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON request body */
  body?: unknown;
  /** Query string parameters */
  query?: QueryParams;
}

/**
 * Call a MakerWorld API endpoint and parse the JSON response.
 *
 * `fetchJSON` supplies `credentials: 'include'`, a timeout, and HTTP-status →
 * `ToolError` classification, so this only layers on the service base URL,
 * the client headers, and the signed-out guard.
 */
export const api = async <T>(service: MakerWorldService, path: string, options: ApiOptions = {}): Promise<T> => {
  if (!isAuthenticated()) {
    throw ToolError.auth('Not signed in to MakerWorld — please log in at makerworld.com and try again.');
  }

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...CLIENT_HEADERS };
  const init: Parameters<typeof fetchJSON>[1] = { method, headers };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  // fetchJSON resolves undefined for 204 No Content, which MakerWorld returns from
  // some write endpoints. Callers of those pass T = void and never read the value.
  const data = await fetchJSON<T>(buildUrl(service, path, options.query), init);
  return data as T;
};

/**
 * Call an endpoint that returns no useful body.
 *
 * MakerWorld's write endpoints are inconsistent about what they return — some
 * send JSON, others an empty 200 with no content type — so parsing the response
 * as JSON fails on the empty ones. This ignores the body entirely and relies on
 * `fetchFromPage` to raise a classified error for any non-2xx status.
 */
export const apiVoid = async (service: MakerWorldService, path: string, options: ApiOptions = {}): Promise<void> => {
  if (!isAuthenticated()) {
    throw ToolError.auth('Not signed in to MakerWorld — please log in at makerworld.com and try again.');
  }

  const headers: Record<string, string> = { ...CLIENT_HEADERS };
  const init: Parameters<typeof fetchFromPage>[1] = { method: options.method ?? 'POST', headers };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  await fetchFromPage(buildUrl(service, path, options.query), init);
};

/**
 * Read the signed-in user's profile as one document.
 *
 * MakerWorld splits the profile across two endpoints: `/my/profile` carries the
 * social counters, and `/my/preference` carries the editable fields — bio,
 * links, printer names, pinned models, default license — plus every account
 * setting. Neither is a superset, and `/my/preference` is also the write target,
 * so both are needed for a read that round-trips against an update.
 *
 * Preference values win on conflict because those are the ones writes affect.
 */
export const fetchFullProfile = async <T extends Record<string, unknown>>(): Promise<T> => {
  const [profile, preferences] = await Promise.all([
    api<Record<string, unknown>>('design-user-service', '/my/profile'),
    api<Record<string, unknown>>('design-user-service', '/my/preference'),
  ]);
  return { ...profile, ...preferences } as T;
};

/**
 * Fetch server-rendered page data from Next.js.
 *
 * The creator analytics time series is not exposed as a REST endpoint — it is
 * produced by `getServerSideProps` and embedded in the page. Next.js also serves
 * that same payload as JSON at `/_next/data/<buildId>/<route>.json`, which is the
 * only way to read it without scraping the DOM.
 *
 * `buildId` changes on every MakerWorld deploy, so it is read from the live page
 * rather than hardcoded.
 */
export const fetchPageData = async <T>(route: string, query?: QueryParams): Promise<T> => {
  if (!isAuthenticated()) {
    throw ToolError.auth('Not signed in to MakerWorld — please log in at makerworld.com and try again.');
  }

  const buildId = getPageGlobal('__NEXT_DATA__.buildId');
  if (typeof buildId !== 'string' || buildId.length === 0) {
    throw ToolError.internal('Could not read the MakerWorld page build ID. Reload the MakerWorld tab and try again.');
  }

  const qs = query ? buildQueryString(query) : '';
  const base = `https://makerworld.com/_next/data/${buildId}/en${route}.json`;
  const data = await fetchJSON<{ pageProps?: T }>(qs ? `${base}?${qs}` : base, { headers: CLIENT_HEADERS });

  if (!data?.pageProps) {
    throw ToolError.notFound(`MakerWorld returned no page data for ${route}.`);
  }
  return data.pageProps;
};

/** A presigned upload slot returned by the file-signing endpoint. */
interface UploadSlot {
  urls?: string[];
  cdnPrefix?: string;
}

/**
 * Upload bytes to MakerWorld's object storage and return the public CDN URL.
 *
 * Three steps, mirroring the site's own uploader:
 *   1. Ask the API to presign a PUT for this filename under `useType`.
 *   2. PUT the bytes straight to object storage. The presigned URL carries its
 *      own signature, so session cookies must be omitted — sending them makes
 *      the request cross-origin-with-credentials and the storage host rejects it.
 *   3. Convert the presigned URL into the durable public URL by dropping the
 *      signature query string and swapping in the CDN host.
 */
export const uploadFile = async (
  useType: string,
  fileName: string,
  bytes: Blob,
  contentType?: string,
): Promise<string> => {
  const slot = await api<UploadSlot>('design-user-service', '/my/upload', {
    method: 'POST',
    body: { useType, fileNames: [fileName] },
  });

  const uploadUrl = slot.urls?.[0];
  if (!uploadUrl) {
    throw ToolError.internal(`MakerWorld did not return an upload URL for "${fileName}".`);
  }

  await fetchFromPage(uploadUrl, {
    method: 'PUT',
    body: bytes,
    credentials: 'omit',
    ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
  });

  const publicUrl = new URL(uploadUrl);
  publicUrl.search = '';
  if (slot.cdnPrefix) {
    const cdn = new URL(slot.cdnPrefix);
    publicUrl.protocol = cdn.protocol;
    publicUrl.hostname = cdn.hostname;
  }
  return publicUrl.toString();
};

/** Map a file extension to the Content-Type MakerWorld's uploader sends. */
export const contentTypeForFile = (fileName: string): string | undefined => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    pdf: 'application/pdf',
    json: 'application/json',
  };
  return ext ? types[ext] : undefined;
};

/**
 * Resolve a caller-supplied file source into bytes.
 *
 * Adapters run in the page and cannot read the filesystem, so callers provide
 * either a URL the page can fetch (including a single-use loopback URL minted by
 * the `local_file_grant` platform tool) or inline base64 for small files.
 */
export const resolveFileBytes = async (source: { url?: string; base64?: string }): Promise<Blob> => {
  if (source.url) {
    const response = await fetchFromPage(source.url, { credentials: 'omit' });
    return response.blob();
  }

  if (source.base64) {
    const payload = source.base64.includes(',') ? source.base64.slice(source.base64.indexOf(',') + 1) : source.base64;
    let binary: string;
    try {
      binary = atob(payload);
    } catch {
      throw ToolError.validation('content_base64 is not valid base64.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes]);
  }

  throw ToolError.validation('Provide either source_url or content_base64.');
};
