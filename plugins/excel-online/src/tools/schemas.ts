import { z } from 'zod';

// --- Worksheet ---

export const worksheetSchema = z.object({
  id: z.string().describe('Worksheet ID'),
  name: z.string().describe('Worksheet name'),
  position: z.number().int().describe('Zero-based position of the worksheet within the workbook'),
  visibility: z.string().describe('Worksheet visibility: Visible, Hidden, or VeryHidden'),
});

export interface RawWorksheet {
  id?: string;
  name?: string;
  position?: number;
  visibility?: string;
}

export const mapWorksheet = (w: RawWorksheet) => ({
  id: w.id ?? '',
  name: w.name ?? '',
  position: w.position ?? 0,
  visibility: w.visibility ?? 'Visible',
});

// --- Range ---

export const rangeSchema = z.object({
  address: z.string().describe('Range address in A1 notation (e.g., "Sheet1!A1:C3")'),
  row_count: z.number().int().describe('Number of rows in the range'),
  column_count: z.number().int().describe('Number of columns in the range'),
  values: z.array(z.array(z.unknown())).describe('2D array of cell values (strings, numbers, booleans)'),
  formulas: z.array(z.array(z.unknown())).describe('2D array of cell formulas'),
  text: z.array(z.array(z.string())).describe('2D array of formatted text representations of cell values'),
  number_format: z.array(z.array(z.string())).describe('2D array of number format codes'),
});

export interface RawRange {
  address?: string;
  rowCount?: number;
  columnCount?: number;
  values?: unknown[][];
  formulas?: unknown[][];
  text?: string[][];
  numberFormat?: string[][];
}

export const mapRange = (r: RawRange) => ({
  address: r.address ?? '',
  row_count: r.rowCount ?? 0,
  column_count: r.columnCount ?? 0,
  values: r.values ?? [],
  formulas: r.formulas ?? [],
  text: r.text ?? [],
  number_format: r.numberFormat ?? [],
});

// --- Cell format ---

export const horizontalAlignmentSchema = z.enum([
  'General',
  'Left',
  'Center',
  'Right',
  'Fill',
  'Justify',
  'CenterAcrossSelection',
  'Distributed',
]);

export const verticalAlignmentSchema = z.enum(['Top', 'Center', 'Bottom', 'Justify', 'Distributed']);

export const fontUnderlineSchema = z.enum(['None', 'Single', 'Double', 'SingleAccountant', 'DoubleAccountant']);

export const cellFormatSchema = z.object({
  fill: z
    .object({
      color: z.string().nullable().describe('Fill color as hex "#RRGGBB". Pass null to clear the fill.'),
    })
    .optional()
    .describe('Cell background fill'),
  font: z
    .object({
      name: z.string().optional().describe('Font name (e.g., "Calibri")'),
      size: z.number().positive().optional().describe('Font size in points'),
      color: z.string().optional().describe('Font color as hex "#RRGGBB"'),
      bold: z.boolean().optional().describe('Bold text'),
      italic: z.boolean().optional().describe('Italic text'),
      underline: fontUnderlineSchema.optional().describe('Underline style'),
    })
    .optional()
    .describe('Font styling'),
  align: z
    .object({
      horizontal: horizontalAlignmentSchema.optional().describe('Horizontal alignment'),
      vertical: verticalAlignmentSchema.optional().describe('Vertical alignment'),
      wrap_text: z.boolean().optional().describe('Wrap text within the cell'),
    })
    .optional()
    .describe('Cell alignment and text wrapping'),
});

export type CellFormat = z.infer<typeof cellFormatSchema>;

// --- Range format read-back ---
//
// Format reads are range-level: the Graph API returns null for any property
// that varies across the cells of the range.

