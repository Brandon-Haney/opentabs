/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Returns `err.message` for Error instances and `String(err)` for everything
 * else. This replaces the repetitive `err instanceof Error ? err.message : String(err)`
 * pattern used across the platform.
 */
export const toErrorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Flat, primitive-valued metadata a plugin attaches to a ToolError so the
 * platform can record it in the audit log — for example the upstream HTTP
 * status, the service's request id, or a proxy error label. Values must never
 * contain full URLs with item identifiers; record origins only.
 */
export type ToolErrorDetails = Record<string, string | number | boolean>;
