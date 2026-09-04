// ---------------------------------------------------------------------------
// Token introspection — non-secret descriptors of a bearer token for diagnostics
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decodes the claims of a JWT without verifying it. Null when the token is not
 * three dot-separated segments, the payload is not base64url, or it is not a
 * JSON object.
 */
export const decodeJwtClaims = (token: string): Record<string, unknown> | null => {
  const segments = token.split('.');
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined || payload === '') return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * The token's audience for display: the host when the `aud` claim is a URL
 * (`https://graph.microsoft.com` → `graph.microsoft.com`), the raw claim when it
 * is an application id, null when absent or not a string.
 */
export const audienceOf = (claims: Record<string, unknown> | null): string | null => {
  const aud = claims?.aud;
  if (typeof aud !== 'string' || aud === '') return null;
  try {
    return new URL(aud).host;
  } catch {
    return aud;
  }
};

/** The delegated scopes granted by the token (`scp` claim, space-separated); empty when absent. */
export const scopesOf = (claims: Record<string, unknown> | null): string[] => {
  const scp = claims?.scp;
  return typeof scp === 'string' ? scp.split(/\s+/).filter(scope => scope !== '') : [];
};
