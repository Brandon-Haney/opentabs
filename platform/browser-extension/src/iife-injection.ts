import { toErrorMessage } from '@opentabs-dev/shared';
import { INJECTION_RETRY_DELAY_MS, isValidPluginName } from './constants.js';
import { getAllPluginMeta } from './plugin-storage.js';
import { urlMatchesPatterns } from './tab-matching.js';

/** Names reserved for platform use — rejected at the injection layer as defense-in-depth */
const RESERVED_NAMES = new Set(['system', 'browser', 'opentabs', 'extension', 'config', 'plugin', 'tool', 'mcp']);

const isSafePluginName = (name: string): boolean => isValidPluginName(name) && !RESERVED_NAMES.has(name);

/** Check if an adapter for the given plugin is already injected in a tab */
const isAdapterPresent = async (tabId: number, pluginName: string): Promise<boolean> => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (pName: string) => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, unknown> }
          | undefined;
        return ot?.adapters?.[pName] !== undefined;
      },
      args: [pluginName],
    });
    const first = results[0] as { result?: unknown } | undefined;
    return first?.result === true;
  } catch (err) {
    console.warn(`[opentabs] isAdapterPresent failed for tab ${String(tabId)}, plugin ${pluginName}:`, err);
    return false;
  }
};

/**
 * Read the adapter hash from the page for a given plugin. Returns undefined on failure.
 * Property name must match ADAPTER_HASH_PROP ('__adapterHash') from constants.ts.
 * Cannot reference the constant inside the func — executeScript func is a serialized closure.
 */
const readAdapterHash = async (tabId: number, pluginName: string): Promise<string | undefined> => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (pName: string) => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as
          | { adapters?: Record<string, { __adapterHash?: string }> }
          | undefined;
        return ot?.adapters?.[pName]?.__adapterHash;
      },
      args: [pluginName],
    });
    const first = results[0] as { result?: unknown } | undefined;
    return typeof first?.result === 'string' ? first.result : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Verify that the injected adapter's content hash matches the expected hash.
 * Returns true if hashes match, false otherwise. Does not throw.
 */
const verifyAdapterHash = async (tabId: number, pluginName: string, expectedHash: string): Promise<boolean> => {
  const hash = await readAdapterHash(tabId, pluginName);
  return hash === expectedHash;
};

/**
 * Inject a log relay listener into a tab's ISOLATED world.
 * Listens for 'opentabs:plugin-logs' postMessages from the MAIN world adapter
 * and forwards batched log entries to the background via chrome.runtime.sendMessage.
 *
 * A per-tab cryptographic nonce prevents malicious page scripts from spoofing
 * log entries. The nonce is generated here and shared with both worlds:
 * - ISOLATED world: validates `data.nonce` on every received postMessage
 * - MAIN world: stored on `globalThis.__openTabs._logNonce`, read by the
 *   adapter IIFE's flushLogs() and included in every postMessage call
 */
const injectLogRelay = async (tabId: number): Promise<void> => {
  const nonce = crypto.randomUUID();

  try {
    // 1. Install the ISOLATED world listener with the nonce for validation
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (n: string) => {
        // Idempotent guard: only register the listener once per tab.
        // When re-invoked (e.g., on re-injection), the existing listener
        // stays in place — stale nonces are cleared and only the new nonce
        // is accepted. The adapter in MAIN world will use the new nonce
        // (set in step 2) on its next flush.
        const guard = '__opentabs_log_relay';
        const win = window as unknown as Record<string, unknown>;
        if (win[guard]) {
          // Replace stale nonces with the new nonce — old adapters are gone after re-injection
          const nonceSet = win.__opentabs_log_nonces as Set<string> | undefined;
          if (nonceSet) {
            nonceSet.clear();
            nonceSet.add(n);
          }
          return;
        }
        win[guard] = true;

        const nonces = new Set<string>([n]);
        win.__opentabs_log_nonces = nonces;

        window.addEventListener('message', event => {
          if (event.source !== window) return;
          const data = event.data as Record<string, unknown> | undefined;
          if (!data || data.type !== 'opentabs:plugin-logs') return;
          if (typeof data.nonce !== 'string' || !nonces.has(data.nonce)) return;
          const plugin = data.plugin;
          const entries = data.entries;
          if (typeof plugin !== 'string' || !Array.isArray(entries) || entries.length === 0) return;
          chrome.runtime.sendMessage({ type: 'plugin:logs', plugin, entries }).catch(() => {
            // Background may not be listening — drop silently
          });
        });
      },
      args: [nonce],
    });

    // 2. Inject the nonce into MAIN world on globalThis.__openTabs._logNonce.
    //    The adapter IIFE reads this value in its flushLogs() function and
    //    includes it in every postMessage call. On re-injection, the nonce is
    //    updated so the adapter picks up the new value on the next flush.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (n: string) => {
        const ot = ((globalThis as Record<string, unknown>).__openTabs ?? {}) as Record<string, unknown>;
        (globalThis as Record<string, unknown>).__openTabs = ot;
        ot._logNonce = n;
      },
      args: [nonce],
    });
  } catch (err) {
    console.warn(`[opentabs] injectLogRelay failed for tab ${String(tabId)}:`, err);
  }
};

