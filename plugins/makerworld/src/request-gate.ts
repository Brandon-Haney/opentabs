/**
 * Outbound request policy for the MakerWorld API.
 *
 * MakerWorld rate-limits per account rather than per endpoint, so one tool that
 * walks a paginated ledger can spend the budget belonging to every tool that
 * runs after it. A 429 arriving halfway through a hundred-page walk also throws
 * away every page already read. Three mechanisms keep a session inside the
 * limit and make the walk survivable:
 *
 * - **Requests are serialized and spaced.** Nothing here needs concurrency, and
 *   a steady trickle is the shape a limiter is built to accept.
 * - **A rate limit widens the spacing for the rest of the session** and narrows
 *   it again only after a run of clean responses, so a tool that provokes a 429
 *   slows the tools that follow it instead of letting them walk into the same
 *   wall.
 * - **Reads are cached briefly.** The analytics tools all begin from the same
 *   creator-dashboard payload, and an agent running two of them in sequence
 *   should pay for it once.
 *
 * The spacing is measured from the start of each request, so a slow response
 * absorbs its own gap rather than adding to it.
 */

import { sleep, ToolError } from '@opentabs-dev/plugin-sdk';

/** Spacing between requests while nothing has been rate-limited. */
const BASE_INTERVAL_MS = 200;

/** Ceiling on the spacing once repeated rate limits have widened it. */
const MAX_INTERVAL_MS = 4_000;

/** Factor the spacing and the retry delay grow by after each rate limit. */
const BACKOFF_FACTOR = 4;

/** Clean responses needed before the spacing narrows one step. */
const RECOVERY_STREAK = 12;

/** Attempts per request, including the first. */
const MAX_ATTEMPTS = 4;

/** First retry delay; each subsequent attempt multiplies it by BACKOFF_FACTOR. */
const BASE_RETRY_DELAY_MS = 1_000;

/**
 * Longest this will block before giving up.
 *
 * A tool call that stalls for minutes is worse than one that reports the limit
 * and lets the caller decide, so a `Retry-After` longer than this is surfaced
 * rather than waited out — the error carries the delay MakerWorld asked for.
 */
const MAX_RETRY_DELAY_MS = 30_000;

/** How long a cached read stays fresh. */
const CACHE_TTL_MS = 60_000;

/** Cached reads retained before the oldest is evicted. */
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

/** Serializes requests — each waits for the previous one to settle. */
let tail: Promise<unknown> = Promise.resolve();

/** Earliest timestamp at which the next request may be issued. */
let nextSlotAt = 0;

let intervalMs = BASE_INTERVAL_MS;
let cleanResponses = 0;

const noop = (): void => undefined;

const readCache = (key: string): CacheEntry | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry;
};

const writeCache = (key: string, value: unknown): void => {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
};

/** Drops every cached read, since a write may have changed what any of them return. */
export const invalidateReadCache = (): void => cache.clear();

const isRateLimit = (error: unknown): boolean => error instanceof ToolError && error.category === 'rate_limit';

const isTransient = (error: unknown): boolean => error instanceof ToolError && error.retryable;

const widenInterval = (): void => {
  intervalMs = Math.min(intervalMs * BACKOFF_FACTOR, MAX_INTERVAL_MS);
  cleanResponses = 0;
};

const narrowInterval = (): void => {
  if (intervalMs === BASE_INTERVAL_MS) return;
  cleanResponses += 1;
  if (cleanResponses < RECOVERY_STREAK) return;
  intervalMs = Math.max(BASE_INTERVAL_MS, Math.round(intervalMs / BACKOFF_FACTOR));
  cleanResponses = 0;
};

/** Waits for this request's turn, then reserves the slot for the one after it. */
const takeSlot = async (): Promise<void> => {
  const waitMs = nextSlotAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  nextSlotAt = Date.now() + intervalMs;
};

/** How long to wait before the next attempt, respecting anything the server asked for. */
const retryDelayMs = (error: unknown, attempt: number): number => {
  const requested = error instanceof ToolError ? error.retryAfterMs : undefined;
  const backoff = Math.min(BASE_RETRY_DELAY_MS * BACKOFF_FACTOR ** (attempt - 1), MAX_RETRY_DELAY_MS);
  return Math.max(requested ?? 0, backoff);
};

/** Whether a write's effects are unknown after failure and so must not be repeated. */
type Repeatability = 'safe-to-repeat' | 'must-not-repeat';

const runPaced = async <T>(run: () => Promise<T>, repeatability: Repeatability, cacheKey?: string): Promise<T> => {
  if (cacheKey !== undefined) {
    const cached = readCache(cacheKey);
    if (cached) return cached.value as T;
  }

  for (let attempt = 1; ; attempt++) {
    await takeSlot();
    try {
      const value = await run();
      narrowInterval();
      if (cacheKey !== undefined) writeCache(cacheKey, value);
      if (repeatability === 'must-not-repeat') invalidateReadCache();
      return value;
    } catch (error) {
      const rateLimited = isRateLimit(error);
      if (rateLimited) widenInterval();

      // A rate-limited request was refused rather than executed, so repeating it
      // is safe whatever the method. A transient failure leaves a write's effect
      // unknown, so only reads are repeated on one.
      const mayRetry = rateLimited || (repeatability === 'safe-to-repeat' && isTransient(error));
      const delay = retryDelayMs(error, attempt);
      if (!mayRetry || attempt >= MAX_ATTEMPTS || delay > MAX_RETRY_DELAY_MS) throw error;

      await sleep(delay);
    }
  }
};

/** Queues a request behind every other, so the pacing applies across all tools. */
const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
  const result = tail.then(task, task);
  // The chain has to survive a failed request; the caller still sees the outcome.
  tail = result.then(noop, noop);
  return result;
};

/**
 * Run a read whose response may be reused. `cacheKey` should identify the
 * response exactly — the full URL, query string included.
 */
export const scheduleRead = <T>(cacheKey: string, run: () => Promise<T>): Promise<T> =>
  enqueue(() => runPaced(run, 'safe-to-repeat', cacheKey));

/**
 * Run a read whose response must not be reused — one whose value expires, or
 * whose retrieval has a side effect. Fetching an editor route forks a draft
 * server-side and returns signed URLs with a short life, so those reads are
 * repeatable but never cacheable.
 */
export const scheduleUncachedRead = <T>(run: () => Promise<T>): Promise<T> =>
  enqueue(() => runPaced(run, 'safe-to-repeat'));

/** Run a request that changes state. Retried only when MakerWorld refused it outright. */
export const scheduleWrite = <T>(run: () => Promise<T>): Promise<T> => enqueue(() => runPaced(run, 'must-not-repeat'));
