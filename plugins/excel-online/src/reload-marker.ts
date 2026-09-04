// ---------------------------------------------------------------------------
// Office reload marker — reporting (adapter side)
// ---------------------------------------------------------------------------

import { getSessionStorage, log, setSessionStorage } from '@opentabs-dev/plugin-sdk';
import type { ReloadMarker } from './reload-marker-parse.js';

export { parseReloadMarker, type ReloadMarker } from './reload-marker-parse.js';

/** sessionStorage key holding the dedupe key of the marker already reported for this tab. */
const REPORTED_MARKER_STORAGE_KEY = '__opentabs_reload_marker_reported';

/**
 * Identifies one document load: the marker fields plus `performance.timeOrigin`,
 * which is constant for one document and differs across reloads. `capturedAt`
 * is excluded because the URL-fallback path parses a fresh marker on every
 * adapter injection, and one document must report once.
 */
const dedupeKey = (marker: ReloadMarker): string =>
  `${marker.reason}|${marker.count ?? ''}|${marker.subcode ?? ''}|${Math.round(performance.timeOrigin)}`;

/**
 * Emits `log.warn('Office web app reloaded the document', …)` exactly once per
 * document for `marker`, so the server-side plugin log records a timestamped
 * reload event. sessionStorage is per tab and survives the reload, so the next
 * reload (a new count or timeOrigin) is reported again while a plugin
 * re-injection into the same document is not. When storage is unavailable the
 * SDK helpers swallow the error and the marker is reported on every injection.
 * Logs the origin only — never the URL.
 */
export const reportReloadMarker = (marker: ReloadMarker, origin: string): void => {
  const key = dedupeKey(marker);
  if (getSessionStorage(REPORTED_MARKER_STORAGE_KEY) === key) return;
  setSessionStorage(REPORTED_MARKER_STORAGE_KEY, key);
  log.warn('Office web app reloaded the document', {
    reason: marker.reason,
    count: marker.count,
    subcode: marker.subcode,
    origin,
  });
};
