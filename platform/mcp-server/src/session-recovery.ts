/**
 * Session recovery for plugin tool calls.
 *
 * A plugin tool fails without doing anything when its site has no open tab,
 * when no matching tab has a ready adapter, or when the site rejects the
 * session (the adapter throws an `auth` ToolError, typically on HTTP 401).
 * All three have the same remedy a person would apply: open the site. Corporate
 * single sign-on usually re-establishes the session on its own while the page
 * loads, after which the call can run again.
 *
 * Recovery opens a new background tab rather than reloading an existing one,
 * so a tab the user is working in (a call, an unsaved form) is never
 * disturbed. The tab opens at the plugin's homepage, or at the site the plugin
 * was last ready on when that is the user's own host (see `recoveryUrl`). The
 * session counts as recovered only when the page loaded without an HTTP error
 * and the adapter reports ready. A page that answers with an error is closed
 * and reported as SITE_UNAVAILABLE. When the new tab does not become ready (the
 * site is waiting on an interactive sign-in), the tab is left open for the user
 * and the call fails with a structured NEEDS_LOGIN error naming the site and URL.
 *
 * Recovery on failing calls is opt-in (config `sessionRecovery`), because it
 * trades a fast, precise failure for a wait of up to a minute: the right call
 * for an unattended run, not for someone watching. `plugin_check_sessions`
 * with `recover` runs it on request either way.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@opentabs-dev/shared';
import { getConfigDir } from './config.js';
import { dispatchToExtension } from './extension-protocol.js';
import { log } from './logger.js';
import type { RegisteredPlugin, ServerState, TabMapping } from './state.js';
import { getMergedTabMapping } from './state.js';

/** JSON-RPC codes the extension uses for tab problems (see browser-extension json-rpc-errors.ts). */
const NO_USABLE_TAB = -32001;
const ADAPTER_NOT_READY = -32002;

/** How long a recovery tab may take to load, sign in and report its adapter ready. */
export const RECOVERY_READY_TIMEOUT_MS = 60_000;
const RECOVERY_POLL_INTERVAL_MS = 500;

/**
 * After a recovery ends at a sign-in page, further calls report NEEDS_LOGIN
 * for this long without opening another tab, so a run of failing calls leaves
 * one tab for the user rather than one per call.
 */
export const NEEDS_LOGIN_COOLDOWN_MS = 10 * 60_000;

const SESSION_URLS_FILE = 'session-urls.json';
const SESSION_URLS_WRITE_DELAY_MS = 2_000;

/** Why a call could not run in a usable session. */
export type SessionFailure = 'no_tab' | 'not_ready' | 'auth';

export type RecoveryOutcome =
  | { kind: 'recovered'; tabId: number; url: string }
  | { kind: 'needs_login'; url: string; tabId?: number; reason: string }
  /** The page answered with an HTTP error; recovery closed the tab it opened. */
  | { kind: 'page_error'; url: string; status: number }
  | { kind: 'no_url' };

/** Per-server recovery state, kept on ServerState. */
export interface SessionRecoveryState {
  /** Whether failing plugin calls recover on their own (config `sessionRecovery`). */
  enabled: boolean;
  /** Plugin name → the site it was last ready on: origin + the fixed path of its URL pattern. */
  urls: Map<string, string>;
  /** Resolves once `urls` has been merged with the copy on disk. */
  loaded: Promise<void> | null;
  writeTimer: ReturnType<typeof setTimeout> | null;
  /** One recovery per plugin at a time; concurrent failing calls share it. */
  inFlight: Map<string, Promise<RecoveryOutcome>>;
  /** Plugin name → the last recovery that ended at a sign-in page. */
  needsLogin: Map<string, { at: number; outcome: Extract<RecoveryOutcome, { kind: 'needs_login' }> }>;
}

/**
 * Classify a failed dispatch. Returns undefined when recovery is off, for
 * failures recovery cannot help with, and for calls that targeted a tab: recovery runs the call again
 * in a different tab, which would override the caller's choice.
 *
 * Only failures that happen before the tool does anything qualify — a tab that
 * closes mid-call is not retried, because the tool may already have written.
 */
