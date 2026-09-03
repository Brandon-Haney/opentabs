// ---------------------------------------------------------------------------
// fetchWithRetry — transient-failure retry wrapper with the fetch contract
// ---------------------------------------------------------------------------

import { ToolError } from './errors.js';
import { parseRetryAfterMs, TRANSIENT_HTTP_STATUSES } from './fetch.js';
import { log } from './log.js';
import { sleep } from './timing.js';

/** Methods that are safe to replay without a caller opt-in (RFC 9110 §9.2.2, minus PUT and DELETE). */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Statuses whose Retry-After header is honored as the retry delay. */
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/** Describes one retry that fetchWithRetry is about to perform. */
export interface FetchRetryEvent {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Why the attempt is being retried: `'network'` or `'http <status>'`; identical to the warn log's `reason`. */
  reason: string;
  /** Backoff wait about to happen, in milliseconds. */
  delayMs: number;
}

export interface FetchWithRetryOptions {
  /** Total number of attempts including the first request (default: 3). */
  maxAttempts?: number;
  /** Backoff delay before the first retry, in milliseconds; doubles per attempt (default: 400). */
  baseDelayMs?: number;
  /** Upper bound for a single backoff delay, in milliseconds (default: 5000). */
  maxDelayMs?: number;
  /**
   * Wall-clock budget measured from the first attempt, in milliseconds
   * (default: 20000). A retry whose delay would end past the deadline is not
   * attempted: the last Response is returned, or the network ToolError thrown.
   */
  deadlineMs?: number;
  /**
   * Longest Retry-After the wrapper waits for, in milliseconds (default: 10000).
   * A 429/503 carrying a longer Retry-After is returned immediately so the
   * caller can surface `retryAfterMs` to the agent instead of blocking.
   */
  maxRetryAfterMs?: number;
  /**
   * Retry POST/PUT/PATCH/DELETE on transient statuses and network errors
   * (default: false). Enable only where replaying the request is provably safe.
   */
  retryNonIdempotent?: boolean;
  /**
   * Caller predicate that vouches the request never executed at the origin —
   * for example a proxy refusal identified by a response header. When it
   * returns true for a non-ok response, the request is retried even for
   * non-idempotent methods. It is not consulted on the final attempt or for
   * responses already retryable by status, and it must not consume the
   * response body.
   */
  isTransient?: (response: Response) => boolean;
  /**
   * Invoked synchronously right before each backoff sleep, once per retry.
   * Never invoked for the final attempt or for a response that is returned
   * without a retry. An exception thrown by the callback propagates to the
   * caller and ends the operation.
   */
  onRetry?: (event: FetchRetryEvent) => void;
  /**
   * Cancels the whole operation — the in-flight request and any pending
   * backoff sleep — with one normalized ToolError (code `aborted`). An
   * `init.signal` also interrupts a pending sleep, surfacing its own abort
   * reason instead (a TimeoutError for `AbortSignal.timeout`).
   */
  signal?: AbortSignal;
  /** Randomize each backoff delay to [d/2, d] (equal jitter) (default: true). */
  jitter?: boolean;
  /** Service name added to retry log lines (e.g. 'graph-mail'); never a URL — log lines must stay host-only. */
  label?: string;
}

/** Derives the request host for log lines and error messages; never the full URL. */
const hostOf = (url: string): string => {
  try {
    const base = typeof location === 'object' && location !== null ? location.href : undefined;
    return new URL(url, base).host;
  } catch {
    return '<invalid-url>';
  }
};

const abortedError = (host: string): ToolError =>
  new ToolError(`fetchWithRetry: request aborted for ${host}`, 'aborted');

const networkError = (host: string, attempts: number, cause: TypeError): ToolError =>
  new ToolError(
    `fetchWithRetry: network error reaching ${host} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${cause.message}`,
    'network_error',
    { category: 'internal', retryable: true },
  );

/** Reads a Retry-After delay from a 429/503 response; undefined for other statuses or an unparseable header. */
const retryAfterMsOf = (response: Response): number | undefined => {
  if (!RETRY_AFTER_STATUSES.has(response.status)) return undefined;
  const header = response.headers.get('Retry-After');
  return header === null ? undefined : parseRetryAfterMs(header);
};

/** A ReadableStream body is consumed by the first request and cannot be sent again. */
const hasStreamBody = (init: RequestInit | undefined): boolean =>
  typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream;