export const rangeFormatSchema = z.object({
  fill_color: z
    .string()
    .nullable()
    .describe('Fill color as hex; "" when the range has no fill; null when it varies across the range'),
  font: z.object({
    name: z.string().nullable().describe('Font name; null when it varies'),
    size: z.number().nullable().describe('Font size in points; null when it varies'),
    color: z.string().nullable().describe('Font color as hex; null when it varies'),
    bold: z.boolean().nullable().describe('Bold; null when it varies'),
    italic: z.boolean().nullable().describe('Italic; null when it varies'),
    underline: z.string().nullable().describe('Underline style; null when it varies'),
  }),
  horizontal_alignment: z.string().nullable().describe('Horizontal alignment; null when it varies'),
  vertical_alignment: z.string().nullable().describe('Vertical alignment; null when it varies'),
  wrap_text: z.boolean().nullable().describe('Text wrapping; null when it varies'),
  column_width: z.number().nullable().describe('Column width in points; null when columns differ'),
  row_height: z.number().nullable().describe('Row height in points; null when rows differ'),
  borders: z
    .array(
      z.object({
        side: z.string().describe('Border side (e.g., "EdgeTop", "InsideVertical")'),
        style: z.string().describe('Line style (e.g., "Continuous", "Double")'),
        color: z.string().nullable().describe('Border color as hex; null when it varies'),
        weight: z.string().nullable().describe('Line weight (e.g., "Thin", "Medium"); null when it varies'),
      }),
    )
    .describe('Borders with a visible line style; sides without a border are omitted'),
});

export interface RawRangeFormat {
  columnWidth?: number | null;
  rowHeight?: number | null;
  horizontalAlignment?: string | null;
  verticalAlignment?: string | null;
  wrapText?: boolean | null;
  fill?: { color?: string | null };
  font?: {
    name?: string | null;
    size?: number | null;
    color?: string | null;
    bold?: boolean | null;
    italic?: boolean | null;
    underline?: string | null;
  };
}

export interface RawBorder {
  sideIndex?: string;
  style?: string | null;
  color?: string | null;
  weight?: string | null;
}

export const mapRangeFormat = (format: RawRangeFormat, borders: RawBorder[]) => ({
  fill_color: format.fill?.color ?? null,
  font: {
    name: format.font?.name ?? null,
    size: format.font?.size ?? null,
    color: format.font?.color ?? null,
    bold: format.font?.bold ?? null,
    italic: format.font?.italic ?? null,
    underline: format.font?.underline ?? null,
  },
  horizontal_alignment: format.horizontalAlignment ?? null,
  vertical_alignment: format.verticalAlignment ?? null,
  wrap_text: format.wrapText ?? null,
  column_width: format.columnWidth ?? null,
  row_height: format.rowHeight ?? null,
  borders: borders
    .filter(b => b.sideIndex !== undefined && b.style != null && b.style !== 'None')
    .map(b => ({
      side: b.sideIndex ?? '',
      style: b.style ?? '',
      color: b.color ?? null,
      weight: b.weight ?? null,
    })),
});

// --- Table ---

export const tableSchema = z.object({
  id: z.string().describe('Table ID'),
  name: z.string().describe('Table name'),
  show_headers: z.boolean().describe('Whether the header row is visible'),
  show_totals: z.boolean().describe('Whether the total row is visible'),
  style: z.string().describe('Table style name (e.g., "TableStyleMedium2")'),
  show_filter_button: z.boolean().describe('Whether filter dropdown buttons are visible on the header row'),
  show_banded_rows: z.boolean().describe('Whether rows show alternating banding'),
  show_banded_columns: z.boolean().describe('Whether columns show alternating banding'),
  highlight_first_column: z.boolean().describe('Whether the first column has emphasized formatting'),
  highlight_last_column: z.boolean().describe('Whether the last column has emphasized formatting'),
});

export interface RawTable {
  id?: string;
  name?: string;
  showHeaders?: boolean;
  showTotals?: boolean;
  style?: string;
  showFilterButton?: boolean;
  showBandedRows?: boolean;
  showBandedColumns?: boolean;
  highlightFirstColumn?: boolean;
  highlightLastColumn?: boolean;
}

export const mapTable = (t: RawTable) => ({
  id: t.id ?? '',
  name: t.name ?? '',
  show_headers: t.showHeaders ?? true,
  show_totals: t.showTotals ?? false,
  style: t.style ?? '',
  show_filter_button: t.showFilterButton ?? true,
  show_banded_rows: t.showBandedRows ?? true,
  show_banded_columns: t.showBandedColumns ?? false,
  highlight_first_column: t.highlightFirstColumn ?? false,
  highlight_last_column: t.highlightLastColumn ?? false,
});

// --- Table Column ---

export const tableColumnSchema = z.object({
  id: z.string().describe('Column ID'),
  name: z.string().describe('Column name'),
  index: z.number().int().describe('Zero-based column index within the table'),
});

export interface RawTableColumn {
  id?: string;
  name?: string;
  index?: number;
}