export const classifySessionFailure = (
  state: ServerState,
  error: { code: number; message: string; data?: Record<string, unknown> },
  targeted: boolean,
): SessionFailure | undefined => {
  if (!state.sessionRecovery.enabled || targeted) return undefined;
  if (error.data?.category === 'auth') return 'auth';
  if (error.code === NO_USABLE_TAB && error.message.startsWith('No matching tab')) return 'no_tab';
  if (error.code === ADAPTER_NOT_READY) return 'not_ready';
  return undefined;
};

/** An http(s) URL without its query or fragment, or undefined for anything else. */
const pageUrl = (url: string): URL | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return undefined;
  }
};

/** The literal path a Chrome match pattern requires before its first wildcard (`/fscmUI/*` → `/fscmUI/`). */
const patternPathPrefix = (pattern: string): string => {
  const hostStart = pattern.indexOf('://');
  const pathStart = hostStart < 0 ? -1 : pattern.indexOf('/', hostStart + 3);
  if (pathStart < 0) return '/';
  const path = pattern.slice(pathStart);
  const wildcard = path.indexOf('*');
  return wildcard < 0 ? path : path.slice(0, wildcard);
};

/**
 * The site of a tab in which the plugin was ready: its origin plus the longest
 * fixed path among the plugin's URL patterns that the tab is under. A tab's own
 * path names one record or message, and some sites redirect their root outside
 * the plugin's patterns (Oracle Fusion's root leads to a page the plugin does
 * not match, `/fscmUI/` to its home). A fixed path can also be a kind of link
 * with no page of its own (SharePoint's `/:x:/` before a file's id), which is
 * why `recoveryUrl` prefers a homepage to it.
 */
const siteUrl = (tabUrl: string, urlPatterns: string[]): string | undefined => {
  const page = pageUrl(tabUrl);
  if (!page) return undefined;
  const prefix = urlPatterns
    .map(patternPathPrefix)
    .filter(candidate => page.pathname.startsWith(candidate))
    .reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest), '/');
  return `${page.origin}${prefix}`;
};

const sessionUrlsPath = (): string => join(getConfigDir(), SESSION_URLS_FILE);

const ensureLoaded = (recovery: SessionRecoveryState): Promise<void> => {
  recovery.loaded ??= readFile(sessionUrlsPath(), 'utf-8')
    .then(text => {
      const stored = JSON.parse(text) as unknown;
      if (typeof stored !== 'object' || stored === null) return;
      for (const [plugin, url] of Object.entries(stored)) {
        // A URL seen since startup is newer than the one on disk.
        if (typeof url === 'string' && !recovery.urls.has(plugin)) recovery.urls.set(plugin, url);
      }
    })
    .catch(() => {
      // No file yet, or an unreadable one: start from what this process has seen.
    });
  return recovery.loaded;
};

const scheduleWrite = (recovery: SessionRecoveryState): void => {
  if (recovery.writeTimer) return;
  recovery.writeTimer = setTimeout(() => {
    recovery.writeTimer = null;
    void ensureLoaded(recovery)
      .then(() => atomicWrite(sessionUrlsPath(), `${JSON.stringify(Object.fromEntries(recovery.urls), null, 2)}\n`))
      .catch((err: unknown) => log.warn('Could not save session recovery URLs:', err));
  }, SESSION_URLS_WRITE_DELAY_MS);
  recovery.writeTimer.unref?.();
};

/**
 * Remember where a plugin's site is signed in, from the extension's tab report.
 * Called for every tab sync; writes to disk only when the address changes.
 */
export const rememberReadyTab = (state: ServerState, pluginName: string, mapping: TabMapping): void => {
  const readyTab = mapping.tabs.find(tab => tab.ready);
  const plugin = state.registry.plugins.get(pluginName);
  const url = readyTab && plugin ? siteUrl(readyTab.url, plugin.urlPatterns) : undefined;
  if (!url) return;
  const recovery = state.sessionRecovery;
  if (recovery.urls.get(pluginName) === url) return;
  recovery.urls.set(pluginName, url);
  scheduleWrite(recovery);
};

/**
 * Record that a call to the plugin succeeded, ending any sign-in cooldown. A
 * ready tab alone does not end it: a tab whose server session has expired
 * still reports ready, which is how the failure arose in the first place.
 */
export const markSessionWorking = (state: ServerState, pluginName: string): void => {
  state.sessionRecovery.needsLogin.delete(pluginName);
};

