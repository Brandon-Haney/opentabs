import { checkRateLimit, getTrackedMethodCount, resetRateLimiter } from './rate-limiter.js';
import { beforeEach, describe, expect, test } from 'vitest';

let now: number;

beforeEach(() => {
  resetRateLimiter();
  now = 1_000_000;
});

describe('checkRateLimit', () => {
  describe('exempt methods', () => {
    test('sync.full is always allowed regardless of call count', () => {
      for (let i = 0; i < 100; i++) {
        expect(checkRateLimit('sync.full', now)).toBe(true);
      }
    });

    test('extension.reload is always allowed', () => {
      for (let i = 0; i < 100; i++) {
        expect(checkRateLimit('extension.reload', now)).toBe(true);
      }
    });

    test('plugin.update is always allowed', () => {
      for (let i = 0; i < 50; i++) {
        expect(checkRateLimit('plugin.update', now)).toBe(true);
      }
    });

    test('plugin.uninstall is always allowed', () => {
      for (let i = 0; i < 50; i++) {
        expect(checkRateLimit('plugin.uninstall', now)).toBe(true);
      }
    });
  });

  describe('method-specific limits', () => {
    test('browser.screenshotTab allows 2 per second', () => {
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(false);
    });

    test('browser.enableNetworkCapture allows 2 per second', () => {
      expect(checkRateLimit('browser.enableNetworkCapture', now)).toBe(true);
      expect(checkRateLimit('browser.enableNetworkCapture', now)).toBe(true);
      expect(checkRateLimit('browser.enableNetworkCapture', now)).toBe(false);
    });

    test('browser.executeScript allows 15 per second', () => {
      for (let i = 0; i < 15; i++) {
        expect(checkRateLimit('browser.executeScript', now)).toBe(true);
      }
      expect(checkRateLimit('browser.executeScript', now)).toBe(false);
    });

    test('tool.dispatch allows 30 per second', () => {
      for (let i = 0; i < 30; i++) {
        expect(checkRateLimit('tool.dispatch', now)).toBe(true);
      }
      expect(checkRateLimit('tool.dispatch', now)).toBe(false);
    });
  });

  describe('default limit', () => {
    test('unconfigured method allows 20 per second', () => {
      for (let i = 0; i < 20; i++) {
        expect(checkRateLimit('browser.listTabs', now)).toBe(true);
      }
      expect(checkRateLimit('browser.listTabs', now)).toBe(false);
    });
  });

  describe('window expiration', () => {
    test('requests allowed again after window passes', () => {
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(false);

      // Advance past the 1-second window
      now += 1_001;

      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
    });
  });

  describe('boundary conditions', () => {
    test('exactly at limit is allowed', () => {
      for (let i = 0; i < 20; i++) {
        expect(checkRateLimit('browser.listTabs', now)).toBe(true);
      }
    });

    test('one over limit is rejected', () => {
      for (let i = 0; i < 20; i++) {
        checkRateLimit('browser.listTabs', now);
      }
      expect(checkRateLimit('browser.listTabs', now)).toBe(false);
    });
  });

  describe('stale key pruning', () => {
    test('deletes key when all timestamps expire on next check', () => {
      checkRateLimit('browser.screenshotTab', now);
      expect(getTrackedMethodCount()).toBe(1);

      // Advance past window — all timestamps expire
      now += 1_001;

      // Call again: prunes expired timestamps → empty → deletes key, then re-adds with new timestamp
      checkRateLimit('browser.screenshotTab', now);
      expect(getTrackedMethodCount()).toBe(1);
    });

    test('key is absent between reset and first call', () => {
      expect(getTrackedMethodCount()).toBe(0);
      checkRateLimit('browser.screenshotTab', now);
      expect(getTrackedMethodCount()).toBe(1);
    });

    test('map does not accumulate stale keys across multiple methods', () => {
      checkRateLimit('browser.screenshotTab', now);
      checkRateLimit('browser.executeScript', now);
      expect(getTrackedMethodCount()).toBe(2);

      now += 1_001;

      // Both methods' timestamps expire; calling each prunes its own key then re-adds
      checkRateLimit('browser.screenshotTab', now);
      checkRateLimit('browser.executeScript', now);
      expect(getTrackedMethodCount()).toBe(2);
    });
  });

  describe('method independence', () => {
    test('different methods have independent limits', () => {
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(true);
      expect(checkRateLimit('browser.screenshotTab', now)).toBe(false);

      // executeScript should still be available (separate counter)
      expect(checkRateLimit('browser.executeScript', now)).toBe(true);
    });
  });
});
