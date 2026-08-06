import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, isSharePointWorkbook, waitForAuth } from './excel-api.js';
import { addComment } from './tools/add-comment.js';
import { addConditionalFormat } from './tools/add-conditional-format.js';
import { addDataValidation } from './tools/add-data-validation.js';
import { addNamedItem } from './tools/add-named-item.js';
import { addTableColumn } from './tools/add-table-column.js';
import { addTableRow } from './tools/add-table-row.js';
import { addWorksheet } from './tools/add-worksheet.js';
import { addPivotField } from './tools/add-pivot-field.js';
import { applyCellStyle } from './tools/apply-cell-style.js';
import { calculateWorkbook } from './tools/calculate-workbook.js';
import { clearDataValidation } from './tools/clear-data-validation.js';
import { clearRange } from './tools/clear-range.js';
import { clearTableFilters } from './tools/clear-table-filters.js';
import { convertTableToRange } from './tools/convert-table-to-range.js';
import { createChart } from './tools/create-chart.js';
import { createTable } from './tools/create-table.js';
import { deleteChart } from './tools/delete-chart.js';
import { deleteRange } from './tools/delete-range.js';
import { deleteTable } from './tools/delete-table.js';
import { deleteTableRow } from './tools/delete-table-row.js';
import { deleteWorksheet } from './tools/delete-worksheet.js';
import { evaluateFormula } from './tools/evaluate-formula.js';
import { filterRangeColumn } from './tools/filter-range-column.js';
import { filterRangeCustom } from './tools/filter-range-custom.js';
import { filterRangeTop } from './tools/filter-range-top.js';
import { filterTable } from './tools/filter-table.js';
import { formatRangeAdvanced } from './tools/format-range-advanced.js';
import { formatRange } from './tools/format-range.js';
import { freezePanes } from './tools/freeze-panes.js';
import { getChartImage } from './tools/get-chart-image.js';
import { getCurrentUser } from './tools/get-current-user.js';
import { getPivotFieldLayout } from './tools/get-pivot-field-layout.js';
import { getPivotFilterMembers } from './tools/get-pivot-filter-members.js';
import { getRange } from './tools/get-range.js';
import { getTableColumns } from './tools/get-table-columns.js';
import { getTableRows } from './tools/get-table-rows.js';
import { getUsedRange } from './tools/get-used-range.js';
import { getWorkbookInfo } from './tools/get-workbook-info.js';
import { groupRowsColumns } from './tools/group-rows-columns.js';
import { hideRowsColumns } from './tools/hide-rows-columns.js';
import { insertPageBreak } from './tools/insert-page-break.js';
import { insertRange } from './tools/insert-range.js';
import { insertTable } from './tools/insert-table.js';
import { inspectDataModel } from './tools/inspect-data-model.js';
import { listCharts } from './tools/list-charts.js';
import { listNamedItems } from './tools/list-named-items.js';
import { listPivotTables } from './tools/list-pivot-tables.js';
import { listTables } from './tools/list-tables.js';
import { listWorksheets } from './tools/list-worksheets.js';
import { mergeCells } from './tools/merge-cells.js';
import { protectWorksheet } from './tools/protect-worksheet.js';
import { reauthenticate } from './tools/reauthenticate.js';
import { refreshPivot } from './tools/refresh-pivot.js';
import { removeDuplicates } from './tools/remove-duplicates.js';
import { setBorders } from './tools/set-borders.js';
import { setDimensions } from './tools/set-dimensions.js';
import { setHyperlink } from './tools/set-hyperlink.js';
import { setNumberFormat } from './tools/set-number-format.js';
import { setPivotFilter } from './tools/set-pivot-filter.js';
import { setPrintArea } from './tools/set-print-area.js';
import { sortRange } from './tools/sort-range.js';
import { textToColumns } from './tools/text-to-columns.js';
import { toggleRangeAutofilter } from './tools/toggle-range-autofilter.js';
import { unmergeCells } from './tools/unmerge-cells.js';
import { unprotectWorksheet } from './tools/unprotect-worksheet.js';
import { updateChart } from './tools/update-chart.js';
import { updateRange } from './tools/update-range.js';
import { updateTable } from './tools/update-table.js';
import { updateWorksheet } from './tools/update-worksheet.js';

class ExcelOnlinePlugin extends OpenTabsPlugin {
  readonly name = 'excel-online';
  readonly description = 'OpenTabs plugin for Microsoft Excel Online';
  override readonly displayName = 'Excel Online';
  readonly urlPatterns = ['*://excel.cloud.microsoft/*', '*://*.sharepoint.com/:x:/*'];
  override readonly homepage = 'https://excel.cloud.microsoft/';
  readonly tools: ToolDefinition[] = [
    // Account
    getCurrentUser,
    reauthenticate,
    // Workbook
    getWorkbookInfo,
    calculateWorkbook,
    evaluateFormula,
    listNamedItems,
    addNamedItem,
    // Worksheets
    listWorksheets,
    addWorksheet,
    updateWorksheet,
    deleteWorksheet,
    protectWorksheet,
    unprotectWorksheet,
    // Ranges
    getRange,
    getUsedRange,
    updateRange,
    clearRange,
    insertRange,
    deleteRange,
    sortRange,
    removeDuplicates,
    textToColumns,
    toggleRangeAutofilter,
    filterRangeColumn,
    filterRangeCustom,
    filterRangeTop,
    // Formatting
    formatRange,
    setNumberFormat,
    setDimensions,
    hideRowsColumns,
    groupRowsColumns,
    setBorders,
    mergeCells,
    unmergeCells,
    // Tables
    listTables,
    createTable,
    insertTable,
    updateTable,
    convertTableToRange,
    deleteTable,
    getTableRows,
    getTableColumns,
    addTableRow,
    deleteTableRow,
    addTableColumn,
    filterTable,
    clearTableFilters,
    // Data model — read from the raw .xlsx package, because the Microsoft Graph
    // workbook API exposes no PivotTable, connection, or pivot-cache surface.
    inspectDataModel,
    listPivotTables,
    getPivotFieldLayout,
    addPivotField,
    getPivotFilterMembers,
    setPivotFilter,
    refreshPivot,
    // Charts
    listCharts,
    createChart,
    updateChart,
    getChartImage,
    deleteChart,
    // Advanced — driven through Excel's internal service (frame bridge), for
    // features the Microsoft Graph workbook API does not expose.
    freezePanes,
    formatRangeAdvanced,
    setPrintArea,
    insertPageBreak,
    setHyperlink,
    addComment,
    addConditionalFormat,
    applyCellStyle,
    addDataValidation,
    clearDataValidation,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    // On SharePoint/OneDrive-hosted workbooks the Graph token is captured
    // asynchronously by the pre-script from MSAL's token-endpoint responses
    // and may not have arrived yet. Report the workbook page as ready so the
    // plugin activates on load; tool handlers surface a clear auth error if
    // the token has not been captured. Readiness checks must return promptly,
    // so this does not wait on token capture.
    if (isSharePointWorkbook()) return true;
    return waitForAuth();
  }
}

export default new ExcelOnlinePlugin();
