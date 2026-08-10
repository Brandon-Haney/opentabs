/**
 * The index each PivotTable method addresses a pivot's data source by.
 *
 * A PivotTable has exactly one cache and therefore exactly one data source, so
 * this is never a caller's decision — but the service does not number that
 * single source consistently, and the value is per method rather than global.
 * Every value here comes from watching Excel's own client drive one pivot, built
 * over the workbook's third connection, so none of them index the workbook's
 * connection list.
 *
 * Held here rather than exposed as tool arguments because the obvious way to
 * check the value does not work. `GetPivotFieldManagerData` locates the pivot
 * from the cell alone and returns the right field well whatever index it is
 * handed, so a wrong value survives the read meant to establish it and fails
 * later, on the write, as a bare `InternalError` naming nothing. On
 * `GetPivotFilterData` a wrong value is worse than an error: it answers with the
 * "All" row alone, which reads as a filter that genuinely has one member.
 */

/**
 * Index for the field well (`GetPivotFieldManagerData`, `ApplyPivot`) and the
 * page filters (`GetPivotFilterData`, `ApplyFilter`).
 */
export const PIVOT_DATA_SOURCE_INDEX = 0;

/**
 * Index for `SearchPivotFilter`, which wants one where the filter methods it
 * sits beside want zero.
 *
 * Captured from the client searching the same field, on the same pivot, in the
 * same dropdown as the `GetPivotFilterData` call that sends zero. There is no
 * rule here to derive — the two simply disagree.
 */
export const SEARCH_DATA_SOURCE_INDEX = 1;
