// ---------------------------------------------------------------------------
// Token fingerprints — short, deterministic identifiers for bearer secrets
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/** Number of trailing hex digits of the hash a token fingerprint keeps. */
export const TOKEN_FINGERPRINT_LENGTH = 4;

/**
 * FNV-1a 32-bit hash of `input`, taken over its UTF-16 code units, as eight
 * lowercase hex digits. For ASCII input — every access token this plugin
 * handles — the code units equal the UTF-8 bytes, so the output matches the
 * reference FNV-1a vectors (`''` → `811c9dc5`, `'a'` → `e40c292c`).
 */
export const fnv1a32Hex = (input: string): string => {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * The last TOKEN_FINGERPRINT_LENGTH hex digits of the FNV-1a hash of a bearer
 * secret. It lets log lines and the diagnose output say "the token ending 9dc5
 * was rejected on Outlook REST but accepted on Graph" without ever carrying the
 * secret. It is a correlation id, not a security primitive: the input is a
 * 1000+ character JWT and sixteen bits of hash give no recovery path, while
 * two live tokens colliding only makes a diagnosis harder to read.
 */
export const tokenFingerprint = (secret: string): string => fnv1a32Hex(secret).slice(-TOKEN_FINGERPRINT_LENGTH);