/**
 * Inject a readiness-change relay listener into a tab's ISOLATED world.
 * Listens for 'opentabs:readiness-changed' postMessages from the MAIN world
 * adapter and forwards them to the background via chrome.runtime.sendMessage.
 *
 * Uses a separate nonce from the log relay to prevent cross-channel spoofing.
 * The nonce is generated here and shared with both worlds:
 * - ISOLATED world: validates `data.nonce` on every received postMessage
 * - MAIN world: stored on `globalThis.__openTabs._readinessNonce`, read by
 *   the adapter IIFE's `_notifyReadinessChanged` closure
 */
const injectReadinessRelay = async (tabId: number): Promise<void> => {
  const nonce = crypto.randomUUID();

  try {
    // 1. Install the ISOLATED world listener with the nonce for validation
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (n: string) => {
        const guard = '__opentabs_readiness_relay';
        const win = window as unknown as Record<string, unknown>;
        if (win[guard]) {
          const nonceSet = win.__opentabs_readiness_nonces as Set<string> | undefined;
          if (nonceSet) {
            nonceSet.clear();
            nonceSet.add(n);
          }
          return;
        }
        win[guard] = true;

        const nonces = new Set<string>([n]);
        win.__opentabs_readiness_nonces = nonces;

        window.addEventListener('message', event => {
          if (event.source !== window) return;
          const data = event.data as Record<string, unknown> | undefined;
          if (!data || data.type !== 'opentabs:readiness-changed') return;
          if (typeof data.nonce !== 'string' || !nonces.has(data.nonce)) return;
          const plugin = data.plugin;
          if (typeof plugin !== 'string') return;
          chrome.runtime.sendMessage({ type: 'plugin:readinessChanged', plugin }).catch(() => {
            // Background may not be listening — drop silently
          });
        });
      },
      args: [nonce],
    });

    // 2. Inject the nonce into MAIN world on globalThis.__openTabs._readinessNonce.
    //    The adapter IIFE's _notifyReadinessChanged closure reads this value and
    //    includes it in every postMessage call. On re-injection, the nonce is
    //    updated so the adapter picks up the new value on the next call.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (n: string) => {
        const ot = ((globalThis as Record<string, unknown>).__openTabs ?? {}) as Record<string, unknown>;
        (globalThis as Record<string, unknown>).__openTabs = ot;
        ot._readinessNonce = n;
      },
      args: [nonce],
    });
  } catch (err) {
    console.warn(`[opentabs] injectReadinessRelay failed for tab ${String(tabId)}:`, err);
  }
};

/**
 * Inject resolved plugin settings into a tab's MAIN world.
 * Sets globalThis.__openTabs.pluginConfig so getConfig() works in
 * onActivate and tool handlers. Must run before the adapter IIFE.
 */
const injectPluginConfig = async (
  tabId: number,
  settings: Record<string, string | number | boolean>,
): Promise<void> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (config: Record<string, string | number | boolean>) => {
        const ot = ((globalThis as Record<string, unknown>).__openTabs ?? {}) as Record<string, unknown>;
        (globalThis as Record<string, unknown>).__openTabs = ot;
        ot.pluginConfig = config;
      },
      args: [settings],
    });
  } catch (err) {
    console.warn(`[opentabs] injectPluginConfig failed for tab ${String(tabId)}:`, err);
  }
};

/**
 * Inject a token-refresh relay listener into a tab's ISOLATED world.
 * Listens for 'opentabs:request-token-refresh' postMessages from MAIN world
 * adapters (triggered on 401 when using a bridged Graph token) and forwards
 * them to the background to re-read from Outlook and re-inject.
 */
