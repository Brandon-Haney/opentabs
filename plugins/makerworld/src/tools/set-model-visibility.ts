import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { apiVoid } from '../makerworld-api.js';

export const setModelVisibility = defineTool({
  name: 'set_model_visibility',
  displayName: 'Set Model Visibility',
  description:
    'Take one of your published models offline, hiding it from the site, or bring an offline model back online. Taking a model offline stops it earning points. This is reversible — call it again with the opposite visibility to restore the previous state. Confirm with get_model afterwards.',
  summary: 'Take a model offline or bring it back online',
  icon: 'eye-off',
  group: 'Models',
  input: z.object({
    design_id: z.number().int().describe('Model ID to change'),
    visibility: z.enum(['online', 'offline']).describe('"online" publishes the model, "offline" hides it'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the visibility change succeeded'),
  }),
  handle: async params => {
    await apiVoid('design-service', `/design/${params.design_id}/${params.visibility}`, { method: 'PUT' });
    return { success: true };
  },
});
