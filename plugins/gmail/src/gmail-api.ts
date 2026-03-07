import { ToolError, getCookie } from '@opentabs-dev/plugin-sdk';

// --- Types ---

export interface GmailAuth {
  email: string;
  ik: string;
  basePath: string;
  accountIndex: string;
  at: string;
  xsrfToken: string;
  btai: string;
  storageRequest: string;
}

export interface GmailThread {
  threadId: string;
  subject: string;
  snippet: string;
  timestamp: number;
  from: { email: string; name: string };
  to: Array<{ email: string; name: string }>;
  cc: Array<{ email: string; name: string }>;
  labels: string[];
  messages: GmailMessage[];
}

export interface GmailMessage {
  messageId: string;
  hexId: string;
  from: { email: string; name: string };
  to: Array<{ email: string; name: string }>;
  cc: Array<{ email: string; name: string }>;
  subject: string;
  snippet: string;
  timestamp: number;
  labels: string[];
  bodyHtml: string;
}

export interface GmailLabelCount {
  label: string;
  unread: number;
  total: number;
}

// --- Token persistence on globalThis ---

const PLUGIN_KEY = 'gmail';

const getPersistedAuth = (): GmailAuth | null => {
  try {
    const ns = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
    const cache = ns?.tokenCache as Record<string, GmailAuth | undefined> | undefined;
    return cache?.[PLUGIN_KEY] ?? null;
  } catch {
    return null;
  }
};

const setPersistedAuth = (auth: GmailAuth): void => {
  try {
    const g = globalThis as Record<string, unknown>;
    if (!g.__openTabs) g.__openTabs = {};
    const ns = g.__openTabs as Record<string, unknown>;
    if (!ns.tokenCache) ns.tokenCache = {};
    const cache = ns.tokenCache as Record<string, GmailAuth | undefined>;
    cache[PLUGIN_KEY] = auth;
  } catch {
    // Silently fail
  }
};

const clearPersistedAuth = (): void => {
  try {
    const ns = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
    const cache = ns?.tokenCache as Record<string, GmailAuth | undefined> | undefined;
    if (cache) cache[PLUGIN_KEY] = undefined;
  } catch {
    // Silently fail
  }
};

// --- XHR interception to capture auth tokens from Gmail's own requests ---

let capturedAt = '';
let capturedXsrfToken = '';
let capturedBtai = '';
let capturedStorageRequest = '';

// Store captured tokens on globalThis so they survive adapter re-injection.
// The adapter IIFE is re-executed on extension reload, resetting module-level variables,
// but globalThis persists since the page itself is not reloaded.
const CAPTURE_KEY = '__gmailCapturedTokens';

const loadCapturedTokens = (): void => {
  try {
    const stored = (globalThis as Record<string, unknown>)[CAPTURE_KEY] as Record<string, string> | undefined;
    if (stored) {
      if (stored.at) capturedAt = stored.at;
      if (stored.xsrfToken) capturedXsrfToken = stored.xsrfToken;
      if (stored.btai) capturedBtai = stored.btai;
      if (stored.storageRequest) capturedStorageRequest = stored.storageRequest;
    }
  } catch {
    // Silently fail
  }
};

const saveCapturedTokens = (): void => {
  try {
    (globalThis as Record<string, unknown>)[CAPTURE_KEY] = {
      at: capturedAt,
      xsrfToken: capturedXsrfToken,
      btai: capturedBtai,
      storageRequest: capturedStorageRequest,
    };
  } catch {
    // Silently fail
  }
};

