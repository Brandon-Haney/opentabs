import { isNewer } from './version-check.js';
import { describe, expect, test } from 'bun:test';

describe('isNewer', () => {
  describe('basic comparisons', () => {
    test('newer major version', () => {
      expect(isNewer('1.0.0', '2.0.0')).toBe(true);
    });

    test('newer minor version', () => {
      expect(isNewer('1.0.0', '1.1.0')).toBe(true);
    });

    test('newer patch version', () => {
      expect(isNewer('1.0.0', '1.0.1')).toBe(true);
    });

    test('same version', () => {
      expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    });

    test('older major version', () => {
      expect(isNewer('2.0.0', '1.0.0')).toBe(false);
    });

    test('older minor version', () => {
      expect(isNewer('1.1.0', '1.0.0')).toBe(false);
    });

    test('older patch version', () => {
      expect(isNewer('1.0.1', '1.0.0')).toBe(false);
    });
  });

  describe('v prefix handling', () => {
    test('strips v prefix from current', () => {
      expect(isNewer('v1.0.0', '2.0.0')).toBe(true);
    });

    test('strips v prefix from latest', () => {
      expect(isNewer('1.0.0', 'v2.0.0')).toBe(true);
    });

    test('strips v prefix from both', () => {
      expect(isNewer('v1.0.0', 'v1.0.0')).toBe(false);
    });
  });

  describe('prerelease handling', () => {
    test('prerelease suffix is stripped for comparison (1.0.0-beta.1 treated as 1.0.0)', () => {
      expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false);
    });

    test('prerelease current vs newer release', () => {
      expect(isNewer('1.0.0-beta.1', '1.0.1')).toBe(true);
    });

    test('prerelease latest vs same base release', () => {
      expect(isNewer('2.0.0', '2.0.0-rc.1')).toBe(false);
    });

    test('prerelease does not cause NaN', () => {
      expect(isNewer('0.9.0', '1.0.0-beta.1')).toBe(true);
    });
  });

  describe('NaN segment handling', () => {
    test('malformed current segment treated as 0 (latest is newer)', () => {
      expect(isNewer('1.0.abc', '2.0.0')).toBe(true);
    });

    test('malformed latest segment treated as 0 (current is newer)', () => {
      expect(isNewer('2.0.0', '1.0.abc')).toBe(false);
    });

    test('both versions have malformed segments', () => {
      expect(isNewer('1.abc.0', '2.xyz.0')).toBe(true);
    });

    test('malformed segment in same position compares as equal (both become 0)', () => {
      expect(isNewer('1.abc.0', '1.xyz.0')).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('missing patch version treated as 0', () => {
      expect(isNewer('1.0', '1.0.1')).toBe(true);
    });

    test('handles large version numbers', () => {
      expect(isNewer('1.999.999', '2.0.0')).toBe(true);
    });

    test('major version difference dominates', () => {
      expect(isNewer('1.99.99', '2.0.0')).toBe(true);
      expect(isNewer('2.0.0', '1.99.99')).toBe(false);
    });
  });
});
