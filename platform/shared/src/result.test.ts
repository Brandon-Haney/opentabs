import { err, isErr, isOk, mapResult, ok, unwrap, unwrapOr } from './result.js';
import { describe, expect, test } from 'bun:test';

describe('ok', () => {
  test('creates an Ok result with the given value', () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  test('creates an Ok result with a string value', () => {
    const result = ok('hello');
    expect(result).toEqual({ ok: true, value: 'hello' });
  });

  test('creates an Ok result with null value', () => {
    const result = ok(null);
    expect(result).toEqual({ ok: true, value: null });
  });

  test('creates an Ok result with undefined value', () => {
    const result = ok(undefined);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test('creates an Ok result with an object value', () => {
    const obj = { name: 'test', count: 5 };
    const result = ok(obj);
    expect(result).toEqual({ ok: true, value: obj });
  });
});

describe('err', () => {
  test('creates an Err result with the given error', () => {
    const result = err('something went wrong');
    expect(result).toEqual({ ok: false, error: 'something went wrong' });
  });

  test('creates an Err result with an Error instance', () => {
    const error = new Error('failure');
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
  });

  test('creates an Err result with a structured error object', () => {
    const error = { code: 'NOT_FOUND', message: 'missing' };
    const result = err(error);
    expect(result).toEqual({ ok: false, error });
  });
});

describe('isOk', () => {
  test('returns true for Ok results', () => {
    expect(isOk(ok(42))).toBe(true);
  });

  test('returns false for Err results', () => {
    expect(isOk(err('error'))).toBe(false);
  });

  test('returns true for Ok with falsy value (0)', () => {
    expect(isOk(ok(0))).toBe(true);
  });

  test('returns true for Ok with falsy value (empty string)', () => {
    expect(isOk(ok(''))).toBe(true);
  });

  test('returns true for Ok with falsy value (false)', () => {
    expect(isOk(ok(false))).toBe(true);
  });
});

describe('isErr', () => {
  test('returns true for Err results', () => {
    expect(isErr(err('error'))).toBe(true);
  });

  test('returns false for Ok results', () => {
    expect(isErr(ok(42))).toBe(false);
  });

  test('returns true for Err with falsy error (empty string)', () => {
    expect(isErr(err(''))).toBe(true);
  });

  test('returns true for Err with null error', () => {
    expect(isErr(err(null))).toBe(true);
  });
});

describe('unwrap', () => {
  test('returns the value for Ok results', () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  test('returns the value for Ok with string', () => {
    expect(unwrap(ok('hello'))).toBe('hello');
  });

  test('returns the value for Ok with object', () => {
    const obj = { key: 'value' };
    expect(unwrap(ok(obj))).toBe(obj);
  });

  test('throws for Err results with descriptive message', () => {
    expect(() => unwrap(err('something failed'))).toThrow('unwrap called on Err: something failed');
  });

  test('throws for Err with Error instance, including stringified error', () => {
    const error = new Error('inner error');
    expect(() => unwrap(err(error))).toThrow('unwrap called on Err: Error: inner error');
  });

  test('throws for Err with null error', () => {
    expect(() => unwrap(err(null))).toThrow('unwrap called on Err: null');
  });
});

describe('unwrapOr', () => {
  test('returns the value for Ok results', () => {
    expect(unwrapOr(ok(42), 0)).toBe(42);
  });

  test('returns the default for Err results', () => {
    expect(unwrapOr(err('error'), 0)).toBe(0);
  });

  test('returns Ok value even when it matches the default', () => {
    expect(unwrapOr(ok(0), 99)).toBe(0);
  });

  test('returns default string for Err', () => {
    expect(unwrapOr(err('error'), 'fallback')).toBe('fallback');
  });

  test('returns Ok value of null (does not use default)', () => {
    expect(unwrapOr(ok(null), 'default')).toBeNull();
  });
});

describe('mapResult', () => {
  test('transforms Ok value with the provided function', () => {
    const result = mapResult(ok(5), n => n * 2);
    expect(result).toEqual({ ok: true, value: 10 });
  });

  test('passes Err through unchanged', () => {
    const original = err('something failed');
    const result = mapResult(original, (n: number) => n * 2);

    expect(result).toEqual({ ok: false, error: 'something failed' });
    expect(result).toBe(original);
  });

  test('transforms Ok value to a different type', () => {
    const result = mapResult(ok(42), n => String(n));
    expect(result).toEqual({ ok: true, value: '42' });
  });

  test('transforms Ok value with complex function', () => {
    const result = mapResult(ok({ name: 'test' }), obj => obj.name.toUpperCase());
    expect(result).toEqual({ ok: true, value: 'TEST' });
  });

  test('does not call transform function for Err', () => {
    let called = false;
    mapResult(err('error'), () => {
      called = true;
      return 'transformed';
    });
    expect(called).toBe(false);
  });
});
