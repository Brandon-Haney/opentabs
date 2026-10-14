import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { RGN_STAGE_NAMES, searchRgnStage } from '../rgn.js';
import { rgnCriteriaShape, rgnSchema, rgnStageSchema } from './rgn-schemas.js';

export const searchRgns = defineTool({
  name: 'search_rgns',
  displayName: 'Search RGNs',
  description:
    'Search RGNs (return goods notices: store returns to the DC) and the credit the DC has issued for them, from ' +
    'the reports behind the RGN Reconciliation Dashboard. Each RGN comes with its stage (pending credit, OS&D ' +
    'variance, reconciled), credit requested and received, variance and the DC’s status or decline reason. ' +
    'Filtering by part returns whole RGNs that contain the part, with RGN totals; use get_rgn for the part’s own ' +
    'line. An RGN is not linked to the inventory return transaction by any number; match them by part, date and ' +
    'return type (find_rgns_for_return does this). Each stage is a separate report run of a few seconds.',
  summary: 'Search RGNs and their DC credit status',
  icon: 'undo-2',
  group: 'Returns',
  input: z.object({
    ...rgnCriteriaShape,
    stages: z
      .array(rgnStageSchema)
      .min(1)
      .optional()
      .describe('Stages to search (default all). Name one stage to make the search faster'),
  }),
  output: z.object({
    rgns: z.array(rgnSchema).describe('Matching RGNs, grouped by stage in the order given, as each report lists them'),
  }),
  handle: async (params, context) => {
    const report = (message: string) => context?.reportProgress({ message });
    const rgns = [];
    for (const stage of params.stages ?? RGN_STAGE_NAMES) {
      report(`Searching ${stage.replace(/_/g, ' ')}`);
      rgns.push(...(await searchRgnStage(stage, params, report)));
    }
    return { rgns };
  },
});