const installInterceptor = (): void => {
  try {
    // Restore previously captured tokens from globalThis
    loadCapturedTokens();

    const g = globalThis as Record<string, unknown>;

    // Store the ORIGINAL (unpatched) XHR methods on first install only
    if (!g.__gmailOrigOpen) {
      g.__gmailOrigOpen = XMLHttpRequest.prototype.open;
      g.__gmailOrigSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    }
    g.__gmailInterceptorInstalled = true;

    // Always re-patch to use the current adapter's closures
    const origOpen = g.__gmailOrigOpen as typeof XMLHttpRequest.prototype.open;
    const origSetHeader = g.__gmailOrigSetHeader as typeof XMLHttpRequest.prototype.setRequestHeader;

    const origOpenFn = origOpen as (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) => void;

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      (this as unknown as Record<string, unknown>).__url = String(url);
      return origOpenFn.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (...args: Parameters<typeof origSetHeader>) {
      const url = (this as unknown as Record<string, unknown>).__url as string | undefined;
      if (url) {
        const atMatch = url.match(/at=([A-Za-z0-9_-]+)/);
        if (atMatch?.[1]) capturedAt = atMatch[1];
        if (args[0] === 'X-Framework-Xsrf-Token' && args[1]) capturedXsrfToken = args[1];
        if (args[0] === 'X-Gmail-BTAI' && args[1]) capturedBtai = args[1];
        if (args[0] === 'X-Gmail-Storage-Request' && args[1]) capturedStorageRequest = args[1];
        // Persist to globalThis so next adapter re-injection picks them up
        saveCapturedTokens();
      }
      return origSetHeader.apply(this, args);
    };
  } catch {
    // Silently fail
  }
};

installInterceptor();

// --- SAPISIDHASH generation ---

const generateSapisidHash = async (origin: string): Promise<string | null> => {
  const sapisid = getCookie('SAPISID');
  if (!sapisid) return null;
  const now = Math.floor(Date.now() / 1000);
  const input = `${now} ${sapisid} ${origin}`;
  const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `SAPISIDHASH ${now}_${hex}`;
};

// --- Auth extraction from page globals ---

const getGlobals = (): unknown[] | null => {
  try {
    const g = (window as unknown as Record<string, unknown>).GLOBALS;
    if (Array.isArray(g) && g.length > 50) return g as unknown[];
  } catch {
    // Silently fail
  }
  return null;
};

const getAuth = (): GmailAuth | null => {
  const persisted = getPersistedAuth();
  if (persisted?.ik && persisted.email) {
    if (capturedAt) persisted.at = capturedAt;
    if (capturedXsrfToken) persisted.xsrfToken = capturedXsrfToken;
    if (capturedBtai) persisted.btai = capturedBtai;
    if (capturedStorageRequest) persisted.storageRequest = capturedStorageRequest;
    return persisted;
  }

  const globals = getGlobals();
  if (!globals) return null;

  const email = globals[10] as string | undefined;
  const ik = globals[9] as string | undefined;
  const basePath = globals[7] as string | undefined;
  if (!email || !ik || !basePath) return null;

  const match = basePath.match(/\/mail\/u\/(\d+)/);
  const accountIndex = match?.[1] ?? '0';

  const auth: GmailAuth = {
    email,
    ik,
    basePath,
    accountIndex,
    at: capturedAt,
    xsrfToken: capturedXsrfToken,
    btai: capturedBtai,
    storageRequest: capturedStorageRequest,
  };

  setPersistedAuth(auth);
  return auth;
};

export const isAuthenticated = (): boolean => {
  const globals = getGlobals();
  if (!globals) return false;
  const email = globals[10] as string | undefined;
  return typeof email === 'string' && email.includes('@');
};

