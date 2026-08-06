import { ToolError } from '@opentabs-dev/plugin-sdk';
import { api } from './powerbi-api.js';

/**
 * DAX execution against a Power BI semantic model.
 *
 * Everything here goes through `POST /datasets/{id}/executeQueries` in its
 * non-workspace form. That form is deliberate: it resolves any model the caller
 * holds Build permission on, whereas the `/groups/{id}/...` form additionally
 * requires workspace membership and answers 401 for someone who reaches a model
 * only through a published app.
 */

/** A DAX cell. `executeQueries` returns JSON scalars only. */
export type DaxValue = string | number | boolean | null;
export type DaxRow = Record<string, DaxValue>;

export interface DaxResult {
  rows: DaxRow[];
  /** Column names, as the union of keys across every row. */
  columns: string[];
  /** False when some row omitted a column the others carried — see {@link DaxResult.inconsistentColumns}. */
  columnsConsistent: boolean;
  /** Columns missing from at least one row. Empty when consistent. */
  inconsistentColumns: string[];
}

interface ExecuteQueriesResponse {
  error?: unknown;
  results?: { error?: unknown; tables?: { rows?: DaxRow[] }[] }[];
}

/** Render an API-supplied error object without letting an unbounded blob through. */
const describeError = (error: unknown): string => {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error.slice(0, 512);
  const record = error as { message?: unknown; code?: unknown };
  if (typeof record.message === 'string') return record.message.slice(0, 512);
  if (typeof record.code === 'string') return record.code.slice(0, 512);
  try {
    return JSON.stringify(error).slice(0, 512);
  } catch {
    return 'unknown error';
  }
};

/**
 * Execute one DAX query and return its single result table.
 *
 * Two behaviours here are not optional:
 *
 * - `includeNulls` is always true. Left at its default of false the serializer
 *   *omits the key entirely* for a null cell, so a row with no value for a
 *   column silently loses that column rather than reporting a blank.
 * - Errors can arrive inside an HTTP 200. Both the envelope's `error` and each
 *   entry's own `error` are checked before anything is treated as data.
 */
export const runDaxQuery = async (datasetId: string, query: string): Promise<DaxResult> => {
  const response = await api<ExecuteQueriesResponse>(`/datasets/${encodeURIComponent(datasetId)}/executeQueries`, {
    method: 'POST',
    body: {
      queries: [{ query }],
      serializerSettings: { includeNulls: true },
    },
  });

  if (response.error !== undefined && response.error !== null) {
    throw ToolError.validation(`Power BI rejected the DAX query: ${describeError(response.error)}`);
  }

  const [result] = response.results ?? [];
  if (!result) {
    throw ToolError.internal('Power BI returned no result for the DAX query.');
  }
  if (result.error !== undefined && result.error !== null) {
    throw ToolError.validation(`The DAX query failed: ${describeError(result.error)}`);
  }

  const rows = result.tables?.[0]?.rows ?? [];

  // The response carries no column list, so columns are the union of keys
  // across every row — never the first row's keys, which would drop a column
  // that happens to be absent from row one.
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const inconsistentColumns = columns.filter(column => rows.some(row => !(column in row)));

  return {
    rows,
    columns,
    columnsConsistent: inconsistentColumns.length === 0,
    inconsistentColumns,
  };
};
