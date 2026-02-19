/**
 * Sliding window rate limiter for browser commands.
 *
 * Tracks request timestamps per method and rejects requests that exceed the
 * configured limit within the window. Timestamps older than the window are
 * lazily pruned on each check to prevent unbounded memory growth.
 */

interface RateLimitConfig {
  /** Maximum number of requests allowed within the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/** Per-method rate limit configuration */
const METHOD_LIMITS: ReadonlyMap<string, RateLimitConfig> = new Map([
  // Expensive operations — tight limits
  ['browser.screenshotTab', { maxRequests: 2, windowMs: 1_000 }],
  ['browser.enableNetworkCapture', { maxRequests: 2, windowMs: 1_000 }],
  ['browser.executeScript', { maxRequests: 10, windowMs: 1_000 }],

  // Tool dispatch — allow bursts of sequential/concurrent tool calls from agents
  ['tool.dispatch', { maxRequests: 30, windowMs: 1_000 }],
]);

/** Default limit for methods without a specific config */
const DEFAULT_LIMIT: RateLimitConfig = { maxRequests: 20, windowMs: 1_000 };

/**
 * Methods exempt from rate limiting. These are control/lifecycle methods that
 * must always be processed (e.g., sync.full arrives once on connect, and
 * extension.reload must never be delayed).
 */
const EXEMPT_METHODS = new Set(['extension.reload', 'sync.full', 'plugin.update', 'plugin.uninstall']);

/** Sliding window timestamps per method */
const methodTimestamps = new Map<string, number[]>();

/**
 * Check whether a request for the given method is allowed under the rate limit.
 * Returns true if the request is allowed, false if it should be rejected.
 */
export const checkRateLimit = (method: string): boolean => {
  if (EXEMPT_METHODS.has(method)) return true;

  const config = METHOD_LIMITS.get(method) ?? DEFAULT_LIMIT;
  const now = Date.now();
  const cutoff = now - config.windowMs;

  // Get existing timestamps and prune expired entries
  const timestamps = (methodTimestamps.get(method) ?? []).filter(t => t > cutoff);

  if (timestamps.length >= config.maxRequests) {
    methodTimestamps.set(method, timestamps);
    return false;
  }

  timestamps.push(now);
  methodTimestamps.set(method, timestamps);
  return true;
};
