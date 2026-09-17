import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { bridgeOutputSchema, ewaBridge, selectedRanges, viewportSelection } from '../bridge.js';

/**
 * `FormatCellsV2` edge bits, decoded from the editor's Borders menu: each side,
 * both inner grids, and 64 for the outer box as a whole.
 */
export const BORDER_EDGE_BITS = {
  bottom: 1,
  top: 2,
  left: 4,
  right: 8,
  inside_horizontal: 16,
  inside_vertical: 32,
  outline: 64,
} as const;

const EDGES = [
  'all',
  'outline',
  'inside',
  'top',
  'bottom',
  'left',
  'right',
  'inside_horizontal',
  'inside_vertical',
] as const;
type Edge = (typeof EDGES)[number];

const STYLES = ['Continuous', 'Dash', 'DashDot', 'DashDotDot', 'Dot', 'Double', 'SlantDashDot', 'None'] as const;
const WEIGHTS = ['Hairline', 'Thin', 'Medium', 'Thick'] as const;
type Style = (typeof STYLES)[number];
type Weight = (typeof WEIGHTS)[number];

/** Combine the requested edges into the `Border` bitmask. */
export const borderEdgeMask = (edges: readonly Edge[]): number =>
  edges.reduce((mask, edge) => {
    if (edge === 'all')
      return mask | BORDER_EDGE_BITS.outline | BORDER_EDGE_BITS.inside_horizontal | BORDER_EDGE_BITS.inside_vertical;
    if (edge === 'inside') return mask | BORDER_EDGE_BITS.inside_horizontal | BORDER_EDGE_BITS.inside_vertical;
    return mask | BORDER_EDGE_BITS[edge];
  }, 0);

/**
 * The line-style code for a style and weight. The codes are Excel's file-format
 * border styles (thin 1, medium 2, dashed 3, dotted 4, thick 5, double 6, hair 7,
 * medium dashed 8, dash-dot 9, medium dash-dot 10, dash-dot-dot 11, medium
 * dash-dot-dot 12, slanted dash-dot 13); thin, medium, dashed, dotted and double
 * were read from the editor's own requests.
 */
export const borderLineStyle = (style: Style, weight: Weight): number => {
  const heavy = weight === 'Medium' || weight === 'Thick';
  switch (style) {
    case 'Continuous':
      return { Hairline: 7, Thin: 1, Medium: 2, Thick: 5 }[weight];
    case 'Dash':
      return heavy ? 8 : 3;
    case 'Dot':
      return 4;
    case 'Double':
      return 6;
    case 'DashDot':
      return heavy ? 10 : 9;
    case 'DashDotDot':
      return heavy ? 12 : 11;
    case 'SlantDashDot':
      return 13;
    case 'None':
      return 0;
  }
};

/** A `#RRGGBB` colour as the integer the editor sends: its bytes in blue-green-red order. */
export const borderColorValue = (hex: string): number => {
  const rgb = Number.parseInt(hex.replace('#', ''), 16);
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
};

export const buildSetBordersOptions = (
  worksheet: string,
  address: string,
  edges: readonly Edge[],
  style: Style,
  weight: Weight,
  color: string,
): Record<string, unknown> => {
  const lineStyle = borderLineStyle(style, weight);
  const colorValue = borderColorValue(color);
  const range = selectedRanges(worksheet, address);
  return {
    formatCellsMultiRange: range,
    format: {
      BorderFormat: {
        Color: [colorValue, colorValue, colorValue, colorValue],
        LineStyle: [lineStyle, lineStyle, lineStyle, lineStyle],
      },
      ValidMembers: 128,
      // Removing every edge is the editor's No Border, which sends an empty mask.
      Border: style === 'None' && edges.includes('all') ? 0 : borderEdgeMask(edges),
    },
    activeCell: {
      SheetName: worksheet,
      NamedObjectName: '',
      FirstRow: range.Ranges[0]?.FirstRow ?? 0,
      FirstColumn: range.Ranges[0]?.FirstColumn ?? 0,
    },
    options: {
      ApplyFormatOnPivotTableValueField: false,
      PivotTableXluid: null,
      PivotTableFieldCaption: null,
      ConvertTextValuesToNewFormat: false,
      UnmergeCellsFirst: false,
    },
  };
};

export const setBorders = defineTool({
  name: 'set_borders',
  displayName: 'Set Borders',
  description:
    'Apply borders to a range, like the Home → Borders menu. Edges accept sides ("top", "bottom", "left", "right", ' +
    '"inside_horizontal", "inside_vertical") and the shortcuts "outline" (the outer box), "inside" (both inner grids) ' +
    'and "all". Style and weight pick the line (e.g. Continuous + Thick, Dash, Dot, Double); style "None" with edges ' +
    '["all"] removes every border from the range. Sent as the editor\'s own formatting request inside the open ' +
    'editing session.',
  summary: 'Apply or remove borders on a range',
  icon: 'square-dashed',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation (e.g., "A1:L20")'),
    edges: z.array(z.enum(EDGES)).min(1).describe('Which edges to set'),
    style: z.enum(STYLES).optional().describe('Line style (default "Continuous"); "None" removes the border'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe('Border color as hex "#RRGGBB" (default "#000000")'),
    weight: z.enum(WEIGHTS).optional().describe('Line weight (default "Thin")'),
  }),
  output: bridgeOutputSchema,
  handle: async params =>
    ewaBridge(
      'FormatCellsV2',
      buildSetBordersOptions(
        params.worksheet,
        params.address,
        params.edges,
        params.style ?? 'Continuous',
        params.weight ?? 'Thin',
        params.color ?? '#000000',
      ),
      { contextPatch: viewportSelection(params.worksheet, params.address) },
    ),
});