const injectTokenRefreshRelay = async (tabId: number): Promise<void> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const guard = '__opentabs_token_refresh_relay';
        const win = window as unknown as Record<string, unknown>;
        if (win[guard]) return;
        win[guard] = true;

        window.addEventListener('message', event => {
          if (event.source !== window) return;
          const data = event.data as Record<string, unknown> | undefined;
          if (!data || data.type !== 'opentabs:request-token-refresh') return;
          const plugin = data.plugin;
          if (typeof plugin !== 'string') return;
          chrome.runtime.sendMessage({ type: 'plugin:requestTokenRefresh', plugin }).catch(() => {});
        });
      },
      args: [],
    });
  } catch (err) {
    console.warn(`[opentabs] injectTokenRefreshRelay failed for tab ${String(tabId)}:`, err);
  }
};

/**
 * Inject an externally-sourced Graph API token into a tab's MAIN world.
 * Sets globalThis.__openTabs.graphToken so plugins on domains with encrypted
 * MSAL caches (e.g., SharePoint) can use it as an auth fallback.
 */
const injectGraphToken = async (tabId: number, token: string, expiresOn?: number): Promise<void> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (t: string, exp: number | undefined) => {
        const ot = ((globalThis as Record<string, unknown>).__openTabs ?? {}) as Record<string, unknown>;
        (globalThis as Record<string, unknown>).__openTabs = ot;
        ot.graphToken = { token: t, expiresOn: exp };
      },
      args: [token, expiresOn],
    });
  } catch (err) {
    console.warn(`[opentabs] injectGraphToken failed for tab ${String(tabId)}:`, err);
  }
};

/** URL patterns for M365 apps that store unencrypted MSAL Graph tokens. */
const M365_TOKEN_SOURCE_PATTERNS = [
  '*://outlook.cloud.microsoft/*',
  '*://outlook.live.com/*',
  '*://outlook.office.com/*',
  '*://outlook.office365.com/*',
  '*://teams.microsoft.com/*',
  '*://teams.live.com/*',
];

/**
 * Read an unencrypted Graph API access token with Files scope from an Outlook
 * or Teams tab's localStorage. Returns null if no valid token is found.
 * Skips expired tokens so the caller can fall back to the refresh grant.
 */
const readGraphTokenFromM365Tab = async (): Promise<{ token: string; expiresOn?: number } | null> => {
  const tabIds = await queryMatchingTabIds(M365_TOKEN_SOURCE_PATTERNS);
  if (tabIds.length === 0) return null;

  for (const tabId of tabIds) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.includes('accesstoken') || !key.includes('graph.microsoft.com')) continue;
            try {
              const parsed = JSON.parse(localStorage.getItem(key) ?? '');
              if (!parsed.secret) continue;
              const target: string = parsed.target ?? '';
              if (!target.toLowerCase().includes('files.readwrite')) continue;
              const expiresOn = Number.parseInt(parsed.expires_on ?? parsed.expiresOn, 10);
              if (expiresOn && expiresOn < Math.floor(Date.now() / 1000)) continue;
              return { token: parsed.secret as string, expiresOn: expiresOn || undefined };
            } catch {
              // Parse failed — try next entry
            }
          }
          return null;
        },
        args: [],
      });
      const first = results[0] as { result?: { token: string; expiresOn?: number } | null } | undefined;
      if (first?.result) return first.result;
    } catch {
      // Tab inaccessible — try next tab
    }
  }
  return null;
};

/**
 * Read the MSAL refresh token and associated metadata from an Outlook or Teams tab.
 * Returns the refresh token, client ID, and tenant ID needed for the OAuth
 * refresh_token grant.
 */
