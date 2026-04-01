import {
  ToolError,
  findLocalStorageEntry,
  getAuthCache,
  setAuthCache,
  clearAuthCache,
  getCurrentUrl,
  getPageGlobal,
  waitUntil,
  parseRetryAfterMs,
  buildQueryString,
} from '@opentabs-dev/plugin-sdk';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MSAL_CLIENT_ID = '2821b473-fe24-4c86-ba16-62834d6e80c3';

// --- SharePoint detection ---

export const isSharePoint = (): boolean => /\.sharepoint\.com/i.test(getCurrentUrl());

// --- Auth: MSAL tokens from localStorage ---

interface ExcelAuth {
  token: string;
}

/** Read the Graph API token bridged from an Outlook/Teams tab by the extension. */
const getBridgedGraphToken = (): string | null => {
  try {
    const ot = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
    const gt = ot?.graphToken as { token?: string; expiresOn?: number } | undefined;
    if (!gt?.token) return null;
    if (gt.expiresOn && gt.expiresOn < Math.floor(Date.now() / 1000) + 60) return null;
    return gt.token;
  } catch {
    return null;
  }
};

const getGraphToken = (): string | null => {
  const entry = findLocalStorageEntry(
    key => key.includes('accesstoken') && key.includes('graph.microsoft.com') && key.includes(MSAL_CLIENT_ID),
  );
  if (entry) {
    try {
      const parsed = JSON.parse(entry.value);
      if (parsed.secret) {
        const expiresOn = Number.parseInt(parsed.expires_on, 10);
        if (!expiresOn || expiresOn >= Math.floor(Date.now() / 1000)) {
          return parsed.secret as string;
        }
      }
    } catch {
      // Fall through
    }
  }
  return null;
};

const getAuth = (): ExcelAuth | null => {
  // On SharePoint, MSAL tokens are encrypted — use the bridged token from Outlook/Teams
  if (isSharePoint()) {
    const bridged = getBridgedGraphToken();
    if (!bridged) return null;
    const cached = getAuthCache<ExcelAuth>('excel-online');
    if (cached?.token === bridged) return cached;
    const auth: ExcelAuth = { token: bridged };
    setAuthCache('excel-online', auth);
    return auth;
  }

  // On excel.cloud.microsoft, read from MSAL localStorage
  const cached = getAuthCache<ExcelAuth>('excel-online');
  if (cached) {
    const fresh = getGraphToken();
    if (fresh && fresh === cached.token) return cached;
    if (fresh) {
      const auth: ExcelAuth = { token: fresh };
      setAuthCache('excel-online', auth);
      return auth;
    }
    clearAuthCache('excel-online');
    return null;
  }

  const token = getGraphToken();
  if (!token) return null;

  const auth: ExcelAuth = { token };
  setAuthCache('excel-online', auth);
  return auth;
};

export const isAuthenticated = (): boolean => {
  if (isSharePoint()) return isSharePointReady();
  return getAuth() !== null;
};

export const waitForAuth = (): Promise<boolean> => {
  if (isSharePoint()) {
    return waitUntil(() => isSharePointReady(), { interval: 500, timeout: 10_000 }).then(
      () => true,
      () => false,
    );
  }
  return waitUntil(() => getAuth() !== null, { interval: 500, timeout: 5_000 }).then(
    () => true,
    () => false,
  );
};

// --- Workbook context from URL ---

interface WorkbookContext {
  driveId: string;
  itemId: string;
}

export const getWorkbookContext = (): WorkbookContext | null => {
  // Primary: URL query params (excel.cloud.microsoft)
  const url = new URL(getCurrentUrl());
  const driveId = url.searchParams.get('driveId');
  const docId = url.searchParams.get('docId');
  if (driveId && docId) return { driveId, itemId: docId };

  // Fallback: WOPI context global (SharePoint-hosted Excel)
  const wopiDriveId = getPageGlobal('_wopiContextJson.DriveId') as string | undefined;
  const wopiItemId = getPageGlobal('_wopiContextJson.DriveItemId') as string | undefined;
  if (wopiDriveId && wopiItemId) return { driveId: wopiDriveId, itemId: wopiItemId };

  return null;
};

