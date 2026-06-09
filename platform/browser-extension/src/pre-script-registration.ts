import type { PluginMeta } from './extension-messages.js';

/** Registration ID for a plugin's pre-script content script */
const registrationId = (pluginName: string): string => `opentabs-pre-${pluginName}`;

/**
 * Safe filename pattern for pre-script files.
 * Must match adapters/<name>-prescript-<hash8>.js — prevents path traversal
 * and ensures only content-hashed files from the adapters/ directory are registered.
 */
const SAFE_PRE_SCRIPT_FILENAME = /^adapters\/[a-z0-9][a-z0-9-]*-prescript-[0-9a-f]{8}\.js$/;

/**
 * Retrieve IDs of all currently registered opentabs pre-script content scripts.
 * Filters by the 'opentabs-pre-' prefix to avoid touching unrelated registrations.
 */
const getRegisteredPreScriptIds = async (): Promise<string[]> => {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return scripts.filter(s => s.id.startsWith('opentabs-pre-')).map(s => s.id);
  } catch (err) {
    console.warn('[opentabs] getRegisteredPreScriptIds failed:', err);
    return [];
  }
};

/**
 * Register or re-register a pre-script content script for a plugin.
 * Returns early with a console.warn if preScriptFile is absent or fails the
 * safe filename check — prevents path traversal from a compromised MCP server.
 */
const upsertPreScript = async (meta: PluginMeta): Promise<void> => {
  if (!meta.preScriptFile) return;

  if (!SAFE_PRE_SCRIPT_FILENAME.test(meta.preScriptFile)) {
    console.warn(
      `[opentabs] refusing to register pre-script with unexpected filename: "${meta.preScriptFile}" (plugin: ${meta.name})`,
    );
    return;
  }

  const id = registrationId(meta.name);

  // Unregister first so re-registration always succeeds, even if a stale
  // registration for the same id already exists.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // No existing registration — ignore
  }

  try {
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: meta.urlPatterns,
        ...(meta.excludePatterns && meta.excludePatterns.length > 0 ? { excludeMatches: meta.excludePatterns } : {}),
        js: [meta.preScriptFile],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true,
        // Inject into every matching same-origin frame, not just the top
        // window. Auth frameworks such as SharePoint's WAC/Owl mint MSAL
        // silent-renewal tokens inside same-origin sub-frames; a pre-script
        // that runs only in the top window never sees those requests, because
        // each frame has its own `window.fetch`/`XMLHttpRequest` to intercept.
        //
        // Per-frame injection is safe because each frame is a separate realm:
        // the script runs independently in each, top-frame behavior is
        // unchanged, and every frame's `globalThis.__openTabs` store is its
        // own — there is no shared in-page state to double-write. A pre-script
        // that wants a captured value to reach the top-frame adapter bridges
        // it through a same-origin channel (e.g. `localStorage`), which all
        // frames share; the per-realm `__openTabs` namespace does not cross
        // frames. Cross-origin frames (e.g. a WOPI document canvas) are never
        // injected — Chrome only matches frames whose URL satisfies
        // `meta.urlPatterns`.
        allFrames: true,
      },
    ]);
  } catch (err) {
    console.warn(`[opentabs] registerContentScripts failed for plugin ${meta.name}:`, err);
  }
};

/**
 * Unregister the pre-script content script for a plugin.
 * Swallows errors — safe to call even if no registration exists.
 */
const removePreScript = async (pluginName: string): Promise<void> => {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [registrationId(pluginName)] });
  } catch {
    // No registration exists — ignore
  }
};

/**
 * Synchronize registered pre-script content scripts to match the given plugin set.
 * Unregisters stale opentabs-pre-* IDs not in the expected set, then upserts
 * each plugin's pre-script in parallel.
 */
const syncPreScripts = async (metas: PluginMeta[]): Promise<void> => {
  const expectedIds = new Set(metas.filter(m => m.preScriptFile).map(m => registrationId(m.name)));

  const currentIds = await getRegisteredPreScriptIds();
  const staleIds = currentIds.filter(id => !expectedIds.has(id));

  if (staleIds.length > 0) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: staleIds });
    } catch (err) {
      console.warn('[opentabs] Failed to unregister stale pre-scripts:', err);
    }
  }

  await Promise.allSettled(metas.map(meta => upsertPreScript(meta)));
};

export { registrationId, removePreScript, syncPreScripts, upsertPreScript };