export const waitForAuth = (): Promise<boolean> =>
  new Promise(resolve => {
    let elapsed = 0;
    const interval = 500;
    const maxWait = 5000;
    const timer = setInterval(() => {
      elapsed += interval;
      if (isAuthenticated()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (elapsed >= maxWait) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });

export const getUserEmail = (): string => getAuth()?.email ?? '';
export const getBasePath = (): string => getAuth()?.basePath ?? '/mail/u/0';

// --- Sync API ---

const buildSyncHeaders = async (auth: GmailAuth): Promise<Record<string, string>> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Google-BTD': '1',
  };
  if (auth.btai) headers['X-Gmail-BTAI'] = auth.btai;
  if (auth.storageRequest) headers['X-Gmail-Storage-Request'] = auth.storageRequest;
  if (auth.xsrfToken) headers['X-Framework-Xsrf-Token'] = auth.xsrfToken;

  const sapisidHash = await generateSapisidHash('https://mail.google.com');
  if (sapisidHash) {
    headers.Authorization = sapisidHash;
    headers['X-Goog-AuthUser'] = auth.accountIndex;
  }
  return headers;
};

const waitForBtai = (): Promise<boolean> =>
  new Promise(resolve => {
    loadCapturedTokens();
    if (capturedBtai) {
      resolve(true);
      return;
    }
    let elapsed = 0;
    const interval = 300;
    const maxWait = 8000;
    const timer = setInterval(() => {
      elapsed += interval;
      loadCapturedTokens();
      if (capturedBtai) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (elapsed >= maxWait) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });

export const gmailSync = async (body: unknown, queryParams: Record<string, string> = {}): Promise<unknown> => {
  const auth = getAuth();
  if (!auth) throw ToolError.auth('Not authenticated — please log in to Gmail.');

  // The BTAI header is required for sync API calls. It is captured from Gmail's
  // own XHR requests via the interceptor. Wait for it if not yet available.
  if (!auth.btai) {
    const gotBtai = await waitForBtai();
    if (gotBtai) auth.btai = capturedBtai;
    if (!auth.btai)
      throw ToolError.auth(
        'Gmail sync headers not captured yet. Gmail needs to make at least one background request. ' +
          'Try clicking on an email or refreshing the page, then retry.',
      );
  }

  const params = new URLSearchParams({ hl: 'en', ...queryParams });
  const url = `https://mail.google.com/sync/u/${auth.accountIndex}/i/s?${params.toString()}`;
  const headers = await buildSyncHeaders(auth);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw ToolError.timeout('Gmail sync request timed out');
    throw ToolError.internal(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearPersistedAuth();
      throw ToolError.auth('Gmail session expired. Please refresh the page.');
    }
    if (response.status === 429) throw ToolError.rateLimited('Gmail rate limited. Please wait.');
    throw ToolError.internal(`Gmail sync failed (${response.status})`);
  }

  return response.json();
};

// --- Action API ---

export const gmailAction = async (act: string, params: Record<string, string> = {}): Promise<string> => {
  const auth = getAuth();
  if (!auth?.at)
    throw ToolError.auth(
      'Action token not captured yet. Interact with Gmail (click an email) to capture the token, then retry.',
    );

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.append(key, value);
  }

  const reqId = Math.floor(Math.random() * 9000000) + 1000000;
  const url = `${auth.basePath}/?ui=2&ik=${auth.ik}&at=${encodeURIComponent(auth.at)}&view=up&act=${act}&_reqid=${reqId}&rt=j`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Same-Domain': '1',
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: form.toString(),
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw ToolError.timeout('Gmail action request timed out');
    throw ToolError.internal(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearPersistedAuth();
      throw ToolError.auth('Gmail session expired. Please refresh the page.');
    }
    throw ToolError.internal(`Gmail action failed (${response.status}): ${act}`);
  }

  return response.text();
};

// --- Sync response parsers ---

const parseParticipant = (p: unknown): { email: string; name: string } => {
  if (!Array.isArray(p)) return { email: '', name: '' };
  return { email: (p[1] as string) ?? '', name: (p[2] as string) ?? '' };
};

const parseParticipantList = (list: unknown): Array<{ email: string; name: string }> => {
  if (!Array.isArray(list)) return [];
  return list.map(parseParticipant);
};

const findHexId = (msg: unknown[]): string => {
  for (let i = 40; i < Math.min(msg.length, 70); i++) {
    const val = msg[i];
    if (typeof val === 'string' && /^[0-9a-f]{16}$/.test(val)) return val;
  }
  return '';
};

export const parseMessageFromSync = (msg: unknown[]): GmailMessage => {
  const bodyContainer = msg[8] as unknown[] | null;
  let bodyHtml = '';
  if (Array.isArray(bodyContainer) && Array.isArray(bodyContainer[1])) {
    for (const part of bodyContainer[1] as unknown[][]) {
      if (Array.isArray(part) && typeof part[1] === 'string') {
        bodyHtml += part[1];
      }
    }
  }

  return {
    messageId: (msg[0] as string) ?? '',
    hexId: findHexId(msg),
    from: parseParticipant(msg[1]),
    to: parseParticipantList(msg[2]),
    cc: parseParticipantList(msg[3]),
    subject: (msg[7] as string) ?? '',
    snippet: (msg[9] as string) ?? '',
    timestamp: (msg[6] as number) ?? 0,
    labels: Array.isArray(msg[10]) ? (msg[10] as string[]) : [],
    bodyHtml,
  };
};

