import { parsePort, resolvePort } from './parse-port.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// ---------------------------------------------------------------------------
// parsePort
// ---------------------------------------------------------------------------

describe('parsePort', () => {
  test('parses valid integer port', () => {
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('9515')).toBe(9515);
  });

  test('rejects port 0', () => {
    expect(() => parsePort('0')).toThrow('Must be an integer between 1 and 65535.');
  });

  test('rejects port above 65535', () => {
    expect(() => parsePort('65536')).toThrow('Must be an integer between 1 and 65535.');
    expect(() => parsePort('99999')).toThrow('Must be an integer between 1 and 65535.');
  });

  test('rejects negative port', () => {
    expect(() => parsePort('-1')).toThrow('Must be an integer between 1 and 65535.');
  });

  test('rejects NaN', () => {
    expect(() => parsePort('abc')).toThrow('Must be an integer between 1 and 65535.');
    expect(() => parsePort('')).toThrow('Must be an integer between 1 and 65535.');
  });

  test('rejects float values', () => {
    expect(() => parsePort('3000.5')).toThrow('Must be an integer between 1 and 65535.');
    expect(() => parsePort('1.1')).toThrow('Must be an integer between 1 and 65535.');
  });

  test('rejects Infinity', () => {
    expect(() => parsePort('Infinity')).toThrow('Must be an integer between 1 and 65535.');
  });
});

// ---------------------------------------------------------------------------
// resolvePort
// ---------------------------------------------------------------------------

describe('resolvePort', () => {
  const originalEnv = process.env.OPENTABS_PORT;

  beforeAll(() => {
    delete process.env.OPENTABS_PORT;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.OPENTABS_PORT = originalEnv;
    } else {
      delete process.env.OPENTABS_PORT;
    }
  });

  test('returns options.port when provided', () => {
    expect(resolvePort({ port: 4000 })).toBe(4000);
  });

  test('returns OPENTABS_PORT env var when options.port is undefined', () => {
    process.env.OPENTABS_PORT = '5000';
    expect(resolvePort({})).toBe(5000);
    delete process.env.OPENTABS_PORT;
  });

  test('returns default 9515 when neither option nor env is set', () => {
    delete process.env.OPENTABS_PORT;
    expect(resolvePort({})).toBe(9515);
  });

  test('options.port takes priority over env var', () => {
    process.env.OPENTABS_PORT = '5000';
    expect(resolvePort({ port: 3000 })).toBe(3000);
    delete process.env.OPENTABS_PORT;
  });

  test('ignores invalid OPENTABS_PORT env var and falls back to default', () => {
    process.env.OPENTABS_PORT = 'not-a-number';
    expect(resolvePort({})).toBe(9515);
    delete process.env.OPENTABS_PORT;
  });

  test('ignores OPENTABS_PORT of 0', () => {
    process.env.OPENTABS_PORT = '0';
    expect(resolvePort({})).toBe(9515);
    delete process.env.OPENTABS_PORT;
  });

  test('ignores OPENTABS_PORT above 65535', () => {
    process.env.OPENTABS_PORT = '70000';
    expect(resolvePort({})).toBe(9515);
    delete process.env.OPENTABS_PORT;
  });

  test('ignores float OPENTABS_PORT', () => {
    process.env.OPENTABS_PORT = '3000.5';
    expect(resolvePort({})).toBe(9515);
    delete process.env.OPENTABS_PORT;
  });
});
