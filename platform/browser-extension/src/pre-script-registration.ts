import type { PluginMeta } from './extension-messages.js';

/** Registration ID for a plugin's pre-script content script */
const registrationId = (pluginName: string): string => `opentabs-pre-${pluginName}`;

/**
 * Registration ID for a plugin's embedded-frame pre-script content script.
 * Registered on `preScriptFrameMatches` when the plugin declares them, so the
 * same pre-script runs in cross-origin child frames beyond the plugin's own
 * `urlPatterns`. The `__frames` suffix uses underscores, which valid plugin
 * names never contain, so this id can never collide with a `registrationId`.
 */
const frameRegistrationId = (pluginName: string): string => `opentabs-pre-${pluginName}__frames`;

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
 * Unregister only those of `ids` that are currently registered.
 * `chrome.scripting.unregisterContentScripts` rejects atomically if any id in
 * the list is absent (unregistering none), so passing a mix of existing and
 * missing ids would leave stale registrations in place. Intersecting with the
 * live set first keeps the call well-formed.
 */
const unregisterIfPresent = async (ids: string[]): Promise<void> => {
  const registered = new Set(await getRegisteredPreScriptIds());
  const toRemove = ids.filter(id => registered.has(id));
  if (toRemove.length === 0) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: toRemove });
  } catch (err) {
    console.warn('[opentabs] unregisterContentScripts failed:', err);
  }
};

/**
 * Register or re-register a plugin's pre-script content scripts.
 *
 * Registers the primary script on the plugin's own `urlPatterns`, and — when the
 * plugin declares `preScriptFrameMatches` — a second registration of the same
 * pre-script file on those embedded-frame match patterns. Returns early with a
 * console.warn if `preScriptFile` is absent or fails the safe filename check —
 * preventing path traversal from a compromised MCP server.
 */
const upsertPreScript = async (meta: PluginMeta): Promise<void> => {
  if (!meta.preScriptFile) return;

  if (!SAFE_PRE_SCRIPT_FILENAME.test(meta.preScriptFile)) {
    console.warn(
      `[opentabs] refusing to register pre-script with unexpected filename: "${meta.preScriptFile}" (plugin: ${meta.name})`,
    );
    return;
  }

  const frameMatches = meta.preScriptFrameMatches?.filter(p => p.length > 0) ?? [];

  const registrations: chrome.scripting.RegisteredContentScript[] = [
    {
      id: registrationId(meta.name),
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
      // frames. Same-origin frames only — cross-origin frames are covered by
      // the separate `preScriptFrameMatches` registration below.
      allFrames: true,
    },
  ];

  // Second registration: the same pre-script on cross-origin embedded frames.
  // The plugin's `urlPatterns` govern tab-claiming/adapter injection, so a
  // cross-origin editor canvas (e.g. Office Web Apps on officeapps.live.com)
  // can never be reached by the primary registration. `preScriptFrameMatches`
  // lets the pre-script run in those frames — where it branches on the frame's
  // origin to install a frame-specific interceptor — without the plugin
  // claiming those frames' tabs as its own.
  if (frameMatches.length > 0) {
    registrations.push({
      id: frameRegistrationId(meta.name),
      matches: frameMatches,
      js: [meta.preScriptFile],
      runAt: 'document_start',
      world: 'MAIN',
      persistAcrossSessions: true,
      allFrames: true,
    });
  }

  // Unregister first so re-registration always succeeds, even if a stale
  // registration for one of these ids already exists. A plugin that drops its
  // `preScriptFrameMatches` between builds also has its now-orphaned frames
  // registration cleared here, because `frameRegistrationId` is always included.
  await unregisterIfPresent([registrationId(meta.name), frameRegistrationId(meta.name)]);

  try {
    await chrome.scripting.registerContentScripts(registrations);
  } catch (err) {
    console.warn(`[opentabs] registerContentScripts failed for plugin ${meta.name}:`, err);
  }
};

/**
 * Unregister the pre-script content script for a plugin.
 * Swallows errors — safe to call even if no registration exists.
 */
const removePreScript = async (pluginName: string): Promise<void> => {
  await unregisterIfPresent([registrationId(pluginName), frameRegistrationId(pluginName)]);
};

/**
 * Synchronize registered pre-script content scripts to match the given plugin set.
 * Unregisters stale opentabs-pre-* IDs not in the expected set, then upserts
 * each plugin's pre-script in parallel.
 */
const syncPreScripts = async (metas: PluginMeta[]): Promise<void> => {
  const expectedIds = new Set<string>();
  for (const m of metas) {
    if (!m.preScriptFile) continue;
    expectedIds.add(registrationId(m.name));
    if (m.preScriptFrameMatches?.some(p => p.length > 0)) {
      expectedIds.add(frameRegistrationId(m.name));
    }
  }

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