/**
 * Fetches `url` and retries transient failures, resolving with the final
 * Response for every outcome that is not retried — including 4xx and an
 * exhausted 5xx — so the caller keeps classifying statuses itself. Throws a
 * ToolError only for a network failure that exhausted its retries
 * (`network_error`) or an `options.signal` abort (`aborted`); a TimeoutError
 * raised by an `init.signal` created with `AbortSignal.timeout` — whether it
 * fires during a request or during a backoff sleep — is rethrown untouched.
 *
 * A network TypeError or a status in TRANSIENT_HTTP_STATUSES is retried for
 * GET/HEAD/OPTIONS by default and for other methods only with
 * `retryNonIdempotent`; a non-ok response the `isTransient` predicate vouches
 * for is retried regardless of method. A request whose `init.body` is a
 * ReadableStream is never retried — the stream is consumed by the first
 * request — so neither `retryNonIdempotent` nor `isTransient` applies to it.
 * Retry-After on 429/503 is honored up to `maxRetryAfterMs`; otherwise the
 * delay is exponential backoff with equal jitter, always bounded by
 * `deadlineMs`. The body of every retried response is cancelled; the returned
 * Response is untouched. `onRetry` observes each retry before its sleep.
 */
export const fetchWithRetry = async (
  url: string,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> => {
  const maxAttempts = options?.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`fetchWithRetry: maxAttempts must be an integer >= 1, got ${maxAttempts}`);
  }
  const baseDelayMs = options?.baseDelayMs ?? 400;
  const maxDelayMs = options?.maxDelayMs ?? 5_000;
  const deadlineMs = options?.deadlineMs ?? 20_000;
  const maxRetryAfterMs = options?.maxRetryAfterMs ?? 10_000;
  const retryNonIdempotent = options?.retryNonIdempotent ?? false;
  const jitter = options?.jitter ?? true;
  const isTransient = options?.isTransient;
  const onRetry = options?.onRetry;
  const signal = options?.signal;
  const label = options?.label;

  const method = (init?.method ?? 'GET').toUpperCase();
  const streamBody = hasStreamBody(init);
  const replayable = !streamBody && (IDEMPOTENT_METHODS.has(method) || retryNonIdempotent);
  const host = hostOf(url);
  const requestSignal =
    signal === undefined ? init?.signal : init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
  const requestInit: RequestInit = { ...init, signal: requestSignal ?? null };

  const startedAt = Date.now();
  const withinDeadline = (delayMs: number): boolean => Date.now() - startedAt + delayMs <= deadlineMs;
  const backoffDelay = (attempt: number): number => {
    const capped = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    return Math.round(jitter ? capped / 2 + Math.random() * (capped / 2) : capped);
  };
  const announceRetry = (attempt: number, reason: string, delayMs: number): void => {
    log.warn('transient upstream failure, retrying', {
      host,
      method,
      attempt,
      reason,
      delayMs,
      ...(label !== undefined && { label }),
    });
    onRetry?.({ attempt, reason, delayMs });
  };
  const pause = async (delayMs: number): Promise<void> => {
    try {
      await sleep(delayMs, { signal: requestSignal ?? undefined });
    } catch (error) {
      if (signal?.aborted) throw abortedError(host);
      throw error;
    }
  };

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortedError(host);

    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (error) {
      if (signal?.aborted) throw abortedError(host);
      if (!(error instanceof TypeError)) throw error;
      if (!replayable || attempt >= maxAttempts) throw networkError(host, attempt, error);
      const delayMs = backoffDelay(attempt);
      if (!withinDeadline(delayMs)) throw networkError(host, attempt, error);
      announceRetry(attempt, 'network', delayMs);
      await pause(delayMs);
      continue;
    }

    if (attempt >= maxAttempts) return response;
    const byStatus = TRANSIENT_HTTP_STATUSES.has(response.status) && replayable;
    const vouched = !streamBody && !byStatus && !response.ok && isTransient?.(response) === true;
    if (!(byStatus || vouched)) return response;

    const retryAfterMs = retryAfterMsOf(response);
    if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) return response;
    const delayMs = retryAfterMs ?? backoffDelay(attempt);
    if (!withinDeadline(delayMs)) return response;

    void response.body?.cancel().catch(() => undefined);
    announceRetry(attempt, `http ${response.status}`, delayMs);
    await pause(delayMs);
  }
};