const readRefreshTokenFromM365Tab = async (): Promise<{
  refreshToken: string;
  clientId: string;
  tenantId: string;
} | null> => {
  const tabIds = await queryMatchingTabIds(M365_TOKEN_SOURCE_PATTERNS);
  if (tabIds.length === 0) return null;

  for (const tabId of tabIds) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.toLowerCase().includes('refreshtoken')) continue;
            try {
              const parsed = JSON.parse(localStorage.getItem(key) ?? '');
              if (!parsed.secret || !parsed.clientId) continue;
              // Derive tenant ID from the home_account_id (format: "uid.tid")
              const homeAccountId: string = parsed.home_account_id ?? parsed.homeAccountId ?? '';
              const dotIdx = homeAccountId.indexOf('.');
              const tenantId = dotIdx > 0 ? homeAccountId.slice(dotIdx + 1) : '';
              if (!tenantId) continue;
              return {
                refreshToken: parsed.secret as string,
                clientId: parsed.clientId as string,
                tenantId,
              };
            } catch {
              // Parse failed — try next entry
            }
          }
          return null;
        },
        args: [],
      });
      const first = results[0] as
        | {
            result?: { refreshToken: string; clientId: string; tenantId: string } | null;
          }
        | undefined;
      if (first?.result) return first.result;
    } catch {
      // Tab inaccessible — try next tab
    }
  }
  return null;
};

/**
 * Use the OAuth refresh_token grant to get a fresh Graph API access token.
 * Runs in the background service worker (no CORS restrictions).
 */
const refreshAccessTokenViaOAuth = async (
  refreshToken: string,
  tenantId: string,
  clientId: string,
): Promise<{ token: string; expiresOn: number } | null> => {
  try {
    const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    const expiresOn = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
    return { token: data.access_token, expiresOn };
  } catch {
    return null;
  }
};

/**
 * Acquire a Graph API token with Files.ReadWrite scope from an Outlook or Teams
 * tab. Tries the cached access token first, then falls back to the OAuth
 * refresh_token grant for reliability.
 */
const acquireGraphToken = async (): Promise<{ token: string; expiresOn?: number } | null> => {
  // Try reading a fresh access token directly
  const existing = await readGraphTokenFromM365Tab();
  if (existing?.expiresOn && existing.expiresOn > Math.floor(Date.now() / 1000) + 300) {
    return existing;
  }

  // Access token expired or about to expire — use refresh_token grant
  const refreshInfo = await readRefreshTokenFromM365Tab();
  if (refreshInfo) {
    const fresh = await refreshAccessTokenViaOAuth(
      refreshInfo.refreshToken,
      refreshInfo.tenantId,
      refreshInfo.clientId,
    );
    if (fresh) return fresh;
  }

  // Fall back to the possibly-stale access token (better than nothing)
  return existing;
};

/**
 * Bridge a Graph API token from an Outlook/Teams tab into a SharePoint tab.
 * SharePoint encrypts its MSAL tokens, making them unreadable by adapters.
 * M365 apps (Outlook, Teams) store unencrypted Graph tokens with
 * Files.ReadWrite.All scope that work for the Excel workbook API.
 * Falls back to the OAuth refresh_token grant when the access token is expired.
 */
const bridgeGraphTokenIfNeeded = async (tabId: number): Promise<void> => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/\.sharepoint\.com/i.test(tab.url)) return;

    const graphToken = await acquireGraphToken();
    if (graphToken) {
      await injectGraphToken(tabId, graphToken.token, graphToken.expiresOn);
    }
  } catch {
    // Best-effort — proceed with injection even without bridged token
  }
};

/**
 * Inject an adapter file into a single tab via chrome.scripting.executeScript.
 *
 * Uses content-hashed filenames so each adapter version gets a unique path,
 * bypassing Chrome's aggressive caching of executeScript({ files }) content.
 * The `files` option bypasses all page CSP restrictions because file-based
 * injection is not subject to page CSP.
 */
