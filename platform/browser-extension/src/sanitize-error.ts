/**
 * Sanitize error messages and structured error details before they leave the
 * extension for the MCP server (and from there the MCP client).
 *
 * Messages: strips absolute file paths, URLs, localhost references, and IP
 * addresses to prevent leaking internal system details; truncates to 500
 * characters.
 *
 * Details: a plugin-controlled object attached to a thrown ToolError. Every key
 * and every string leaf passes through the message sanitizer, prototype-
 * polluting keys are dropped, and the walk is bounded in key count, depth, and
 * serialized size so an unknown-shaped object is safe to forward.
 */

const MAX_LENGTH = 500;

/** Longest serialized `details` object forwarded; larger objects are dropped whole. */
const MAX_DETAILS_LENGTH = 4096;
/** Deepest nesting walked. The root object is depth 0; a container at depth MAX_DETAILS_DEPTH + 1 becomes '[TRUNCATED]'. */
const MAX_DETAILS_DEPTH = 2;
/** Most keys kept per object; the rest are dropped in insertion order. */
const MAX_DETAILS_KEYS = 64;
/** Keys that would rewrite the prototype chain of the sanitized object instead of adding a property. */
const FORBIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Whether a colon-delimited candidate is an IPv6 literal rather than a clock time.
 *
 * The two reach the redactor looking alike — `10:30:45` and `fe80::1` are both
 * colon-separated and both made only of hex digits — so testing for a hex digit
 * cannot tell them apart. What can: an IPv6 address that omits `::` has to spell
 * out all eight groups, and so carries seven colons. Nothing valid has exactly two
 * colons and no `::`, which is precisely the shape of a time. A hex letter settles
 * the remaining cases on its own. A candidate with no hex digit at all is neither —
 * a bare `::` between words is a scope operator.
 */
const isIpv6Literal = (candidate: string): boolean =>
  /[0-9a-fA-F]/.test(candidate) &&
  (candidate.includes('::') || (candidate.match(/:/g)?.length ?? 0) >= 3 || /[a-fA-F]/.test(candidate));

const sanitizeErrorMessage = (message: string): string => {
  let sanitized = message
    // Windows absolute paths: C:\path\to\file or C:/path/to/file
    .replace(/[a-z]:[/\\][^\s,;)}\]]+/gi, '[PATH]')
    // Unix absolute paths: /path/to/file (at least 2 segments to avoid false positives like "/")
    .replace(/\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+/gi, '[PATH]')
    // Full URLs with protocol
    .replace(/https?:\/\/[^\s,;)}\]]+/gi, '[URL]')
    // Bracketed IPv6 with optional port: [::1], [::1]:9515, [2001:db8::1]
    .replace(/\[[:0-9a-fA-F]+\](?::\d+)?/g, '[IP]')
    // Bare IPv6 (at least two colons): ::1, 2001:db8::1, ::ffff:127.0.0.1, fe80::1%eth0.
    // An IPv6 literal is not adjacent to a word character or another colon, and is told
    // apart from a clock time by {@link isIpv6Literal}, so `::`-delimited identifiers such as
    // `Http::Proxy::Deadbeef::OnRequest` or `std::abs` are left intact.
    .replace(/(?<![\w:])[0-9a-fA-F]*:[0-9a-fA-F]*:[0-9a-fA-F:.]*(?:%\w+)?(?![\w:])/g, match =>
      isIpv6Literal(match) ? '[IP]' : match,
    )
    // localhost with port
    .replace(/localhost:\d+/gi, '[LOCALHOST]')
    // IPv4 addresses
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[IP]');

  if (sanitized.length > MAX_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_LENGTH - 3)}...`;
  }

  return sanitized;
};

/** A value that survived sanitization: JSON-serializable, strings already sanitized. */
type SanitizedDetailValue = string | number | boolean | null | SanitizedDetailValue[] | SanitizedDetails;
type SanitizedDetails = { [key: string]: SanitizedDetailValue };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Sanitize a single value found at `depth`. Returns undefined for values that
 * cannot be forwarded (undefined, function, symbol, bigint); the caller decides
 * whether that means "omit the key" (objects) or "keep the slot as null" (arrays).
 */
const sanitizeDetailValue = (value: unknown, depth: number): SanitizedDetailValue | undefined => {
  if (typeof value === 'string') return sanitizeErrorMessage(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (depth > MAX_DETAILS_DEPTH) return '[TRUNCATED]';
    return value.map(entry => sanitizeDetailValue(entry, depth + 1) ?? null);
  }
  if (isPlainObject(value)) {
    if (depth > MAX_DETAILS_DEPTH) return '[TRUNCATED]';
    return sanitizeDetailObject(value, depth);
  }
  return undefined;
};

/**
 * Sanitize an object's keys and values; `depth` is the object's own depth (root = 0).
 *
 * Keys are sanitized like messages, so distinct source keys can collapse to the
 * same string (two URL-keyed entries both become '[URL]'). Each collision is kept
 * under a numbered suffix in insertion order — the second occurrence as
 * `<key>#2`, the third as `<key>#3` — so no entry is silently overwritten.
 */
const sanitizeDetailObject = (source: Record<string, unknown>, depth: number): SanitizedDetails => {
  const result: SanitizedDetails = {};
  const occurrences = new Map<string, number>();
  let kept = 0;
  for (const [key, rawValue] of Object.entries(source)) {
    if (kept >= MAX_DETAILS_KEYS) break;
    if (FORBIDDEN_DETAIL_KEYS.has(key)) continue;
    const value = sanitizeDetailValue(rawValue, depth + 1);
    if (value === undefined) continue;
    const sanitizedKey = sanitizeErrorMessage(key);
    const occurrence = (occurrences.get(sanitizedKey) ?? 0) + 1;
    occurrences.set(sanitizedKey, occurrence);
    result[occurrence === 1 ? sanitizedKey : `${sanitizedKey}#${occurrence}`] = value;
    kept++;
  }
  return result;
};

/**
 * Sanitize a plugin-supplied error `details` object for the wire.
 *
 * Keys that sanitize to the same string are kept apart with a `#<n>` suffix
 * (`[URL]`, `[URL]#2`, ...) rather than overwriting each other.
 *
 * Returns undefined when `value` is not a plain object or when the sanitized
 * result serializes to more than MAX_DETAILS_LENGTH characters (logged with a
 * console.warn so the drop is visible in the extension log).
 */
const sanitizeErrorDetails = (value: unknown): SanitizedDetails | undefined => {
  if (!isPlainObject(value)) return undefined;
  const sanitized = sanitizeDetailObject(value, 0);
  const serializedLength = JSON.stringify(sanitized).length;
  if (serializedLength > MAX_DETAILS_LENGTH) {
    console.warn(
      `[opentabs] dropped error details: serialized size ${serializedLength} exceeds ${MAX_DETAILS_LENGTH} chars`,
    );
    return undefined;
  }
  return sanitized;
};

export type { SanitizedDetails };
export { sanitizeErrorDetails, sanitizeErrorMessage };
