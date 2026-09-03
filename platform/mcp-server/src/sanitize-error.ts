/**
 * Sanitize error messages before returning them to external clients.
 * Strips absolute file paths, URLs, localhost references, and IP addresses
 * to prevent leaking internal system details. Truncates to 500 characters.
 */

const MAX_LENGTH = 500;

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
    // Full URLs with protocol — must run before path regexes: the Windows path
    // regex matches "[a-z]:/" which would match the "s:/" in "https://" or the
    // "p:/" in "http://", and the Unix path regex would match the path portion,
    // both leaving a partial URL like "htt[PATH]" instead of "[URL]"
    .replace(/https?:\/\/[^\s,;)}\]]+/gi, '[URL]')
    // Windows absolute paths: C:\path\to\file or C:/path/to/file
    .replace(/[a-z]:[/\\][^\s,;)}\]]+/gi, '[PATH]')
    // Unix absolute paths: /path/to/file — first segment must start with a letter to avoid
    // false positives on numeric segments like "1/2" (fractions/ratios). Requires at least 2
    // segments so single-segment paths like "/api" or "/json" are not stripped (they are more
    // likely URL path fragments than filesystem paths).
    .replace(/\/[a-z][a-z0-9._-]*(?:\/[a-z0-9._-]+)+/gi, '[PATH]')
    // localhost with optional port
    .replace(/localhost(?::\d+)?/gi, '[LOCALHOST]')
    // Bracket-wrapped IPv6 addresses: [::1], [fe80::1], [2001:db8::1], [fe80::1%eth0]
    // Requires at least one colon inside brackets to avoid matching array indices like [0]
    .replace(/\[[0-9a-fA-F]*:[0-9a-fA-F:]*(?:%[^\]]+)?\]/g, '[IP]')
    // Bare IPv6 (at least two colons): ::1, fe80::1, 2001:db8::1, ::ffff:192.168.1.1, fe80::1%eth0.
    // Must run before the IPv4 regex to consume mixed IPv6/IPv4 addresses like ::ffff:192.168.1.1 whole.
    // An IPv6 literal is not adjacent to a word character or another colon, and is told
    // apart from a clock time by {@link isIpv6Literal}, so `::`-delimited identifiers such as
    // `Microsoft::M365::RoutingPlane::NanoProxy::HttpProxy::OnHttpRequest` or `std::abs` are left intact.
    .replace(/(?<![\w:])[0-9a-fA-F]*:[0-9a-fA-F]*:[0-9a-fA-F:.]*(?:%\w+)?(?![\w:])/g, match =>
      isIpv6Literal(match) ? '[IP]' : match,
    )
    // IPv4 addresses
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '[IP]');

  if (sanitized.length > MAX_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_LENGTH - 3)}...`;
  }

  return sanitized;
};

export { sanitizeErrorMessage };
