/**
 * Shared URL validation for browser tools.
 * Only allows http: and https: URLs to prevent injection attacks via MCP tool parameters.
 */

import { z } from 'zod';

/** URL schemes allowed by browser tools — all others are rejected */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * A Zod schema that validates:
 * - Must be a valid URL (z.url())
 * - Must use http: or https: scheme (allowlist, not blocklist)
 */
const safeUrl = z.url().refine(
  val => {
    const parsed = new URL(val);
    return ALLOWED_URL_SCHEMES.has(parsed.protocol);
  },
  { message: 'URL scheme must be http: or https:' },
);

export { safeUrl };