export const mapTableColumn = (c: RawTableColumn) => ({
  id: c.id ?? '',
  name: c.name ?? '',
  index: c.index ?? 0,
});

// --- Table Row ---

export const tableRowSchema = z.object({
  index: z.number().int().describe('Zero-based row index within the table'),
  values: z.array(z.array(z.unknown())).describe('2D array with a single row of cell values'),
});

export interface RawTableRow {
  index?: number;
  values?: unknown[][];
}

export const mapTableRow = (r: RawTableRow) => ({
  index: r.index ?? 0,
  values: r.values ?? [],
});

// --- Named Item ---

export const namedItemSchema = z.object({
  name: z.string().describe('Named item name'),
  type: z.string().describe('Named item type (e.g., "Range", "String", "Integer")'),
  value: z.string().describe('Named item value or formula'),
  visible: z.boolean().describe('Whether the named item is visible'),
});

export interface RawNamedItem {
  name?: string;
  type?: string;
  value?: unknown;
  visible?: boolean;
}

export const mapNamedItem = (n: RawNamedItem) => ({
  name: n.name ?? '',
  type: n.type ?? '',
  value: String(n.value ?? ''),
  visible: n.visible ?? true,
});

// --- Chart ---

export const chartSchema = z.object({
  id: z.string().describe('Chart ID'),
  name: z.string().describe('Chart name'),
  height: z.number().describe('Chart height in points'),
  width: z.number().describe('Chart width in points'),
  top: z.number().describe('Distance from top of worksheet in points'),
  left: z.number().describe('Distance from left of worksheet in points'),
});

export interface RawChart {
  id?: string;
  name?: string;
  height?: number;
  width?: number;
  top?: number;
  left?: number;
}

export const mapChart = (c: RawChart) => ({
  id: c.id ?? '',
  name: c.name ?? '',
  height: c.height ?? 0,
  width: c.width ?? 0,
  top: c.top ?? 0,
  left: c.left ?? 0,
});

// --- User ---

export const userSchema = z.object({
  id: z.string().describe('User ID'),
  display_name: z.string().describe('User display name'),
  email: z.string().describe('User email address'),
});

// --- Workbook info (from URL context) ---

export const workbookInfoSchema = z.object({
  drive_id: z.string().describe('OneDrive drive ID'),
  item_id: z.string().describe('Workbook item ID'),
  name: z.string().describe('Workbook file name'),
});

// --- Graph list response ---

export interface GraphListResponse<T> {
  value?: T[];
}

// --- Data model (PivotTables, caches, connections) ---
//
// These describe parts of the raw .xlsx package. Microsoft Graph exposes no
// PivotTable, connection or pivot-cache surface at any version, so the tools
// that produce them read the workbook file itself.

export const connectionSchema = z.object({
  id: z.string().describe('Connection ID within the workbook, joined to by a pivot cache'),
  name: z
    .string()
    .describe(
      'Connection name. This is the exact string CUBEVALUE and CUBEMEMBER take as their first argument (e.g., CUBEVALUE("MyConnection", "[Measures].[Sales]")).',
    ),
  description: z.string().describe('Connection description, empty when unset'),
  type: z.string().describe('Connection type (e.g., "OLE DB", "ODBC", "Web query")'),
  provider: z.string().describe('OLE DB provider from the connection string (e.g., "MSOLAP.8"), empty if absent'),
  server: z
    .string()
    .describe(
      'Data Source from the connection string. "pbiazure://api.powerbi.com" means a Power BI semantic model; "$Embedded$" means the workbook\'s own Data Model.',
    ),
  catalog: z.string().describe('Initial Catalog from the connection string, empty if absent'),
  command: z.string().describe('Command the connection issues (e.g., "Model" for a cube connection), empty if absent'),
  is_remote_model: z
    .boolean()
    .nullable()
    .describe(
      'True when the data lives outside this workbook, false when it comes from the workbook\'s own embedded Data Model, null when the connection string is ambiguous. Always check "raw" when null.',
    ),
  dataset_id: z
    .string()
    .describe(
      'Power BI semantic-model (dataset) ID, extracted from an "Initial Catalog=sobe_wowvirtualserver-<guid>" catalog. Empty when the connection is not Power BI. Use this with the Power BI executeQueries API to run DAX against the same model.',
    ),
  raw: z.string().describe('The full, unmodified connection string'),
});