const injectAdapterFile = async (
  tabId: number,
  pluginName: string,
  adapterHash?: string,
  adapterFilePath?: string,
  resolvedSettings?: Record<string, string | number | boolean>,
): Promise<void> => {
  // Inject relays in ISOLATED world before the adapter IIFE (MAIN world)
  // so postMessage listeners are in place when the adapter starts.
  await injectLogRelay(tabId);
  await injectReadinessRelay(tabId);

  // Inject resolved settings into MAIN world before the adapter IIFE so
  // getConfig() returns values in onActivate and tool handlers.
  await injectPluginConfig(tabId, resolvedSettings ?? {});

  // Bridge a Graph API token from Outlook for SharePoint tabs where
  // MSAL tokens are encrypted and unreadable by the adapter.
  await bridgeGraphTokenIfNeeded(tabId);

  // Install a relay for token refresh requests from adapters on SharePoint.
  // When a bridged token expires and the adapter gets a 401, it posts a
  // 'opentabs:request-token-refresh' message which is forwarded to the
  // background to re-read from Outlook and re-inject.
  await injectTokenRefreshRelay(tabId);

  const adapterFile = adapterFilePath ?? `adapters/${pluginName}.js`;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: [adapterFile],
    });
  } catch (err) {
    throw new Error(`Failed to inject adapter file '${adapterFile}' into tab ${String(tabId)}: ${toErrorMessage(err)}`);
  }

  if (adapterHash) {
    const hashMatched = await verifyAdapterHash(tabId, pluginName, adapterHash);
    if (!hashMatched) {
      // Retry once after a short delay — the file may have been partially written
      await new Promise(resolve => setTimeout(resolve, INJECTION_RETRY_DELAY_MS));
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: [adapterFile],
        });
      } catch (err) {
        throw new Error(
          `Failed to re-inject adapter file '${adapterFile}' into tab ${String(tabId)}: ${toErrorMessage(err)}`,
        );
      }

      const retryMatched = await verifyAdapterHash(tabId, pluginName, adapterHash);
      if (!retryMatched) {
        const actualHash = await readAdapterHash(tabId, pluginName);
        throw new Error(
          `Adapter hash mismatch for ${pluginName} after retry: expected ${adapterHash}, got ${String(actualHash)}`,
        );
      }
    }
  }
};

/**
 * Collect all unique tab IDs matching the given URL patterns,
 * excluding tabs whose URL matches any exclude pattern.
 * Queries each pattern independently and deduplicates by tab ID.
 */
const queryMatchingTabIds = async (urlPatterns: string[], excludePatterns?: string[]): Promise<number[]> => {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const pattern of urlPatterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        if (tab.id !== undefined && !seen.has(tab.id)) {
          if (
            excludePatterns &&
            excludePatterns.length > 0 &&
            tab.url &&
            urlMatchesPatterns(tab.url, excludePatterns)
          ) {
            continue;
          }
          seen.add(tab.id);
          ids.push(tab.id);
        }
      }
    } catch (err) {
      console.warn(`[opentabs] chrome.tabs.query failed for pattern ${pattern}:`, err);
    }
  }
  return ids;
};

/**
 * Replace a tab's frozen `__openTabs` container with a mutable copy,
 * preserving all adapter entries (including the one about to be re-injected).
 *
 * The `hashAndFreeze` snippet (appended by the plugin build) makes
 * `__openTabs.adapters` non-writable and `adapters[pluginName]` non-configurable.
 * When the adapter IIFE runs during re-injection, its entry code
 * (`globalThis.__openTabs.adapters = globalThis.__openTabs.adapters || {}`)
 * throws `TypeError: Cannot assign to read only property 'adapters'` in
 * strict mode. This function rebuilds `__openTabs` and `adapters` as fresh
 * mutable objects so the IIFE can initialize without errors.
 *
 * The target plugin's adapter entry is preserved (as a writable property) so
 * the IIFE wrapper's own teardown logic can find the existing adapter, call
 * `onDeactivate()` and `teardown()`, then replace it — maintaining the correct
 * lifecycle hook ordering (constructor clears stale markers, then teardown sets
 * fresh markers).
 */
const prepareForReinjection = async (tabId: number): Promise<void> => {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const ot = (globalThis as Record<string, unknown>).__openTabs as Record<string, unknown> | undefined;
        if (!ot) return;
        const adapters = ot.adapters as Record<string, unknown> | undefined;
        if (!adapters) return;

        // Build a new adapters object preserving all entries. Each adapter's
        // value is copied directly (the frozen adapter object stays frozen for
        // integrity), but the PROPERTY on the new container is writable +
        // configurable so the IIFE wrapper can delete/replace it.
        const newAdapters: Record<string, unknown> = {};
        for (const key of Object.keys(adapters)) {
          newAdapters[key] = adapters[key];
        }

        // Build a new __openTabs object, copying all non-adapters properties.
        const newOt: Record<string, unknown> = {};
        for (const key of Object.keys(ot)) {
          if (key === 'adapters') continue;
          const desc = Object.getOwnPropertyDescriptor(ot, key);
          if (desc) Object.defineProperty(newOt, key, desc);
        }
        newOt.adapters = newAdapters;

        // Replace globalThis.__openTabs with the new mutable container
        (globalThis as Record<string, unknown>).__openTabs = newOt;
      },
      args: [],
    })
    .catch((err: unknown) => {
      console.warn(`[opentabs] prepareForReinjection failed:`, err);
    });
};

