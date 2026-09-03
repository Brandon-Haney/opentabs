/**
 * Decode a JWT's payload segment (unpadded base64url) into its claims; null when
 * the token is not a readable JWT. Only the claims are read — there is no
 * signature check, because callers use them for expiry and audience bookkeeping,
 * never to decide whether to trust the token.
 */
export const jwtClaims = (token: string): Record<string, unknown> | null => {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const parsed: unknown = JSON.parse(atob(padded));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * When a bearer token expires, in unix seconds: the JWT's own `exp` claim when
 * the token is a readable JWT, otherwise `nowSec + fallbackTtlSec` for an opaque
 * token. An already-expired `exp` is returned as is, so the caller's liveness
 * check rejects the token instead of trusting it for the fallback window.
 */
export const bearerTokenExpiry = (token: string, nowSec: number, fallbackTtlSec: number): number => {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? Math.floor(exp) : nowSec + fallbackTtlSec;
};