const requireWorkbookContext = (): WorkbookContext => {
  const ctx = getWorkbookContext();
  if (!ctx) {
    throw ToolError.validation('No workbook is currently open. Please open an Excel workbook in the browser first.');
  }
  return ctx;
};

// --- API caller ---

export const api = async <T>(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Microsoft 365.');

  const qs = options.query ? buildQueryString(options.query) : '';
  const url = qs ? `${GRAPH_BASE}${endpoint}?${qs}` : `${GRAPH_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
  };

  let fetchBody: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw ToolError.timeout(`API request timed out: ${endpoint}`);
    if (err instanceof DOMException && err.name === 'AbortError') throw new ToolError('Request was aborted', 'aborted');
    throw new ToolError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'network_error', {
      category: 'internal',
      retryable: true,
    });
  }

  if (!response.ok) {
    const errorBody = (await response.text().catch(() => '')).substring(0, 512);

    // On 401, clear cached auth and request a token refresh from the extension
    // for SharePoint tabs where auth comes from the Outlook token bridge.
    if (response.status === 401) {
      clearAuthCache('excel-online');
      if (/\.sharepoint\.com/i.test(getCurrentUrl())) {
        try {
          window.postMessage({ type: 'opentabs:request-token-refresh', plugin: 'excel-online' }, '*');
        } catch {
          // Best-effort — relay may not be installed
        }
      }
      throw ToolError.auth(`Auth error (401): ${errorBody}`);
    }
    if (response.status === 403) throw ToolError.auth(`Forbidden (403): ${errorBody}`);
    if (response.status === 404) throw ToolError.notFound(`Not found: ${endpoint} — ${errorBody}`);
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
      throw ToolError.rateLimited(`Rate limited: ${endpoint} — ${errorBody}`, retryMs);
    }
    if (response.status === 400 || response.status === 422)
      throw ToolError.validation(`Validation error: ${endpoint} — ${errorBody}`);
    throw ToolError.internal(`API error (${response.status}): ${endpoint} — ${errorBody}`);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
};

// --- Workbook API helper ---

export const workbookApi = async <T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<T> => {
  const ctx = requireWorkbookContext();
  const endpoint = `/drives/${ctx.driveId}/items/${encodeURIComponent(ctx.itemId)}/workbook${path}`;
  return api<T>(endpoint, options);
};

// --- User API helper ---

export const getUserInfo = async (): Promise<{ displayName: string; mail: string; id: string }> => {
  return api('/me');
};

// --- SharePoint: Excel Services REST API ---
// On SharePoint, MSAL tokens are encrypted and unreadable. Instead of Graph API,
// we use SharePoint's Excel Services REST API (/_vti_bin/ExcelRest.aspx) which
// authenticates via session cookies — no bearer token required.

interface SharePointContext {
  origin: string;
  webUrl: string;
  excelRestBase: string;
  driveId: string;
  itemId: string;
  fileName: string;
}

let cachedSpContext: SharePointContext | null = null;

const isSharePointReady = (): boolean => {
  const webUrl = getPageGlobal('_spPageContextInfo.webAbsoluteUrl') as string | undefined;
  const driveId = getPageGlobal('_wopiContextJson.DriveId') as string | undefined;
  const itemId = getPageGlobal('_wopiContextJson.DriveItemId') as string | undefined;
  return !!(webUrl && driveId && itemId);
};

const resolveSharePointContext = async (): Promise<SharePointContext> => {
  if (cachedSpContext) return cachedSpContext;

  const webUrl = getPageGlobal('_spPageContextInfo.webAbsoluteUrl') as string | undefined;
  const driveId = getPageGlobal('_wopiContextJson.DriveId') as string | undefined;
  const itemId = getPageGlobal('_wopiContextJson.DriveItemId') as string | undefined;
  const fileName = getPageGlobal('_wopiContextJson.FileName') as string | undefined;
  // DocUniqueId from WOPI context identifies the file for SharePoint REST API
  const docUniqueId = getPageGlobal('_wopiContextJson.DocUniqueId') as string | undefined;

  if (!webUrl || !driveId || !itemId) {
    throw ToolError.auth('SharePoint context not available — page may still be loading.');
  }

  const origin = new URL(webUrl).origin;
  const webServerRelUrl = new URL(webUrl).pathname;

  // Get the file's server-relative URL from SharePoint REST API.
  // This gives us the exact path needed for ExcelRest.aspx.
  let serverRelUrl: string | undefined;
  if (docUniqueId) {
    const fileResp = await fetch(
      `${webUrl}/_api/web/GetFileById('${docUniqueId}')?$select=ServerRelativeUrl,Name`,
      { credentials: 'include', headers: { Accept: 'application/json;odata=verbose' } },
    );
    if (fileResp.ok) {
      const fileData = (await fileResp.json()) as { d?: { ServerRelativeUrl?: string; Name?: string } };
      serverRelUrl = fileData.d?.ServerRelativeUrl;
    }
  }

  // Fallback: construct from v2.1 metadata if GetFileById failed
  if (!serverRelUrl) {
    const metaResp = await fetch(
      `${origin}/_api/v2.1/drives/${driveId}/items/${itemId}?$select=name,parentReference`,
      { credentials: 'include', headers: { Accept: 'application/json' } },
    );
    if (metaResp.ok) {
      const meta = (await metaResp.json()) as { name?: string; parentReference?: { path?: string } };
      const parentPath = meta.parentReference?.path ?? '';
      const rootIdx = parentPath.indexOf('root:');
      const folderPath = rootIdx >= 0 ? parentPath.substring(rootIdx + 5) : '';
      const name = meta.name ?? fileName ?? '';
      // The v2.1 path is relative to the drive root — prepend the web's Documents library
      serverRelUrl = `${webServerRelUrl}/Documents${folderPath}/${name}`;
    }
  }

  if (!serverRelUrl) {
    throw ToolError.internal('Could not determine file path on SharePoint.');
  }

  // ExcelRest path: strip the web's server-relative URL prefix to get the path
  // relative to the web, then use {webUrl}/_vti_bin/ExcelRest.aspx/{relativePath}
  const relativePath = serverRelUrl.startsWith(webServerRelUrl)
    ? serverRelUrl.substring(webServerRelUrl.length)
    : serverRelUrl;

  const excelRestBase = `${webUrl}/_vti_bin/ExcelRest.aspx${relativePath}`;
  const resolvedName = fileName ?? serverRelUrl.split('/').pop() ?? '';

  cachedSpContext = { origin, webUrl, excelRestBase, driveId, itemId, fileName: resolvedName };
  return cachedSpContext;
};

/** Get file info via SharePoint's v2.1 proxy. */
export const sharepointGetFileInfo = async (): Promise<{ name: string; driveId: string; itemId: string }> => {
  const ctx = await resolveSharePointContext();
  return { name: ctx.fileName, driveId: ctx.driveId, itemId: ctx.itemId };
};

/** Get current user info from SharePoint page context. */
export const sharepointGetCurrentUser = (): { displayName: string; mail: string; id: string } => {
  const loginName = (getPageGlobal('_spPageContextInfo.userLoginName') as string | undefined) ?? '';
  const displayName = (getPageGlobal('_spPageContextInfo.userDisplayName') as string | undefined) ?? loginName;
  return { displayName, mail: loginName, id: loginName };
};

/** Whether a Graph API bearer token is available (from MSAL or bridged). */
export const hasGraphAuth = (): boolean => getAuth() !== null;

/**
 * Guard for write operations that require Graph API access.
 * No-op on excel.cloud.microsoft. On SharePoint, throws an actionable auth
 * error if no bridged Graph token is available.
 */
export const requireGraphAuth = (operation: string): void => {
  if (isSharePoint() && !hasGraphAuth()) {
    throw ToolError.auth(
      `${operation} on SharePoint requires a Graph API token. ` +
        'Please open Outlook (outlook.cloud.microsoft) or Teams in another browser tab, ' +
        'then try again. The token is bridged automatically.',
    );
  }
};

// --- SharePoint xlsx parsing ---
// On SharePoint, the Graph API and Excel Services REST API are both unavailable.
// Instead, we download the xlsx file via SharePoint's v2.1 proxy and parse it
// in-browser. The xlsx format is a ZIP archive containing XML files.

interface ParsedWorkbook {
  sheetNames: string[];
  sharedStrings: string[];
  sheets: Map<string, unknown[][]>;
  fetchedAt: number;
}

let cachedWorkbook: ParsedWorkbook | null = null;
const CACHE_TTL_MS = 30_000;

const downloadWorkbook = async (): Promise<Uint8Array> => {
  const ctx = await resolveSharePointContext();
  const contentUrl = `${ctx.origin}/_api/v2.1/drives/${ctx.driveId}/items/${ctx.itemId}/content`;
  const resp = await fetch(contentUrl, {
    credentials: 'include',
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw ToolError.internal(`Failed to download workbook (${String(resp.status)})`);
  return new Uint8Array(await resp.arrayBuffer());
};

/** Decompress a ZIP entry using the browser's DecompressionStream API. */
const decompressEntry = async (data: Uint8Array, method: number): Promise<Uint8Array> => {
  if (method === 0) return data; // Stored — no compression

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  const writePromise = writer.write(new Uint8Array(data)).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }
  await writePromise;

  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

interface ZipEntry {
  name: string;
  offset: number;
  compSize: number;
  method: number;
}

/** Parse the ZIP central directory and return entries matching a filter. */
const parseZipEntries = (data: Uint8Array, filter: (name: string) => boolean): ZipEntry[] => {
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw ToolError.internal('Invalid xlsx — no ZIP end of central directory');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdEnd = cdOffset + cdSize;

  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  while (pos < cdEnd) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(data.subarray(pos + 46, pos + 46 + nameLen));

    if (filter(name)) {
      entries.push({ name, offset: localHeaderOffset, compSize, method });
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};

/** Read and decompress a ZIP entry's data. */
const readZipEntry = async (data: Uint8Array, entry: ZipEntry): Promise<string> => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const localNameLen = view.getUint16(entry.offset + 26, true);
  const localExtraLen = view.getUint16(entry.offset + 28, true);
  const dataStart = entry.offset + 30 + localNameLen + localExtraLen;
  const compressedData = data.subarray(dataStart, dataStart + entry.compSize);
  const decompressed = await decompressEntry(compressedData, entry.method);
  return new TextDecoder().decode(decompressed);
};

/** Parse shared strings from xl/sharedStrings.xml. */
const parseSharedStrings = (xml: string): string[] => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const siElements = doc.getElementsByTagName('si');
  const strings: string[] = [];
  for (const si of siElements) {
    // Shared strings can contain <t> directly or <r> runs with <t> inside
    const parts: string[] = [];
    const tElements = si.getElementsByTagName('t');
    for (const t of tElements) {
      parts.push(t.textContent ?? '');
    }
    strings.push(parts.join(''));
  }
  return strings;
};

/** Convert a cell reference like "B3" to zero-based {col, row}. */
const cellRefToIndex = (ref: string): { col: number; row: number } => {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return { col: 0, row: 0 };
  const letters = match[1] as string;
  const digits = match[2] as string;
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: Number.parseInt(digits, 10) - 1 };
};

/** Parse cell data from a worksheet XML file. */
const parseWorksheetData = (xml: string, sharedStrings: string[]): unknown[][] => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const rows = doc.getElementsByTagName('row');

  const data: unknown[][] = [];
  for (const row of rows) {
    const rowIdx = Number.parseInt(row.getAttribute('r') ?? '1', 10) - 1;
    while (data.length <= rowIdx) data.push([]);
    const cells = row.getElementsByTagName('c');
    for (const cell of cells) {
      const ref = cell.getAttribute('r') ?? '';
      const { col } = cellRefToIndex(ref);
      const type = cell.getAttribute('t') ?? '';
      const vEl = cell.getElementsByTagName('v')[0];
      const rawValue = vEl?.textContent ?? '';

      let value: unknown = '';
      if (type === 's') {
        // Shared string index
        const idx = Number.parseInt(rawValue, 10);
        value = sharedStrings[idx] ?? '';
      } else if (type === 'b') {
        value = rawValue === '1';
      } else if (type === 'str' || type === 'inlineStr') {
        value = rawValue;
      } else if (rawValue !== '') {
        const num = Number(rawValue);
        value = Number.isNaN(num) ? rawValue : num;
      }

      const currentRow = data[rowIdx]!;
      while (currentRow.length <= col) currentRow.push('');
      currentRow[col] = value;
    }
  }
  return data;
};

/** Parse the full xlsx workbook and cache the result. */
const parseXlsx = async (): Promise<ParsedWorkbook> => {
  if (cachedWorkbook && Date.now() - cachedWorkbook.fetchedAt < CACHE_TTL_MS) {
    return cachedWorkbook;
  }

  const xlsxData = await downloadWorkbook();

  // Find all relevant ZIP entries
  const entries = parseZipEntries(xlsxData, name =>
    name === 'xl/workbook.xml' ||
    name === 'xl/sharedStrings.xml' ||
    name.startsWith('xl/worksheets/sheet'),
  );

  // Read xl/workbook.xml to get sheet names
  const workbookEntry = entries.find(e => e.name === 'xl/workbook.xml');
  if (!workbookEntry) throw ToolError.internal('xlsx missing xl/workbook.xml');
  const workbookXml = await readZipEntry(xlsxData, workbookEntry);
  const wbDoc = new DOMParser().parseFromString(workbookXml, 'text/xml');
  const sheetElements = wbDoc.getElementsByTagName('sheet');
  const sheetNames: string[] = [];
  for (const el of sheetElements) {
    const name = el.getAttribute('name');
    if (name) sheetNames.push(name);
  }

  // Read xl/sharedStrings.xml
  const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
  const sharedStrings = ssEntry ? parseSharedStrings(await readZipEntry(xlsxData, ssEntry)) : [];

  // Read each worksheet
  const sheets = new Map<string, unknown[][]>();
  const sheetEntries = entries
    .filter(e => e.name.startsWith('xl/worksheets/sheet'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (let i = 0; i < sheetEntries.length && i < sheetNames.length; i++) {
    const entry = sheetEntries[i]!;
    const name = sheetNames[i]!;
    const sheetXml = await readZipEntry(xlsxData, entry);
    sheets.set(name, parseWorksheetData(sheetXml, sharedStrings));
  }

  cachedWorkbook = { sheetNames, sharedStrings, sheets, fetchedAt: Date.now() };
  return cachedWorkbook;
};

/** Get worksheet names from the parsed xlsx. */
export const sharepointGetWorksheetNames = async (): Promise<string[]> => {
  const wb = await parseXlsx();
  return wb.sheetNames;
};

/** Read a range from the parsed xlsx. */
export const sharepointGetRange = async (
  address: string,
  worksheet?: string,
): Promise<{ address: string; values: unknown[][] }> => {
  const wb = await parseXlsx();

  const sheetName = worksheet ?? wb.sheetNames[0] ?? '';
  const sheetData = wb.sheets.get(sheetName);
  if (!sheetData) throw ToolError.notFound(`Worksheet "${sheetName}" not found.`);

  // Parse address (e.g., "A1:D10" or "A1")
  const parts = address.split(':');
  const start = cellRefToIndex(parts[0] ?? '');
  const end = parts[1] ? cellRefToIndex(parts[1]) : start;

  const values: unknown[][] = [];
  for (let r = start.row; r <= end.row && r < sheetData.length; r++) {
    const row = sheetData[r] ?? [];
    const slice: unknown[] = [];
    for (let c = start.col; c <= end.col; c++) {
      slice.push(c < row.length ? (row[c] ?? '') : '');
    }
    values.push(slice);
  }

  return { address: `${sheetName}!${address}`, values };
};

/** List tables — not available from xlsx parsing, return empty. */
export const sharepointGetTables = async (): Promise<{ name: string; id: string }[]> => {
  // Table definitions are in xl/tables/*.xml — could be parsed but low priority
  return [];
};