/**
 * Injects a plugin's adapter IIFE into all tabs matching its URL patterns.
 *
 * @param pluginName - The plugin's unique name (validated against reserved names)
 * @param urlPatterns - Chrome match patterns identifying which tabs to inject into
 * @param forceReinject - When `true`, re-inject even if the adapter is already
 *   present (used by plugin.update to overwrite stale adapter code). When `false`
 *   (default), tabs that already have the adapter are skipped.
 * @param adapterHash - Expected content hash for post-injection integrity check
 * @param adapterFile - Relative path to the content-hashed adapter file (e.g., "adapters/my-plugin-a1b2c3d4.js")
 * @param skipIfHashMatches - When provided alongside `forceReinject`, skip
 *   re-injection on tabs where the adapter is already present and its
 *   `__adapterHash` matches this value. Used by sync.full to avoid
 *   re-injecting unchanged adapters on WebSocket reconnect. Must NOT be
 *   used by plugin.update (the embedded hash is computed before the
 *   hashAndFreeze snippet is appended, so it can match even when the
 *   file content has changed).
 * @returns Tab IDs where injection succeeded
 */
const injectPluginIntoMatchingTabs = async (
  pluginName: string,
  urlPatterns: string[],
  forceReinject = false,
  adapterHash?: string,
  adapterFile?: string,
  skipIfHashMatches?: string,
  excludePatterns?: string[],
  resolvedSettings?: Record<string, string | number | boolean>,
): Promise<number[]> => {
  if (!isSafePluginName(pluginName)) {
    console.warn(`[opentabs] Skipping injection for unsafe plugin name: ${pluginName}`);
    return [];
  }

  const tabIds = await queryMatchingTabIds(urlPatterns, excludePatterns);

  // Process all tabs in parallel: check presence + inject
  const results = await Promise.allSettled(
    tabIds.map(async tabId => {
      if (!forceReinject && (await isAdapterPresent(tabId, pluginName))) {
        return tabId;
      }

      // When skipIfHashMatches is provided (sync.full reconnect scenario),
      // check if the adapter is already present with a matching hash.
      // If so, skip injection entirely — the adapter code hasn't changed.
      if (forceReinject && skipIfHashMatches) {
        const existingHash = await readAdapterHash(tabId, pluginName);
        if (existingHash === skipIfHashMatches) {
          return tabId;
        }
      }

      // Replace frozen __openTabs/adapters with mutable copies so the new
      // IIFE can initialize. The IIFE wrapper handles its own teardown
      // lifecycle (onDeactivate → teardown → delete → install new adapter)
      // in the correct order before installing the new adapter.
      if (forceReinject) {
        await prepareForReinjection(tabId);
      }

      await injectAdapterFile(tabId, pluginName, adapterHash, adapterFile, resolvedSettings);
      return tabId;
    }),
  );

  const injectedTabIds: number[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      injectedTabIds.push(result.value);
    }
  }

  return injectedTabIds;
};

/**
 * Injects all stored plugins whose URL patterns match the given tab.
 * Called on `chrome.tabs.onUpdated` (status=complete) so that tabs opened
 * after `sync.full` still get their adapter files.
 *
 * @param tabId - The Chrome tab ID to inject adapters into
 * @param tabUrl - The tab's current URL, used to filter plugins by URL pattern match
 */
const injectPluginsIntoTab = async (tabId: number, tabUrl: string): Promise<void> => {
  const index = await getAllPluginMeta();
  const plugins = Object.values(index);

  if (plugins.length === 0) return;

  // Filter to plugins whose URL patterns match this tab and have safe names
  const matching = plugins.filter(
    p => isSafePluginName(p.name) && urlMatchesPatterns(tabUrl, p.urlPatterns, p.excludePatterns),
  );
  if (matching.length === 0) return;

  // Check presence for all matching plugins in parallel
  const presenceResults = await Promise.allSettled(
    matching.map(async plugin => ({
      plugin,
      present: await isAdapterPresent(tabId, plugin.name),
    })),
  );

  const needsInjection = presenceResults
    .filter(
      (r): r is PromiseFulfilledResult<{ plugin: (typeof matching)[0]; present: boolean }> =>
        r.status === 'fulfilled' && !r.value.present,
    )
    .map(r => r.value.plugin);

  if (needsInjection.length === 0) return;

  // Inject all needed plugins in parallel
  await Promise.allSettled(
    needsInjection.map(async plugin => {
      try {
        await injectAdapterFile(tabId, plugin.name, plugin.adapterHash, plugin.adapterFile, plugin.resolvedSettings);
      } catch (err) {
        console.warn(`[opentabs] Injection failed for tab ${String(tabId)}, plugin ${plugin.name}:`, err);
      }
    }),
  );
};

