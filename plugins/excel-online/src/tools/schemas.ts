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