/**
 * The URL recovery opens for a plugin, or undefined when it has no homepage and
 * has never been seen ready. The homepage, the plugin's own entry point, comes
 * first. The site the plugin was last ready on replaces it only when that site
 * is the root of another host: the user's own instance, or the work edition of
 * a site whose homepage is the consumer one. A host's root is always a page,
 * while a fixed path from a URL pattern may not be. Without a homepage, the
 * site last seen ready is the only address known, fixed path included.
 */
export const recoveryUrl = async (state: ServerState, plugin: RegisteredPlugin): Promise<string | undefined> => {
  await ensureLoaded(state.sessionRecovery);
  const lastSite = state.sessionRecovery.urls.get(plugin.name);
  const homepage = plugin.homepage ? pageUrl(plugin.homepage) : undefined;
  if (!homepage) return lastSite;
  const site = lastSite ? pageUrl(lastSite) : undefined;
  return site && site.pathname === '/' && site.origin !== homepage.origin ? site.href : homepage.href;
};

const isTabReady = (state: ServerState, pluginName: string, tabId: number): boolean =>
  getMergedTabMapping(state)
    .get(pluginName)
    ?.tabs.some(tab => tab.tabId === tabId && tab.ready) ?? false;

const waitForReadyTab = async (state: ServerState, pluginName: string, tabId: number): Promise<boolean> => {
  const deadline = Date.now() + RECOVERY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isTabReady(state, pluginName, tabId)) return true;
    await new Promise(resolve => setTimeout(resolve, RECOVERY_POLL_INTERVAL_MS));
  }
  return isTabReady(state, pluginName, tabId);
};

const openRecoveryTab = async (state: ServerState, url: string): Promise<number> => {
  const opened = (await dispatchToExtension(state, 'browser.openTab', { url, active: false })) as { id?: unknown };
  if (typeof opened?.id !== 'number') throw new Error('the browser did not report the new tab');
  return opened.id;
};

/**
 * The HTTP status a tab's page answered with when it loaded, or null when the
 * browser cannot say. An adapter may report ready from the URL alone, so an
 * error page can look ready.
 */
const loadedPageStatus = async (state: ServerState, tabId: number): Promise<number | null> => {
  try {
    const info = (await dispatchToExtension(state, 'browser.getTabInfo', { tabId })) as { httpStatus?: unknown };
    return typeof info?.httpStatus === 'number' ? info.httpStatus : null;
  } catch {
    return null;
  }
};

/** HTTP statuses that ask for credentials: the page is a sign-in, not a missing or broken one. */
const SIGN_IN_STATUSES = new Set([401, 407]);

const closeRecoveryTab = async (state: ServerState, tabId: number): Promise<void> => {
  try {
    await dispatchToExtension(state, 'browser.closeTab', { tabId });
  } catch (err) {
    log.warn(`Session recovery: could not close tab ${tabId}:`, err);
  }
};

const runRecovery = async (
  state: ServerState,
  plugin: RegisteredPlugin,
  onStatus: (message: string) => void,
): Promise<RecoveryOutcome> => {
  const url = await recoveryUrl(state, plugin);
  if (!url) return { kind: 'no_url' };

  onStatus(`Opening ${plugin.displayName} to restore its session`);
  let tabId: number;
  try {
    tabId = await openRecoveryTab(state, url);
  } catch (err) {
    return { kind: 'needs_login', url, reason: `the tab could not be opened (${String(err)})` };
  }
  log.info(`Session recovery: opened tab ${tabId} for ${plugin.name} at ${url}`);

  onStatus(`Waiting for ${plugin.displayName} to sign in`);
  const ready = await waitForReadyTab(state, plugin.name, tabId);
  const status = await loadedPageStatus(state, tabId);
  const signInStatus = status !== null && SIGN_IN_STATUSES.has(status);
  if (status !== null && status >= 400 && !signInStatus) {
    log.info(`Session recovery: ${url} answered HTTP ${status} for ${plugin.name}; closing tab ${tabId}`);
    await closeRecoveryTab(state, tabId);
    return { kind: 'page_error', url, status };
  }
  if (ready && !signInStatus) return { kind: 'recovered', tabId, url };
  return {
    kind: 'needs_login',
    url,
    tabId,
    reason: signInStatus
      ? `the page answered HTTP ${status}, asking for credentials`
      : `the page did not finish signing in within ${RECOVERY_READY_TIMEOUT_MS / 1000}s`,
  };
};

