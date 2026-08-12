import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import { mapModelDetail, modelDetailSchema, type RawModelDetail } from './schemas.js';

export const getModel = defineTool({
  name: 'get_model',
  displayName: 'Get Model',
  description:
    'Get full detail for a single model: description, license, tags, category, exclusive-program status, publication status, and its list of print profiles. Works for any public model, not only your own. Use list_my_models or list_model_stats to find model IDs.',
  summary: 'Get full detail for one model',
  icon: 'box',
  group: 'Models',
  input: z.object({
    design_id: z.number().int().describe('Model ID'),
  }),
  output: z.object({ model: modelDetailSchema.describe('Full model detail') }),
  handle: async params => {
    const data = await api<RawModelDetail>('design-service', `/design/${params.design_id}`);
    return { model: mapModelDetail(data) };
  },
});
