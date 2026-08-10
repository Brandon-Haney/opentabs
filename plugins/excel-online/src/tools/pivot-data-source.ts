/**
 * The index each PivotTable method addresses a pivot's data source by.
 *
 * A PivotTable has exactly one cache and therefore exactly one data source, but
 * the service does not number that single source consistently: the value varies
 * by method *and* by pivot, and nothing in the workbook package is known to
 * derive it.
 *
 * These are defaults, not truths. They are what the client was captured sending
 * for one pivot, and a later capture of a two-model workbook showed the client
 * sending `1` for a pivot over one model and `0` for a pivot over the other, in
 * the same burst, on the same method. So no single constant is right for every
 * pivot, and the filter tools accept an override.
 *
 * How strictly the service enforces it is not established, and the evidence
 * points at "loosely". `GetPivotFieldManagerData` locates the pivot from the
 * cell alone and returns the right field well whatever index it is handed. And
 * a browse of the very pivot the client addresses as `1` returns its full
 * thousand-member list when addressed as `0`, so a mismatch is plainly not fatal
 * on `GetPivotFilterData` either.
 *
 * Earlier notes here claimed a wrong index makes that method answer with the
 * "All" row alone — a silent wrong answer rather than an error. That has never
 * been reproduced deliberately, and the run above is a counterexample to it, so
 * treat it as a symptom worth trying the override against rather than a
 * diagnosis. A wrong value has been seen to fail a *write* as a bare
 * `InternalError` naming nothing, which is the case that motivated pinning
 * these down.
 */

/**
 * Default for the field well (`GetPivotFieldManagerData`, `ApplyPivot`) and the
 * page filters (`GetPivotFilterData`, `ApplyFilter`).
 */
export const PIVOT_DATA_SOURCE_INDEX = 0;

/**
 * Default for `SearchPivotFilter`, which wants one where the filter methods it
 * sits beside want zero.
 *
 * Captured from the client searching the same field, on the same pivot, in the
 * same dropdown as the `GetPivotFilterData` call that sends zero. There is no
 * rule here to derive — the two simply disagree on that pivot.
 */
export const SEARCH_DATA_SOURCE_INDEX = 1;

/** Shared description for the `data_source_index` override on the filter tools. */
export const DATA_SOURCE_INDEX_DESCRIPTION =
  'Override the data-source index this pivot is addressed by. Omit it: the default is right for every pivot tested. ' +
  'Excel itself sends different values for different pivots of one workbook (0 and 1 both observed), so this exists for ' +
  'a pivot the default cannot drive — a write failing as a bare InternalError, or a filter answering with fewer members ' +
  'than it has. Try the other value before concluding anything else is wrong.';