/** Start the sign-in cooldown for a plugin whose site is waiting on an interactive sign-in. */
export const recordNeedsLogin = (
  state: ServerState,
  pluginName: string,
  outcome: Extract<RecoveryOutcome, { kind: 'needs_login' }>,
): void => {
  state.sessionRecovery.needsLogin.set(pluginName, { at: Date.now(), outcome });
};

/**
 * Open the plugin's site in a new background tab and wait for its adapter to
 * become ready. Concurrent callers for one plugin share a single recovery, and
 * a recovery that recently ended at a sign-in page is reported again without
 * opening another tab.
 */
export const recoverSession = (
  state: ServerState,
  plugin: RegisteredPlugin,
  onStatus: (message: string) => void = () => {},
): Promise<RecoveryOutcome> => {
  const recovery = state.sessionRecovery;
  const recent = recovery.needsLogin.get(plugin.name);
  if (recent && Date.now() - recent.at < NEEDS_LOGIN_COOLDOWN_MS) return Promise.resolve(recent.outcome);

  const running = recovery.inFlight.get(plugin.name);
  if (running) return running;

  const outcome = runRecovery(state, plugin, onStatus)
    .then(result => {
      if (result.kind === 'needs_login') recordNeedsLogin(state, plugin.name, result);
      return result;
    })
    .finally(() => recovery.inFlight.delete(plugin.name));
  recovery.inFlight.set(plugin.name, outcome);
  return outcome;
};

/** A recovery that left no usable tab, as an MCP client is told of it. */
export interface RecoveryFailure {
  code: 'NEEDS_LOGIN' | 'SITE_UNAVAILABLE';
  category: 'auth' | 'internal';
  /** A readable line plus a machine-readable block. */
  text: string;
}

/**
 * Describe a recovery that left no usable tab: NEEDS_LOGIN when the site waits
 * on a sign-in or there is no address to open, SITE_UNAVAILABLE when the page
 * recovery opened answered with an HTTP error.
 */
export const describeRecoveryFailure = (
  plugin: RegisteredPlugin,
  outcome: Exclude<RecoveryOutcome, { kind: 'recovered' }>,
  cause: string,
): RecoveryFailure => {
  const site = { plugin: plugin.name, site: plugin.displayName };
  const withBlock = (line: string, block: Record<string, unknown>): string =>
    `${line} Original error: ${cause}\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``;

  if (outcome.kind === 'page_error') {
    const retryable = outcome.status >= 500;
    return {
      code: 'SITE_UNAVAILABLE',
      category: 'internal',
      text: withBlock(
        `[ERROR code=SITE_UNAVAILABLE category=internal retryable=${retryable}] ${plugin.displayName} could not ` +
          `be reopened: ${outcome.url} answered HTTP ${outcome.status}, so recovery closed the tab it opened. ` +
          `Open ${plugin.displayName} in the browser, then try again.`,
        {
          code: 'SITE_UNAVAILABLE',
          category: 'internal',
          retryable,
          ...site,
          url: outcome.url,
          httpStatus: outcome.status,
        },
      ),
    };
  }

  const url = outcome.kind === 'needs_login' ? outcome.url : undefined;
  const tabId = outcome.kind === 'needs_login' ? outcome.tabId : undefined;
  const action =
    outcome.kind === 'no_url'
      ? `There is no known address to open for it — open ${plugin.displayName} in the browser and sign in, then try again.`
      : `It needs an interactive sign-in: sign in at ${url}${tabId !== undefined ? ` (tab ${tabId} is open there)` : ''}, then try again.`;
  const detail = outcome.kind === 'needs_login' ? ` Recovery stopped because ${outcome.reason}.` : '';
  const block = {
    code: 'NEEDS_LOGIN',
    category: 'auth',
    retryable: false,
    ...site,
    ...(url !== undefined && { url }),
    ...(tabId !== undefined && { tabId }),
  };
  return {
    code: 'NEEDS_LOGIN',
    category: 'auth',
    text: withBlock(
      `[ERROR code=NEEDS_LOGIN category=auth retryable=false] ${plugin.displayName} is not signed in. ${action}${detail}`,
      block,
    ),
  };
};