export const parseThreadFromSync = (threadData: unknown[]): GmailThread | null => {
  if (!Array.isArray(threadData) || threadData.length < 3) return null;

  const threadId = (threadData[0] as string) ?? '';
  const threadContent = threadData[2] as unknown[] | null;
  if (!Array.isArray(threadContent)) return null;

  // Find the nested array containing subject + messages
  let summaryArr: unknown[] | null = null;
  for (const item of threadContent) {
    if (!Array.isArray(item)) continue;
    for (const inner of item) {
      if (!Array.isArray(inner)) continue;
      if (typeof inner[0] === 'string' && typeof inner[2] === 'number' && Array.isArray(inner[4])) {
        summaryArr = inner as unknown[];
        break;
      }
    }
    if (summaryArr) break;
  }

  if (!summaryArr) return null;

  const subject = (summaryArr[0] as string) ?? '';
  const timestamp = (summaryArr[2] as number) ?? 0;
  const rawMessages = summaryArr[4] as unknown[][] | null;
  const messages = Array.isArray(rawMessages) ? rawMessages.map(parseMessageFromSync) : [];

  const firstMsg = messages[0];
  return {
    threadId,
    subject,
    snippet: firstMsg?.snippet ?? '',
    timestamp,
    from: firstMsg?.from ?? { email: '', name: '' },
    to: firstMsg?.to ?? [],
    cc: firstMsg?.cc ?? [],
    labels: firstMsg?.labels ?? [],
    messages,
  };
};

export const parseThreadsFromSyncResponse = (resp: unknown): GmailThread[] => {
  if (!Array.isArray(resp)) return [];
  const dataSection = resp[1] as unknown[] | undefined;
  if (!Array.isArray(dataSection)) return [];
  const threadGroups = dataSection[5] as unknown[][] | undefined;
  if (!Array.isArray(threadGroups)) return [];

  const threads: GmailThread[] = [];
  for (const group of threadGroups) {
    if (!Array.isArray(group)) continue;
    for (const threadData of group) {
      if (!Array.isArray(threadData)) continue;
      const thread = parseThreadFromSync(threadData as unknown[]);
      if (thread) threads.push(thread);
    }
  }
  return threads;
};

export const parseLabelCountsFromSync = (resp: unknown): GmailLabelCount[] => {
  if (!Array.isArray(resp)) return [];
  // Label counts are in the third top-level element
  const labelSection = resp[2] as unknown[] | undefined;
  if (!Array.isArray(labelSection)) return [];
  const labelList =
    Array.isArray(labelSection[0]) && Array.isArray(labelSection[0][0])
      ? (labelSection[0] as unknown[][])
      : (labelSection as unknown[][]);
  return labelList
    .filter((item): item is [string, ...unknown[]] => Array.isArray(item) && typeof item[0] === 'string')
    .map(item => ({
      label: item[0],
      unread: typeof item[1] === 'number' ? item[1] : 0,
      total: typeof item[2] === 'number' ? item[2] : 0,
    }));
};

// --- Label name mapping ---

const LABEL_MAP: Record<string, string> = {
  '^i': 'Inbox',
  '^f': 'Sent',
  '^r': 'Drafts',
  '^k': 'Trash',
  '^s': 'Spam',
  '^all': 'All Mail',
  '^b': 'Starred',
  '^t': 'Starred',
  '^iim': 'Important',
  '^io_im': 'Important',
  '^sq_ig_i_personal': 'Personal',
  '^sq_ig_i_social': 'Social',
  '^sq_ig_i_promo': 'Promotions',
  '^smartlabel_notification': 'Updates',
  '^smartlabel_finance': 'Finance',
  '^scheduled': 'Scheduled',
};

export const formatLabelName = (raw: string): string => LABEL_MAP[raw] ?? raw;

export const isUnread = (labels: string[]): boolean => labels.includes('^u');

export const isStarred = (labels: string[]): boolean => labels.includes('^t') || labels.includes('^b');

// --- HTML to plain text ---

export const htmlToText = (html: string): string => {
  if (!html) return '';
  // Strip HTML tags using regex instead of innerHTML (Gmail enforces Trusted Types CSP)
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
