// ---------------------------------------------------------------------------
// Storage utilities for plugin authors
// ---------------------------------------------------------------------------

/**
 * Reads a value from localStorage. Returns null if the key is not found or
 * if storage access throws (e.g., SecurityError in sandboxed iframes).
 */
export const getLocalStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * Writes a value to localStorage. Silently fails if storage access throws
 * (e.g., SecurityError in sandboxed iframes or when storage is full).
 */
export const setLocalStorage = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Silently fail on SecurityError or QuotaExceededError
  }
};

/**
 * Reads a value from sessionStorage. Returns null if the key is not found or
 * if storage access throws (e.g., SecurityError in sandboxed iframes).
 */
export const getSessionStorage = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * Writes a value to sessionStorage. Silently fails if storage access throws
 * (e.g., SecurityError in sandboxed iframes or when storage is full).
 */
export const setSessionStorage = (key: string, value: string): void => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Silently fail on SecurityError or QuotaExceededError
  }
};

/**
 * Removes a key from localStorage. Silently fails if storage access throws
 * (e.g., SecurityError in sandboxed iframes).
 */
export const removeLocalStorage = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Silently fail on SecurityError
  }
};

/**
 * Removes a key from sessionStorage. Silently fails if storage access throws
 * (e.g., SecurityError in sandboxed iframes).
 */
export const removeSessionStorage = (key: string): void => {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Silently fail on SecurityError
  }
};

/**
 * Reads a cookie by name from `document.cookie`. Handles URI-encoded values.
 * Returns null if the cookie is not found.
 */
export const getCookie = (name: string): string | null => {
  const prefix = `${name}=`;
  const entries = document.cookie.split('; ');
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      try {
        return decodeURIComponent(entry.slice(prefix.length));
      } catch {
        return entry.slice(prefix.length);
      }
    }
  }
  return null;
};
