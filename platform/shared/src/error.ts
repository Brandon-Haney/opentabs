/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Returns `err.message` for Error instances and `String(err)` for everything
 * else. This replaces the repetitive `err instanceof Error ? err.message : String(err)`
 * pattern used across the platform.
 */
export const toErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
