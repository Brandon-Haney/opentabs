import { ToolError } from '@opentabs-dev/plugin-sdk';

/** Zero-based inclusive cell bounds of a rectangular range. */
export interface RangeBounds {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

/** Convert a column letter sequence to a zero-based index (e.g. "A" → 0, "AB" → 27). */
export const columnToIndex = (letters: string): number => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Convert a zero-based column index to its letter sequence (e.g. 0 → "A", 27 → "AB"). */
export const indexToColumn = (index: number): string => {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

const parseCell = (ref: string): { row: number; col: number } | null => {
  const match = CELL_RE.exec(ref);
  const letters = match?.[1];
  const digits = match?.[2];
  if (letters === undefined || digits === undefined) return null;
  return { row: Number.parseInt(digits, 10) - 1, col: columnToIndex(letters) };
};

/**
 * Parse a bounded A1-notation range (e.g. "B3", "A1:C10", "Sheet1!A1:C10") into
 * zero-based cell bounds. Throws for unbounded forms like "A:D" or "3:5", which
 * have no cell-level dimensions to match a 2D array against.
 */
export const parseBoundedRange = (address: string): RangeBounds => {
  const bare = address.includes('!') ? address.slice(address.lastIndexOf('!') + 1) : address;
  const parts = bare.split(':');
  const start = parts.length <= 2 && parts[0] !== undefined ? parseCell(parts[0]) : null;
  const end = parts.length === 2 && parts[1] !== undefined ? parseCell(parts[1]) : start;
  if (!start || !end) {
    throw ToolError.validation(
      `"${address}" is not a bounded cell range. Use A1 notation with explicit rows and columns (e.g. "A1:C10").`,
    );
  }
  return {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endCol: Math.max(start.col, end.col),
  };
};

/** Build an A1-notation address from zero-based bounds (e.g. → "A1:C10", single cells → "B3"). */
export const buildRangeAddress = (bounds: RangeBounds): string => {
  const start = `${indexToColumn(bounds.startCol)}${bounds.startRow + 1}`;
  const end = `${indexToColumn(bounds.endCol)}${bounds.endRow + 1}`;
  return start === end ? start : `${start}:${end}`;
};
