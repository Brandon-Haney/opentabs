// ---------------------------------------------------------------------------
// Office reload marker — parsing
//
// Dependency-free on purpose: the plugin's pre-script (bundled as its own
// document_start IIFE) imports this module, and pre-scripts may only import
// '@opentabs-dev/plugin-sdk/pre-script' — pulling the main SDK barrel into
// that bundle is what the subpath export exists to prevent. The SDK-backed
// reporting half lives in reload-marker.ts.
// ---------------------------------------------------------------------------

/**
 * The `wdrldr` / `wdrldc` / `wdrldsc` query parameters an Office web app
 * appends when it reloads the document: reason, reload count and subcode.
 * Values are opaque strings (Microsoft does not document the enum).
 * `capturedAt` is the epoch-ms time the marker was observed. Declared as a
 * type alias rather than an interface so it is assignable to the pre-script
 * value type, which requires an implicit index signature.
 */
export type ReloadMarker = {
  reason: string;
  count: number | null;
  subcode: string | null;
  capturedAt: number;
};

/**
 * Parses the reload marker out of a URL query string, with or without the
 * leading `?`. Null when `wdrldr` is absent or empty; `count` is null unless
 * `wdrldc` is a non-negative integer; `subcode` is null when `wdrldsc` is
 * absent or empty.
 */
export const parseReloadMarker = (search: string, now: number): ReloadMarker | null => {
  const params = new URLSearchParams(search);
  const reason = params.get('wdrldr');
  if (reason === null || reason === '') return null;
  const countRaw = params.get('wdrldc');
  const count = countRaw !== null && /^\d+$/.test(countRaw) ? Number(countRaw) : null;
  const subcodeRaw = params.get('wdrldsc');
  const subcode = subcodeRaw === null || subcodeRaw === '' ? null : subcodeRaw;
  return { reason, count, subcode, capturedAt: now };
};
