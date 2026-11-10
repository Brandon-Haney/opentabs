import { describe, expect, test } from 'vitest';
import { gs1CheckDigit, normalizeGtin } from './gtin.js';

describe('gs1CheckDigit', () => {
  test('computes the check digit of GTINs Fusion holds', () => {
    expect(gs1CheckDigit('0008729524791')).toBe(4);
    expect(gs1CheckDigit('1008729524791')).toBe(1);
    expect(gs1CheckDigit('0008729514115')).toBe(1);
  });
});

describe('normalizeGtin', () => {
  test('pads a 12-digit UPC-A to the GTIN-14 Fusion stores', () => {
    expect(normalizeGtin('087295247914')).toEqual({ valid: true, gtin: '00087295247914', checkDigitValid: true });
  });

  test('pads a 13-digit EAN and keeps a 14-digit GTIN as it is', () => {
    expect(normalizeGtin('0087295247914')).toEqual({ valid: true, gtin: '00087295247914', checkDigitValid: true });
    expect(normalizeGtin(' 10087295247911 ')).toEqual({ valid: true, gtin: '10087295247911', checkDigitValid: true });
  });

  test('flags a wrong check digit without refusing the barcode', () => {
    expect(normalizeGtin('087295247915')).toEqual({ valid: true, gtin: '00087295247915', checkDigitValid: false });
  });

  test('refuses what is not a 12-, 13- or 14-digit number', () => {
    expect(normalizeGtin('0872952479')).toEqual({ valid: false, problem: expect.stringMatching(/not 10/) });
    expect(normalizeGtin('08729524791X')).toEqual({ valid: false, problem: 'A barcode is made of digits only.' });
    expect(normalizeGtin('')).toEqual({ valid: false, problem: 'A barcode is made of digits only.' });
  });
});
