import type { ToolHandlerContext } from '@opentabs-dev/plugin-sdk';
import type { z } from 'zod';
import { type bridgeOutputSchema, EWA_ERROR_HINTS, ewaBridge } from './bridge.js';

/**
 * The workbook REST API tunnelled through `ExecuteRichApiRequest`.
 *
 * Excel's editor frame answers Office.js-style REST calls — the resource paths
 * the Graph workbook API uses (`worksheets('Sheet1')/range(address='A1')`), plus
 * methods Graph v1.0 lacks (`copyFrom`, `replaceAll`, `pivotTables/add`) — inside
 * the live co-authoring session. A call runs in milliseconds and needs no Graph
 * token. The outcome comes back as `Result.ResponseStatusCode` with an OData body
 * inside a 200 envelope; the frame-bridge engine reports a status of 400 or above
 * as a failure.
 *
 * A PATCH echoes only the resource's default fields, so a property it accepted is
 * usually absent from the reply. Read it back with `$select` to confirm what
 * applied rather than reading the response of the write.
 */

/** HTTP verbs the tunnel accepts, in the casing Excel's own requests use. */
export type WorkbookRestVerb = 'Get' | 'Post' | 'Patch' | 'Delete';

/** `RequestFlags` Excel's own reads send. */
const READ_FLAGS = 256;
/** `RequestFlags` for a call that changes the workbook. */
const WRITE_FLAGS = 1;

/** Quote a value for an OData key or function argument, doubling any `'`. */
const odataString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** A worksheet segment of a resource path. */
export const worksheetPath = (worksheet: string): string => `worksheets(${odataString(worksheet)})`;

/** A range segment of a resource path under its worksheet. */
export const rangePath = (worksheet: string, address: string): string =>
  `${worksheetPath(worksheet)}/range(address=${odataString(address)})`;

/** A sheet-qualified range reference, quoting the sheet name when Excel requires it. */
export const qualifiedRange = (worksheet: string, address: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(worksheet) ? `${worksheet}!${address}` : `${odataString(worksheet)}!${address}`;

/** The `ExecuteRichApiRequest` options for one REST call. */
export const buildWorkbookRestOptions = (
  verb: WorkbookRestVerb,
  path: string,
  body?: Record<string, unknown>,
): Record<string, unknown> => ({
  request: {
    HttpMethod: verb,
    PathAndQuery: path,
    RequestHeaders: body === undefined ? null : [{ Name: 'Content-Type', Value: 'application/json' }],
    RequestBody: body === undefined ? '' : JSON.stringify(body),
    RequestFlags: verb === 'Get' ? READ_FLAGS : WRITE_FLAGS,
  },
});

/**
 * Issue one tunnelled REST call. The tool result's `response` is the OData body
 * as a JSON string, which is all a caller needs from the envelope.
 */
export const workbookRest = (
  verb: WorkbookRestVerb,
  path: string,
  body?: Record<string, unknown>,
): z.infer<typeof bridgeOutputSchema> =>
  ewaBridge('ExecuteRichApiRequest', buildWorkbookRestOptions(verb, path, body), {
    projection: { path: 'Result.ResponseBody.0' },
    errorHints: EWA_ERROR_HINTS,
  });

/**
 * Issue a tunnelled REST call and return its parsed OData body, for a tool that
 * has to act on the payload rather than hand the raw envelope back.
 *
 * Needs `context.bridge`, which the platform provides to a tool handler; a
 * caller that only needs the envelope should return {@link workbookRest}
 * instead. Returns null when the call answered with no body (a 204 from a
 * delete, for example).
 */
export const workbookRestCall = async <T>(
  context: ToolHandlerContext | undefined,
  verb: WorkbookRestVerb,
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> => {
  if (!context?.bridge) {
    throw new Error('This browser extension is too old to run a workbook call from a tool. Update the extension.');
  }
  const result = (await context.bridge(workbookRest(verb, path, body))) as { response?: unknown };
  const payload = result?.response;
  if (typeof payload !== 'string' || payload.length === 0) return null;
  return JSON.parse(payload) as T;
};
