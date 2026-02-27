import { detectGlobals } from './detect-globals.js';
import { describe, expect, test } from 'vitest';
import type { GlobalsDetectionInput } from './detect-globals.js';

const emptyInput: GlobalsDetectionInput = {
  globals: [],
};

describe('detectGlobals', () => {
  test('returns empty when no globals detected', () => {
    const result = detectGlobals(emptyInput);
    expect(result.globals).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Basic global detection
  // -----------------------------------------------------------------------

  describe('basic global detection', () => {
    test('reports a simple string global', () => {
      const result = detectGlobals({
        globals: [{ path: 'APP_VERSION', type: 'string', topLevelKeys: undefined }],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.path).toBe('APP_VERSION');
      expect(result.globals[0]?.type).toBe('string');
      expect(result.globals[0]?.hasAuthData).toBe(false);
      expect(result.globals[0]?.topLevelKeys).toBeUndefined();
    });

    test('reports an object global with top-level keys', () => {
      const result = detectGlobals({
        globals: [{ path: '__APP_CONFIG__', type: 'object', topLevelKeys: ['apiUrl', 'version', 'environment'] }],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.type).toBe('object');
      expect(result.globals[0]?.topLevelKeys).toEqual(['apiUrl', 'version', 'environment']);
    });

    test('reports a function global', () => {
      const result = detectGlobals({
        globals: [{ path: 'initApp', type: 'function', topLevelKeys: undefined }],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.type).toBe('function');
      expect(result.globals[0]?.hasAuthData).toBe(false);
    });

    test('reports multiple globals', () => {
      const result = detectGlobals({
        globals: [
          { path: '__APP_CONFIG__', type: 'object', topLevelKeys: ['apiUrl'] },
          { path: 'APP_VERSION', type: 'string', topLevelKeys: undefined },
          { path: 'dataLayer', type: 'object', topLevelKeys: ['push', 'length'] },
        ],
      });
      expect(result.globals).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Auth-related key detection
  // -----------------------------------------------------------------------

  describe('auth-related key detection', () => {
    test('flags global with "user" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__INITIAL_STATE__', type: 'object', topLevelKeys: ['user', 'settings', 'notifications'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "session" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__NEXT_DATA__', type: 'object', topLevelKeys: ['props', 'session', 'buildId'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "token" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__APP_STATE__', type: 'object', topLevelKeys: ['token', 'config'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "auth" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__STORE__', type: 'object', topLevelKeys: ['auth', 'items', 'ui'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "account" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__DATA__', type: 'object', topLevelKeys: ['account', 'settings'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "profile" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__DATA__', type: 'object', topLevelKeys: ['profile', 'config'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "login" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__STATE__', type: 'object', topLevelKeys: ['login', 'dashboard'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "credential" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__CONFIG__', type: 'object', topLevelKeys: ['credential', 'endpoint'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "jwt" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__DATA__', type: 'object', topLevelKeys: ['jwt', 'config'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags global with "csrf" key as auth data', () => {
      const result = detectGlobals({
        globals: [{ path: '__DATA__', type: 'object', topLevelKeys: ['csrfToken', 'config'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('flags auth data with case-insensitive matching', () => {
      const result = detectGlobals({
        globals: [{ path: '__DATA__', type: 'object', topLevelKeys: ['UserProfile', 'Settings'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('does not flag non-auth keys', () => {
      const result = detectGlobals({
        globals: [{ path: '__CONFIG__', type: 'object', topLevelKeys: ['apiUrl', 'version', 'environment', 'theme'] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(false);
    });

    test('does not flag globals without top-level keys', () => {
      const result = detectGlobals({
        globals: [{ path: 'APP_VERSION', type: 'string', topLevelKeys: undefined }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(false);
    });

    test('does not flag globals with empty top-level keys', () => {
      const result = detectGlobals({
        globals: [{ path: '__EMPTY__', type: 'object', topLevelKeys: [] }],
      });
      expect(result.globals[0]?.hasAuthData).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Real-world-like scenarios
  // -----------------------------------------------------------------------

  describe('real-world scenarios', () => {
    test('Next.js __NEXT_DATA__ with session data', () => {
      const result = detectGlobals({
        globals: [
          {
            path: '__NEXT_DATA__',
            type: 'object',
            topLevelKeys: ['props', 'page', 'query', 'buildId', 'assetPrefix', 'session'],
          },
        ],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('Nuxt __NUXT__ with auth state', () => {
      const result = detectGlobals({
        globals: [
          {
            path: '__NUXT__',
            type: 'object',
            topLevelKeys: ['data', 'state', 'auth', 'config'],
          },
        ],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('Redux-like __INITIAL_STATE__', () => {
      const result = detectGlobals({
        globals: [
          {
            path: '__INITIAL_STATE__',
            type: 'object',
            topLevelKeys: ['user', 'items', 'notifications', 'ui'],
          },
        ],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.hasAuthData).toBe(true);
    });

    test('app config without auth data', () => {
      const result = detectGlobals({
        globals: [
          {
            path: '__APP_CONFIG__',
            type: 'object',
            topLevelKeys: ['apiBaseUrl', 'version', 'environment', 'features'],
          },
        ],
      });
      expect(result.globals).toHaveLength(1);
      expect(result.globals[0]?.hasAuthData).toBe(false);
    });

    test('mixed globals with and without auth data', () => {
      const result = detectGlobals({
        globals: [
          { path: '__NEXT_DATA__', type: 'object', topLevelKeys: ['props', 'session'] },
          { path: 'dataLayer', type: 'object', topLevelKeys: ['push', 'length'] },
          { path: '__APP_CONFIG__', type: 'object', topLevelKeys: ['apiUrl', 'version'] },
        ],
      });
      expect(result.globals).toHaveLength(3);
      expect(result.globals[0]?.hasAuthData).toBe(true);
      expect(result.globals[1]?.hasAuthData).toBe(false);
      expect(result.globals[2]?.hasAuthData).toBe(false);
    });
  });
});
