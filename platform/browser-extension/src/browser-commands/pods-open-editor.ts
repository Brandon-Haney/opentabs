/**
 * Pods `open_in_editor` engine — open a deck in the web editor and wait for its
 * co-authoring session to be live.
 *
 * Every pods edit needs an open editor frame with a captured donor request. When
 * the target deck is not open anywhere, this closes the gap: open its URL in a new
 * tab, then wait until the editor OOPIF exists and has issued a `/pods` request
 * (the donor), at which point the live-edit tools work against that tab.
 *
 * The tab is opened ACTIVE deliberately: Chrome throttles a background tab's
 * cross-origin OOPIF hard enough that the editor may never boot, and MAIN-world
 * pre-script injection into a throttled OOPIF is unreliable. Foregrounding the tab
 * is what reliably un-throttles it.
 *
 * The URL is allow-listed to the Office web editor hosts. The directive comes from
 * a reviewed adapter, but it drives a navigation in the user's browser — a
 * compromised adapter must not be able to turn this into "open any URL".
 */

import { FrameBridgeValidationError } from './frame-bridge-rpc.js';

/** How long to wait for the editor session before reporting it not ready. */
const DEFAULT_EDITOR_WAIT_MS = 60_000;
/** How often to probe while waiting. */
const PROBE_INTERVAL_MS = 1_000;

/** The `__podsOpenEditor` directive, validated in `tool-dispatch`. */
export interface PodsOpenEditorParams {
  /** The deck URL to open. Must pass {@link assertAllowedEditorUrl}. */
  url: string;
  /** Substring selecting the editor OOPIF once the page loads. */
  frameUrlIncludes: string;
  /** Frame global whose presence proves the co-authoring session is live. */
  donorGlobal: string;
  /** How long to wait for the session (default {@link DEFAULT_EDITOR_WAIT_MS}). */
  waitMs?: number;
}

/** What `open_in_editor` returns. */
export interface PodsOpenEditorResult {
  /** The opened tab — pass it as `tabId` to live-edit tools to target this deck. */
  tabId: number;
  /** Whether the editor frame appeared and captured a donor within the wait. */
  editorReady: boolean;
  /** How long the session took to come up, in milliseconds. */
  waitedMs: number;
  url: string;
}

/**
 * Reject any URL that is not an Office deck location. HTTPS only, and the host
 * must be a SharePoint document host or the standalone PowerPoint app.
 */
export const assertAllowedEditorUrl = (url: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FrameBridgeValidationError(`open_in_editor URL is not a valid URL: ${url.slice(0, 120)}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    parsed.protocol === 'https:' && (host.endsWith('.sharepoint.com') || host === 'powerpoint.cloud.microsoft');
  if (!allowed) {
    throw new FrameBridgeValidationError(
      `open_in_editor only opens PowerPoint web editor URLs (*.sharepoint.com or powerpoint.cloud.microsoft); got "${parsed.origin}".`,
    );
  }
  return parsed;
};

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** True when the tab has an editor frame holding the donor global. */
const probeEditorSession = async (tabId: number, frameUrlIncludes: string, donorGlobal: string): Promise<boolean> => {
  try {
    const frameProbe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: (donorName: string) => ({
        href: location.href,
        hasDonor: Boolean((globalThis as Record<string, unknown>)[donorName]),
      }),
      args: [donorGlobal],
    });
    return frameProbe.some(frame => {
      const info = (frame.result as { href?: string; hasDonor?: boolean } | undefined) ?? {};
      return Boolean(info.href?.includes(frameUrlIncludes)) && info.hasDonor === true;
    });
  } catch {
    // The tab is still navigating (no frames scriptable yet) — not ready, keep waiting.
    return false;
  }
};

/** How long to wait for the editor session to return after a recovery reload. */
const RELOAD_WAIT_MS = 60_000;

/**
 * Reload the deck tab and wait for a fresh co-authoring session.
 *
 * The recovery for a compacted revision stream: once the server checkpoints and
 * discards history, no read in the old session can reconstruct full state — but
 * a fresh session's load establishes a new base that zero-base reads resolve
 * against. Reloading mid-co-authoring is safe: every accepted revision is
 * already persisted server-side, so nothing is lost but the view position.
 *
 * The first probe is delayed one interval so the navigation has torn the old
 * frame down — probing too early can see the OLD session's donor and report
 * ready against a frame that is about to die.
 */
export const reloadEditorSession = async (
  tabId: number,
  frameUrlIncludes: string,
  donorGlobal: string,
  waitMs: number = RELOAD_WAIT_MS,
): Promise<void> => {
  await chrome.tabs.reload(tabId);
  const deadline = Date.now() + waitMs;
  for (;;) {
    await delay(PROBE_INTERVAL_MS);
    if (await probeEditorSession(tabId, frameUrlIncludes, donorGlobal)) return;
    if (Date.now() >= deadline) {
      throw new FrameBridgeValidationError(
        `The editor session did not come back within ${Math.round(waitMs / 1000)}s of reloading tab ${tabId}. ` +
          'Open and activate the deck, then retry.',
      );
    }
  }
};

/** Open the deck URL in a new active tab and wait for its co-authoring session. */
export const runPodsOpenEditor = async (params: PodsOpenEditorParams): Promise<PodsOpenEditorResult> => {
  const parsed = assertAllowedEditorUrl(params.url);
  const waitMs = params.waitMs ?? DEFAULT_EDITOR_WAIT_MS;

  const tab = await chrome.tabs.create({ url: parsed.href, active: true });
  if (tab.id === undefined) {
    throw new FrameBridgeValidationError('Chrome did not return a tab id for the opened deck.');
  }

  const started = Date.now();
  const deadline = started + waitMs;
  for (;;) {
    if (await probeEditorSession(tab.id, params.frameUrlIncludes, params.donorGlobal)) {
      return { tabId: tab.id, editorReady: true, waitedMs: Date.now() - started, url: parsed.href };
    }
    if (Date.now() >= deadline) {
      return { tabId: tab.id, editorReady: false, waitedMs: Date.now() - started, url: parsed.href };
    }
    await delay(PROBE_INTERVAL_MS);
  }
};
