/**
 * GS1 barcodes as scanners read them and as Fusion stores them. Fusion holds every GTIN as
 * 14 digits; a scanner reads a UPC-A as 12 digits and an EAN-13 as 13. Left-padding with
 * zeros turns either into the GTIN-14 Fusion holds, and keeps the check digit valid, since
 * the check digit weighs digits by their position from the right.
 */

/** Lengths of the barcodes a scanner reads that pad to a GTIN-14: UPC-A, EAN-13 and GTIN-14. */
const GTIN_LENGTHS = [12, 13, 14] as const;

const GTIN_14_LENGTH = 14;

/**
 * The check digit of a GS1 number, from all its digits but the last: digits are weighed 3
 * and 1 alternately from the right, and the check digit brings their sum to a multiple of 10.
 */
export const gs1CheckDigit = (digits: string): number => {
  let sum = 0;
  for (const [offset, digit] of [...digits].reverse().entries()) sum += Number(digit) * (offset % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
};

/** A barcode read as a GTIN-14. */
export type NormalizedGtin =
  | { valid: true; gtin: string; checkDigitValid: boolean }
  /** The barcode is not a 12-, 13- or 14-digit number; `problem` says how. */
  | { valid: false; problem: string };

/** Reads a barcode as scanned (UPC-A, EAN-13 or GTIN-14) as the GTIN-14 Fusion stores. */
export const normalizeGtin = (barcode: string): NormalizedGtin => {
  const digits = barcode.trim();
  if (!/^\d+$/.test(digits)) return { valid: false, problem: 'A barcode is made of digits only.' };
  if (!(GTIN_LENGTHS as readonly number[]).includes(digits.length)) {
    return {
      valid: false,
      problem: `A barcode has 12 (UPC-A), 13 (EAN-13) or 14 (GTIN-14) digits, not ${digits.length}.`,
    };
  }
  const gtin = digits.padStart(GTIN_14_LENGTH, '0');
  return { valid: true, gtin, checkDigitValid: gs1CheckDigit(gtin.slice(0, -1)) === Number(gtin.slice(-1)) };
};