/**
 * Shared description for the field id, which appears on measures, hierarchies
 * and filters alike because all three are `cacheHierarchy` entries in one list.
 */
const FIELD_INDEX_DESCRIPTION =
  'Numeric id of the field within its pivot cache. This is the id every PivotTable write operation ' +
  'addresses the field by, and it is the same number the live field layout reports as PivotCacheIndex. ' +
  'Unlike a caption it is unambiguous, so prefer it when targeting a field.';

export const pivotFilterSchema = z.object({
  caption: z.string().describe('Display name of the filter field (e.g., "Invoice Month")'),
  selected_member: z
    .string()
    .describe(
      'Unique name of the member the filter is currently pinned to (e.g., "[Calendar Table].[Invoice Month].&[JUL - 2026]"). Empty when the filter is on All or a multi-selection. A hardcoded member goes stale silently as time moves on.',
    ),
  field_index: z.number().int().describe(`${FIELD_INDEX_DESCRIPTION} -1 when the PivotTable is not cube-backed.`),
});

export const pivotTableSchema = z.object({
  name: z.string().describe('PivotTable name'),
  worksheet: z.string().describe('Name of the worksheet hosting the PivotTable'),
  anchor: z.string().describe('Range the PivotTable occupies, in A1 notation (e.g., "A4:V5")'),
  cache_id: z.string().describe('ID of the pivot cache backing this PivotTable'),
  connection_name: z.string().describe('Name of the workbook connection behind the cache, empty if unresolved'),
  rows: z.array(z.string()).describe('Captions of the fields in the Rows zone'),
  columns: z
    .array(z.string())
    .describe('Captions of the fields in the Columns zone. "Values" denotes the synthetic measures field.'),
  filters: z.array(pivotFilterSchema).describe('Fields in the Filters zone with their pinned members'),
  values: z.array(z.string()).describe('Captions of the measures in the Values zone'),
});

export const availableMeasureSchema = z.object({
  unique_name: z.string().describe('MDX unique name (e.g., "[Measures].[CMTD Sales]"), as GETPIVOTDATA expects it'),
  caption: z.string().describe('Display name (e.g., "CMTD Sales")'),
  field_index: z.number().int().describe(FIELD_INDEX_DESCRIPTION),
  cache_id: z.string().describe('ID of the pivot cache that exposes this measure'),
  display_folder: z.string().describe('Folder the model groups the measure under, empty when ungrouped'),
  measure_group: z.string().describe('Measure group the measure belongs to, empty when unset'),
  is_laid_out: z
    .boolean()
    .describe(
      'True when the measure is already placed in a PivotTable. GETPIVOTDATA resolves only laid-out measures and returns #REF! for the rest, so a false value means the measure exists in the model but is not yet readable by formula.',
    ),
  period_relative: z
    .boolean()
    .describe(
      'True when the measure computes its own period and therefore ignores any date in the PivotTable — a date hierarchy in rows returns the identical number on every row, and a date page filter does not move it. ' +
        'Choose one of these only when the period it names is the one wanted ("CMTD Sales" for the current month to date); for any specific period, pick a measure where this is false and filter the date yourself. ' +
        'Inferred from the caption, since the pivot cache publishes no formula — confirm against display_folder, which models typically use to separate time-intelligence measures from base ones.',
    ),
});

export const availableHierarchySchema = z.object({
  unique_name: z.string().describe('MDX unique name (e.g., "[Calendar Table].[Invoice Month]")'),
  caption: z.string().describe('Display name (e.g., "Invoice Month")'),
  field_index: z.number().int().describe(FIELD_INDEX_DESCRIPTION),
  cache_id: z.string().describe('ID of the pivot cache that exposes this hierarchy'),
  dimension: z.string().describe('Unique name of the owning dimension (e.g., "[Calendar Table]")'),
  display_folder: z.string().describe('Folder the model groups the hierarchy under, empty when ungrouped'),
  level_count: z.number().int().describe('Number of levels the hierarchy declares'),
  levels: z
    .array(z.string())
    .describe('Unique names of the levels materialised in the cache. Empty unless the hierarchy is laid out.'),
  is_attribute: z.boolean().describe('True for a single-attribute hierarchy rather than a multi-level user hierarchy'),
  is_time: z.boolean().describe('True when the model marks this as a time hierarchy'),
  is_laid_out: z.boolean().describe('True when the hierarchy is already placed in a PivotTable'),
});
