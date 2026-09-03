/**
 * CSP violation relay — the pure half.
 *
 * The ISOLATED-world relay (iife-injection.ts `cspViolationRelayScript`) is a
 * serialized closure and cannot import from this module, so it inlines the same
 * origin-reduction rules. This module owns the constants both sides share (they
 * reach the closure through executeScript `args`) and the background-side
 * normalization and formatting of the untrusted report.
 *
 * Privacy rule for everything relayed: URIs are reduced to origins. The one
 * exception is a `chrome-extension:` sourceFile, which is kept in full because
 * it names the adapter or pre-script file that tripped the policy — the signal
 * that attributes a violation to this extension rather than another one.
 */

import type { CspViolationReport } from './extension-messages.js';

/**
 * Directives the relay forwards. `connect-src` covers an adapter's fetch, XHR,
 * WebSocket, and beacon calls; `require-trusted-types-for` and `trusted-types`
 * are included so a TrustedScript/TrustedHTML violation is attributed to its
 * sourceFile; `script-src`, `script-src-elem`, and `worker-src` cover code an
 * adapter or pre-script injects at runtime. Every other directive is page-native
 * noise and is dropped in the page before it reaches the background.
 */
const CSP_RELAY_DIRECTIVES: readonly string[] = [
  'connect-src',
  'require-trusted-types-for',
  'trusted-types',
  'script-src',
  'script-src-elem',
  'worker-src',
];

/**
 * Most reports one document relays to the background, counted after
 * deduplication by (effectiveDirective, blocked origin, sourceFile, disposition).
 */
const MAX_CSP_VIOLATIONS_PER_DOCUMENT = 20;

/** Scheme of a sourceFile that is kept in full rather than reduced to its origin. */
const EXTENSION_SCHEME = 'chrome-extension:';

/** Longest non-URL keyword (e.g. `inline`, `eval`, `trusted-types-sink`) kept as-is. */
const MAX_KEYWORD_LENGTH = 64;
const MAX_ORIGIN_LENGTH = 256;
const MAX_SOURCE_FILE_LENGTH = 512;

/**
 * Reduce a URI to its origin. CSP reports carry keywords in URI positions
 * (`inline`, `eval`, `data`, `trusted-types-sink`, or an empty string); those
 * are not URLs and pass through truncated.
 */
const reduceToOrigin = (uri: string): string => {
  try {
    return new URL(uri).origin;
  } catch {
    return uri.slice(0, MAX_KEYWORD_LENGTH);
  }
};

/** Keep a `chrome-extension:` sourceFile in full; reduce everything else to its origin. */
const reduceSourceFile = (sourceFile: string): string =>
  sourceFile.startsWith(EXTENSION_SCHEME) ? sourceFile : reduceToOrigin(sourceFile);

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Validate and bound a `csp:violation` report received from a content script.
 * Returns undefined for anything that is not a well-formed report: the sender
 * is this extension's own relay, but the background still treats every field
 * as untrusted data — re-reducing URIs, truncating strings, and rejecting
 * directives outside the relay allow-list.
 */
const normalizeCspViolationReport = (raw: unknown): CspViolationReport | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const report = raw as Record<string, unknown>;
  const { effectiveDirective, blockedURI, sourceFile, documentOrigin, disposition } = report;
  if (
    typeof effectiveDirective !== 'string' ||
    typeof blockedURI !== 'string' ||
    typeof sourceFile !== 'string' ||
    typeof documentOrigin !== 'string'
  ) {
    return undefined;
  }
  if (disposition !== 'enforce' && disposition !== 'report') return undefined;
  if (!CSP_RELAY_DIRECTIVES.includes(effectiveDirective)) return undefined;

  return {
    effectiveDirective,
    blockedURI: reduceToOrigin(blockedURI).slice(0, MAX_ORIGIN_LENGTH),
    sourceFile: reduceSourceFile(sourceFile).slice(0, MAX_SOURCE_FILE_LENGTH),
    lineNumber: isNonNegativeSafeInteger(report.lineNumber) ? report.lineNumber : 0,
    columnNumber: isNonNegativeSafeInteger(report.columnNumber) ? report.columnNumber : 0,
    disposition,
    documentOrigin: reduceToOrigin(documentOrigin).slice(0, MAX_ORIGIN_LENGTH),
  };
};

/**
 * One-line background log entry for a violation. The `from <sourceFile>:<line>`
 * segment is present only when the report names a source file.
 */
const formatCspViolationLogLine = (report: CspViolationReport, tabId: number | undefined): string => {
  const tab = tabId === undefined ? 'unknown' : String(tabId);
  const source = report.sourceFile === '' ? '' : ` from ${report.sourceFile}:${report.lineNumber}`;
  return (
    `[opentabs] CSP violation in tab ${tab} (${report.documentOrigin}): ` +
    `${report.effectiveDirective} blocked ${report.blockedURI}${source} [${report.disposition}]`
  );
};

export {
  CSP_RELAY_DIRECTIVES,
  formatCspViolationLogLine,
  MAX_CSP_VIOLATIONS_PER_DOCUMENT,
  normalizeCspViolationReport,
  reduceSourceFile,
  reduceToOrigin,
};
