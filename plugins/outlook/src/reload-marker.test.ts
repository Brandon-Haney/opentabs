/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://contoso.sharepoint.com/:x:/r/sites/x/doc.xlsx?wdrldr=SessionExpired&wdrldc=1"}
 */
import { log } from '@opentabs-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseReloadMarker, type ReloadMarker, reportReloadMarker } from './reload-marker.js';

vi.mock('@opentabs-dev/plugin-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@opentabs-dev/plugin-sdk')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORIGIN = 'https://contoso.sharepoint.com';
const STORAGE_KEY = '__opentabs_reload_marker_reported';

const marker = (overrides: Partial<ReloadMarker> = {}): ReloadMarker => ({
  reason: 'SessionExpired',
  count: 2,
  subcode: 'abc',
  capturedAt: 1_700_000_000_000,
  ...overrides,
});

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseReloadMarker', () => {
  test('reads reason, count and subcode with the supplied capture time', () => {
    expect(parseReloadMarker('?wdrldr=SessionExpired&wdrldc=2&wdrldsc=abc', 123)).toEqual({
      reason: 'SessionExpired',
      count: 2,
      subcode: 'abc',
      capturedAt: 123,
    });
  });

  test('returns null when wdrldr is absent or empty, even if the other parameters are present', () => {
    expect(parseReloadMarker('?wdrldc=2&wdrldsc=abc', 1)).toBeNull();
    expect(parseReloadMarker('?wdrldr=&wdrldc=2', 1)).toBeNull();
    expect(parseReloadMarker('', 1)).toBeNull();
  });

  test('leaves count null when wdrldc is missing or not a non-negative integer', () => {
    expect(parseReloadMarker('?wdrldr=Foo', 1)?.count).toBeNull();
    expect(parseReloadMarker('?wdrldr=Foo&wdrldc=x', 1)?.count).toBeNull();
    expect(parseReloadMarker('?wdrldr=Foo&wdrldc=-1', 1)?.count).toBeNull();
    expect(parseReloadMarker('?wdrldr=Foo&wdrldc=1.5', 1)?.count).toBeNull();
    expect(parseReloadMarker('?wdrldr=Foo&wdrldc=0', 1)?.count).toBe(0);
  });

  test('leaves subcode null when wdrldsc is missing or empty', () => {
    expect(parseReloadMarker('?wdrldr=Foo', 1)?.subcode).toBeNull();
    expect(parseReloadMarker('?wdrldr=Foo&wdrldsc=', 1)?.subcode).toBeNull();
  });

  test('ignores unrelated parameters and accepts a query with or without the leading "?"', () => {
    expect(parseReloadMarker('sourcedoc=%7Babc%7D&wdrldr=Foo&action=edit', 9)).toEqual({
      reason: 'Foo',
      count: null,
      subcode: null,
      capturedAt: 9,
    });
    expect(parseReloadMarker('?sourcedoc=%7Babc%7D&wdrldr=Foo', 9)?.reason).toBe('Foo');
  });

  test('parses the marker from the current document URL', () => {
    expect(location.origin).toBe(ORIGIN);
    expect(parseReloadMarker(location.search, 5)).toEqual({
      reason: 'SessionExpired',
      count: 1,
      subcode: null,
      capturedAt: 5,
    });
  });
});

describe('reportReloadMarker', () => {
  test('logs one warn with the marker fields and the origin only', () => {
    reportReloadMarker(marker(), ORIGIN);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Office web app reloaded the document', {
      reason: 'SessionExpired',
      count: 2,
      subcode: 'abc',
      origin: ORIGIN,
    });
    const serialized = JSON.stringify(vi.mocked(log.warn).mock.calls[0]?.[1]);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('wdrldr');
    expect(serialized).not.toContain('/sites/x');
    expect(serialized).not.toContain('doc.xlsx');
  });

  test('remembers the reported marker in sessionStorage keyed by the document time origin', () => {
    reportReloadMarker(marker(), ORIGIN);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(`SessionExpired|2|abc|${Math.round(performance.timeOrigin)}`);
  });

  test('encodes null count and subcode as empty key segments', () => {
    reportReloadMarker(marker({ count: null, subcode: null }), ORIGIN);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(`SessionExpired|||${Math.round(performance.timeOrigin)}`);
  });

  test('does not log the same marker twice for one document, even with a fresh capturedAt', () => {
    reportReloadMarker(marker({ capturedAt: 1 }), ORIGIN);
    reportReloadMarker(marker({ capturedAt: 2 }), ORIGIN);
    reportReloadMarker(marker({ capturedAt: 3 }), ORIGIN);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('logs again when the marker changes', () => {
    reportReloadMarker(marker({ count: 1 }), ORIGIN);
    reportReloadMarker(marker({ count: 2 }), ORIGIN);
    reportReloadMarker(marker({ count: 2, subcode: 'def' }), ORIGIN);
    reportReloadMarker(marker({ count: 2, subcode: 'def', reason: 'Other' }), ORIGIN);
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  test('logs again when a previous document load reported the same marker', () => {
    sessionStorage.setItem(STORAGE_KEY, `SessionExpired|2|abc|${Math.round(performance.timeOrigin) - 60_000}`);
    reportReloadMarker(marker(), ORIGIN);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('still logs when sessionStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    reportReloadMarker(marker(), ORIGIN);
    reportReloadMarker(marker(), ORIGIN);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});
