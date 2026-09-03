// ---------------------------------------------------------------------------
// Shared error types for the SDK
// ---------------------------------------------------------------------------

import type { ToolErrorDetails } from '@opentabs-dev/shared';

/** Standard error categories for structured error metadata. */
export type ErrorCategory = 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'internal' | 'timeout';

/** Optional structured metadata for ToolError. */
export interface ToolErrorOptions {
  retryable?: boolean;
  retryAfterMs?: number;
  category?: ErrorCategory;
  /**
   * Flat, primitive-valued metadata for the audit log — upstream HTTP status,
   * request id, proxy error label.
   *
   * It does NOT reach the agent. The MCP error response is built from a fixed
   * allow-list of code, category, retryable and retryAfterMs, so anything put
   * here is for a human reading the audit trail afterwards. Values must never
   * contain full URLs with item identifiers; record hosts or origins only.
   */
  details?: ToolErrorDetails;
}

/**
 * Typed error for tool handlers — the platform catches these
 * and returns structured MCP error responses.
 *
 * The static factories set code/category/retryable for the common cases and
 * take no `details`; attach metadata to a factory result by chaining
 * {@link ToolError.withDetails}, which returns a new error with every other
 * field preserved.
 */
export class ToolError extends Error {
  /** Whether this error is retryable (defaults to false). */
  readonly retryable: boolean;
  /** Suggested delay before retrying, in milliseconds. */
  readonly retryAfterMs: number | undefined;
  /** Error category for structured error classification. */
  readonly category: ErrorCategory | undefined;
  /** Flat, primitive-valued metadata for the audit log (see ToolErrorOptions.details). */
  readonly details: ToolErrorDetails | undefined;

  constructor(
    message: string,
    /** Machine-readable error code (e.g., 'CHANNEL_NOT_FOUND') */
    public readonly code: string,
    opts?: ToolErrorOptions,
  ) {
    super(message);
    this.name = 'ToolError';
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs;
    this.category = opts?.category;
    this.details = opts?.details;
  }

  /**
   * Returns a new ToolError carrying this error's details merged with
   * `details` (later keys win). Message, code, category, retryable,
   * retryAfterMs and the original stack are preserved; this instance is left
   * untouched.
   */
  withDetails(details: ToolErrorDetails): ToolError {
    const copy = new ToolError(this.message, this.code, {
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      category: this.category,
      details: { ...this.details, ...details },
    });
    if (this.stack !== undefined) copy.stack = this.stack;
    return copy;
  }

  /** Authentication or authorization error (not retryable). Accepts an optional domain-specific code. */
  static auth(message: string, code?: string): ToolError {
    return new ToolError(message, code ?? 'AUTH_ERROR', { category: 'auth', retryable: false });
  }

  /** Resource not found (not retryable). Accepts an optional domain-specific code. */
  static notFound(message: string, code?: string): ToolError {
    return new ToolError(message, code ?? 'NOT_FOUND', { category: 'not_found', retryable: false });
  }

  /** Rate limited (retryable). Accepts an optional retry delay in milliseconds and an optional domain-specific code. */
  static rateLimited(message: string, retryAfterMs?: number, code?: string): ToolError {
    return new ToolError(message, code ?? 'RATE_LIMITED', { category: 'rate_limit', retryable: true, retryAfterMs });
  }

  /** Input validation error (not retryable). Accepts an optional domain-specific code. */
  static validation(message: string, code?: string): ToolError {
    return new ToolError(message, code ?? 'VALIDATION_ERROR', { category: 'validation', retryable: false });
  }

  /** Operation timed out (retryable). Accepts an optional domain-specific code. */
  static timeout(message: string, code?: string): ToolError {
    return new ToolError(message, code ?? 'TIMEOUT', { category: 'timeout', retryable: true });
  }

  /** Internal/unexpected error (not retryable). Accepts an optional domain-specific code. */
  static internal(message: string, code?: string): ToolError {
    return new ToolError(message, code ?? 'INTERNAL_ERROR', { category: 'internal', retryable: false });
  }
}
