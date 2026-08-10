import { type BridgeProjection, EWA_GET_CONTEXT_KEYS, type EwaBridgeExtra, pivotCellRef } from '../bridge.js';
import { PIVOT_DATA_SOURCE_INDEX } from './pivot-data-source.js';

/**
 * Trim a pivot write's response to the document revision it produced.
 *
 * `ApplyPivot` answers with `Result: null` and an envelope that restates the
 * workbook's entire sheet inventory and metadata — around 7 KB, none of it about
 * the write. The revision is the one part that says something: it advances when
 * the write applied. Errors are unaffected, because the engine judges failure
 * against the envelope before the projection replaces it.
 */
export const PIVOT_WRITE_PROJECTION: BridgeProjection = { path: 'WorkbookCoauthVersion.Xrevid' };

/**
 * Protocol version `GetPivotFieldManagerData` is called with. A constant of the
 * request shape, unrelated to the field-well counters it returns.
 */
const FIELD_MANAGER_PROTOCOL_VERSION = 4;

/**
 * Read the field well's concurrency counters and feed them into the write that
 * follows, as one bridge call.
 *
 * `ApplyPivot` guards every write with `FieldListVersion` and `FieldWellVersion`
 * and rejects a stale pair. The counters advance on every operation against the
 * pivot — including operations that *fail*, and including a coauthor's — and
 * they do not advance predictably (1/1 → 3/4 → 5/7 observed), so they cannot be
 * incremented, cached, or carried between calls.
 *
 * Reading them from the caller made every write two round trips and still raced:
 * anything touching the pivot between the read and the write invalidated the
 * pair, which surfaces as the service's generic out-of-sync error. Read here,
 * nothing can happen in the gap, because there is no gap — the engine replays
 * both calls back to back against one harvested context.
 */
export const pivotVersionPrep = (worksheet: string, cell: string): EwaBridgeExtra => ({
  prep: {
    method: 'GetPivotFieldManagerData',
    httpMethod: 'GET',
    contextKeys: EWA_GET_CONTEXT_KEYS,
    // A read: its session token and revision counters describe a read, so
    // folding them into the context the write then uses has no basis.
    mergesContext: false,
    options: {
      cell: pivotCellRef(worksheet, cell),
      dataSourceIndex: PIVOT_DATA_SOURCE_INDEX,
      optionalPivotAnchorParameter: { AnchorType: 0 },
      type: 1,
      version: FIELD_MANAGER_PROTOCOL_VERSION,
    },
  },
  prepOptionPaths: {
    'pivotFieldApplyData.FieldListVersion': 'Result.FieldListVersion',
    'pivotFieldApplyData.FieldWellVersion': 'Result.FieldWellVersion',
  },
});
