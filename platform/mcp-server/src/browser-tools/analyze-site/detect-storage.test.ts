import { detectStorage } from './detect-storage.js';
import { describe, expect, test } from 'vitest';
import type { StorageDetectionInput } from './detect-storage.js';

const emptyInput: StorageDetectionInput = {
  cookieNames: [],
  localStorageKeys: [],
  sessionStorageKeys: [],
};

describe('detectStorage', () => {
  test('returns empty when no storage data collected', () => {
    const result = detectStorage(emptyInput);
    expect(result.cookies).toEqual([]);
    expect(result.localStorage).toEqual([]);
    expect(result.sessionStorage).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Cookie detection
  // -----------------------------------------------------------------------

  describe('cookie detection', () => {
    test('reports cookie names', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['_ga', 'theme', 'lang'],
      });
      expect(result.cookies).toHaveLength(3);
      expect(result.cookies[0]?.name).toBe('_ga');
      expect(result.cookies[1]?.name).toBe('theme');
      expect(result.cookies[2]?.name).toBe('lang');
    });

    test('flags session cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['session'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags session_id cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['session_id'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags token cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['auth_token'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags csrf cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['_csrf'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags jwt cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['jwt_refresh'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags sid cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['connect.sid'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags credential cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['user_credential'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags secret cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['app_secret'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags key cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['api_key'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('does not flag non-auth cookies', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['_ga', 'theme', 'lang', 'preferences'],
      });
      expect(result.cookies.every(c => !c.isAuth)).toBe(true);
    });

    test('flags login cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['login_state'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('flags user cookie as auth', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['user_id'],
      });
      expect(result.cookies[0]?.isAuth).toBe(true);
    });

    test('mixed auth and non-auth cookies', () => {
      const result = detectStorage({
        ...emptyInput,
        cookieNames: ['_ga', 'session', 'theme', 'auth_token', '_csrf'],
      });
      expect(result.cookies).toHaveLength(5);
      expect(result.cookies[0]?.isAuth).toBe(false); // _ga
      expect(result.cookies[1]?.isAuth).toBe(true); // session
      expect(result.cookies[2]?.isAuth).toBe(false); // theme
      expect(result.cookies[3]?.isAuth).toBe(true); // auth_token
      expect(result.cookies[4]?.isAuth).toBe(true); // _csrf
    });
  });

  // -----------------------------------------------------------------------
  // localStorage detection
  // -----------------------------------------------------------------------

  describe('localStorage detection', () => {
    test('reports localStorage keys', () => {
      const result = detectStorage({
        ...emptyInput,
        localStorageKeys: ['theme', 'sidebar-collapsed'],
      });
      expect(result.localStorage).toHaveLength(2);
      expect(result.localStorage[0]?.name).toBe('theme');
      expect(result.localStorage[1]?.name).toBe('sidebar-collapsed');
    });

    test('flags auth-related localStorage keys', () => {
      const result = detectStorage({
        ...emptyInput,
        localStorageKeys: ['access_token', 'user_data', 'session_id'],
      });
      expect(result.localStorage).toHaveLength(3);
      expect(result.localStorage[0]?.isAuth).toBe(true); // access_token
      expect(result.localStorage[1]?.isAuth).toBe(true); // user_data
      expect(result.localStorage[2]?.isAuth).toBe(true); // session_id
    });

    test('does not flag non-auth localStorage keys', () => {
      const result = detectStorage({
        ...emptyInput,
        localStorageKeys: ['theme', 'language', 'layout-state', 'recent-searches'],
      });
      expect(result.localStorage.every(k => !k.isAuth)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // sessionStorage detection
  // -----------------------------------------------------------------------

  describe('sessionStorage detection', () => {
    test('reports sessionStorage keys', () => {
      const result = detectStorage({
        ...emptyInput,
        sessionStorageKeys: ['tab-id', 'form-draft'],
      });
      expect(result.sessionStorage).toHaveLength(2);
      expect(result.sessionStorage[0]?.name).toBe('tab-id');
      expect(result.sessionStorage[1]?.name).toBe('form-draft');
    });

    test('flags auth-related sessionStorage keys', () => {
      const result = detectStorage({
        ...emptyInput,
        sessionStorageKeys: ['auth_state', 'jwt_token'],
      });
      expect(result.sessionStorage).toHaveLength(2);
      expect(result.sessionStorage[0]?.isAuth).toBe(true); // auth_state
      expect(result.sessionStorage[1]?.isAuth).toBe(true); // jwt_token
    });

    test('does not flag non-auth sessionStorage keys', () => {
      const result = detectStorage({
        ...emptyInput,
        sessionStorageKeys: ['scroll-position', 'active-tab', 'form-draft'],
      });
      expect(result.sessionStorage.every(k => !k.isAuth)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Real-world scenarios
  // -----------------------------------------------------------------------

  describe('real-world scenarios', () => {
    test('typical e-commerce site storage', () => {
      const result = detectStorage({
        cookieNames: ['_ga', '_gid', 'session_id', '_csrf_token', 'currency', 'locale'],
        localStorageKeys: ['cart', 'wishlist', 'preferences', 'auth_token'],
        sessionStorageKeys: ['checkout_step', 'form_data'],
      });
      expect(result.cookies).toHaveLength(6);
      expect(result.cookies.filter(c => c.isAuth).map(c => c.name)).toEqual(['session_id', '_csrf_token']);
      expect(result.localStorage).toHaveLength(4);
      expect(result.localStorage.filter(k => k.isAuth).map(k => k.name)).toEqual(['auth_token']);
      expect(result.sessionStorage).toHaveLength(2);
      expect(result.sessionStorage.every(k => !k.isAuth)).toBe(true);
    });

    test('SPA with JWT auth storage', () => {
      const result = detectStorage({
        cookieNames: ['_ga'],
        localStorageKeys: ['jwt_access_token', 'jwt_refresh_token', 'user_profile', 'app_settings'],
        sessionStorageKeys: ['csrf_nonce'],
      });
      expect(result.localStorage.filter(k => k.isAuth).map(k => k.name)).toEqual([
        'jwt_access_token',
        'jwt_refresh_token',
        'user_profile',
      ]);
      expect(result.sessionStorage[0]?.isAuth).toBe(true); // csrf_nonce
    });

    test('static site with minimal storage', () => {
      const result = detectStorage({
        cookieNames: ['_ga', 'theme'],
        localStorageKeys: ['dark-mode'],
        sessionStorageKeys: [],
      });
      expect(result.cookies.every(c => !c.isAuth)).toBe(true);
      expect(result.localStorage.every(k => !k.isAuth)).toBe(true);
      expect(result.sessionStorage).toEqual([]);
    });

    test('site with session cookie only', () => {
      const result = detectStorage({
        cookieNames: ['JSESSIONID'],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });
      expect(result.cookies).toHaveLength(1);
      expect(result.cookies[0]?.isAuth).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Case sensitivity
  // -----------------------------------------------------------------------

  describe('case sensitivity', () => {
    test('pattern matching is case-insensitive', () => {
      const result = detectStorage({
        cookieNames: ['SESSION', 'Token', 'AUTH_STATE'],
        localStorageKeys: ['UserProfile', 'JWT_TOKEN'],
        sessionStorageKeys: ['CSRF_TOKEN', 'LoginState'],
      });
      expect(result.cookies.every(c => c.isAuth)).toBe(true);
      expect(result.localStorage.every(k => k.isAuth)).toBe(true);
      expect(result.sessionStorage.every(k => k.isAuth)).toBe(true);
    });
  });
});
