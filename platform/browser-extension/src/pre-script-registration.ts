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
        // Register in all matching same-origin frames. SharePoint's WAC/Owl
        // framework uses same-origin sub-frames for MSAL silent renewal, and
        // pre-scripts that only run in the top window miss the refreshed
        // tokens. Cross-origin frames (e.g. the WOPI Excel canvas) are
        // unaffected — Chrome only injects into frames whose URL matches
        // `meta.urlPatterns`. All shipped pre-scripts use a `Symbol.for(...)`
        // marker so a second injection into the same realm is a no-op.
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