/**
 * Removes an injected adapter from all tabs matching the plugin's URL patterns.
 * Calls the adapter's `teardown()` function and deletes it from `__openTabs.adapters`.
 *
 * @param pluginName - The plugin whose adapter should be removed
 * @param urlPatterns - Chrome match patterns identifying which tabs to clean up
 */
const cleanupAdaptersInMatchingTabs = async (
  pluginName: string,
  urlPatterns: string[],
  excludePatterns?: string[],
): Promise<void> => {
  if (!isSafePluginName(pluginName)) {
    console.warn(`[opentabs] Skipping cleanup for unsafe plugin name: ${pluginName}`);
    return;
  }

  const tabIds = await queryMatchingTabIds(urlPatterns, excludePatterns);

  // Run cleanup scripts in parallel across all matching tabs
  await Promise.allSettled(
    tabIds.map(async tabId => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (pName: string) => {
            const ot = (globalThis as Record<string, unknown>).__openTabs as
              | { adapters?: Record<string, { teardown?: () => void }> }
              | undefined;
            const adapters = ot?.adapters;
            if (!adapters) return;
            const adapter = adapters[pName];
            if (adapter) {
              if (typeof adapter.teardown === 'function') {
                try {
                  adapter.teardown();
                } catch (e) {
                  console.warn('[opentabs] teardown error:', e);
                }
              }
              // Attempt deletion; if the property is non-configurable (locked
              // by hashAndFreeze), rebuild the adapters container without the
              // removed plugin and replace __openTabs on globalThis.
              if (!Reflect.deleteProperty(adapters, pName)) {
                const newAdapters: Record<string, unknown> = {};
                for (const key of Object.keys(adapters)) {
                  if (key !== pName) {
                    const desc = Object.getOwnPropertyDescriptor(adapters, key);
                    if (desc) Object.defineProperty(newAdapters, key, desc);
                  }
                }
                delete (globalThis as Record<string, unknown>).__openTabs;
                (globalThis as Record<string, unknown>).__openTabs = Object.assign({}, ot, {
                  adapters: newAdapters,
                });
              }
            }
          },
          args: [pluginName],
        });
      } catch (err) {
        console.warn(`[opentabs] Cleanup failed for tab ${String(tabId)}, plugin ${pluginName}:`, err);
      }
    }),
  );
};

/**
 * Re-injects all stored plugins into their matching tabs on extension startup.
 * Runs all plugin injections in parallel, logging warnings for any failures.
 */
const reinjectStoredPlugins = async (): Promise<void> => {
  const index = await getAllPluginMeta();
  const plugins = Object.values(index);
  if (plugins.length === 0) return;

  const results = await Promise.allSettled(
    plugins.map(plugin =>
      injectPluginIntoMatchingTabs(
        plugin.name,
        plugin.urlPatterns,
        false,
        plugin.adapterHash,
        plugin.adapterFile,
        undefined,
        plugin.excludePatterns,
        plugin.resolvedSettings,
      ),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result && result.status === 'rejected') {
      const plugin = plugins[i];
      console.warn(`[opentabs] Failed to reinject stored plugin ${plugin?.name ?? 'unknown'}:`, result.reason);
    }
  }
};

/**
 * Re-read the Graph token from an Outlook tab and inject it into the requesting
 * SharePoint tab. Called when an adapter reports a 401 on a bridged token.
 */
const refreshGraphTokenForTab = async (tabId: number): Promise<void> => {
  const graphToken = await acquireGraphToken();
  if (graphToken) {
    await injectGraphToken(tabId, graphToken.token, graphToken.expiresOn);
  }
};

export {
  cleanupAdaptersInMatchingTabs,
  injectPluginIntoMatchingTabs,
  injectPluginsIntoTab,
  isSafePluginName,
  queryMatchingTabIds,
  refreshGraphTokenForTab,
  reinjectStoredPlugins,
};
