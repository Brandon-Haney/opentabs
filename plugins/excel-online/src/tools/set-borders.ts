import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rangePath, workbookApi } from '../excel-api.js';

const SIDE_INDEXES = {
  top: 'EdgeTop',
  bottom: 'EdgeBottom',
  left: 'EdgeLeft',
  right: 'EdgeRight',
  inside_horizontal: 'InsideHorizontal',
  inside_vertical: 'InsideVertical',
} as const;

type Edge = keyof typeof SIDE_INDEXES | 'all' | 'outline' | 'inside';

/** Expand edge aliases into the Graph border side indexes they cover, deduplicated in stable order. */
const resolveSides = (edges: readonly Edge[]): string[] => {
  const sides = new Set<string>();
  for (const edge of edges) {
    if (edge === 'all' || edge === 'outline') {
      sides.add(SIDE_INDEXES.top).add(SIDE_INDEXES.bottom).add(SIDE_INDEXES.left).add(SIDE_INDEXES.right);
    }
    if (edge === 'all' || edge === 'inside') {
      sides.add(SIDE_INDEXES.inside_horizontal).add(SIDE_INDEXES.inside_vertical);
    }
    if (edge in SIDE_INDEXES) sides.add(SIDE_INDEXES[edge as keyof typeof SIDE_INDEXES]);
  }
  return [...sides];
};

export const setBorders = defineTool({
  name: 'set_borders',
  displayName: 'Set Borders',
  description:
    'Apply borders to a range. Edges accept sides ("top", "bottom", "left", "right", "inside_horizontal", "inside_vertical") and the shortcuts "outline" (all four outer edges), "inside" (both inner grids), and "all" (outline + inside). Use style "None" to remove borders from the given edges.',
  summary: 'Apply or remove borders on a range',
  icon: 'square-dashed',
  group: 'Formatting',
  input: z.object({
    worksheet: z.string().describe('Worksheet name (e.g., "Sheet1")'),
    address: z.string().describe('Range address in A1 notation (e.g., "A1:L20")'),
    edges: z
      .array(
        z.enum(['all', 'outline', 'inside', 'top', 'bottom', 'left', 'right', 'inside_horizontal', 'inside_vertical']),
      )
      .min(1)
      .describe('Which edges to set'),
    style: z
      .enum(['Continuous', 'Dash', 'DashDot', 'DashDotDot', 'Dot', 'Double', 'SlantDashDot', 'None'])
      .optional()
      .describe('Line style (default "Continuous"); "None" removes the border'),
    color: z.string().optional().describe('Border color as hex "#RRGGBB" (default "#000000")'),
    weight: z.enum(['Hairline', 'Thin', 'Medium', 'Thick']).optional().describe('Line weight (default "Thin")'),
  }),
  output: z.object({
    sides_updated: z.array(z.string()).describe('Graph border side indexes that were updated'),
  }),
  handle: async params => {
    const style = params.style ?? 'Continuous';
    const body: Record<string, unknown> =
      style === 'None' ? { style } : { style, color: params.color ?? '#000000', weight: params.weight ?? 'Thin' };
    const sides = resolveSides(params.edges);
    for (const side of sides) {
      await workbookApi(`${rangePath(params.worksheet, params.address)}/format/borders/${side}`, {
        method: 'PATCH',
        body,
      });
    }
    return { sides_updated: sides };
  },
});
