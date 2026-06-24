import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchCustomFields } from './custom-fields.js';

export const listCustomFields = defineTool({
  name: 'list_custom_fields',
  displayName: 'List Custom Fields',
  description:
    'List the custom fields available on a task, project, or folder — their names, types, dropdown options, and current values. Use this to discover field names and valid values before calling set_custom_field. Read-only.',
  summary: "List an item's custom fields and values",
  icon: 'list',
  group: 'Tasks',
  input: z.object({
    item_id: z.string().describe('The task, project, or folder id'),
  }),
  output: z.object({
    custom_fields: z
      .array(
        z.object({
          id: z.string().describe('Custom field id'),
          name: z.string().describe('Field name'),
          type: z.string().describe('Field type: text, single_select, multi_select, date, or number'),
          options: z.array(z.string()).describe('Allowed values for select fields, otherwise empty'),
          value: z.string().describe('Current value as text, or empty if unset'),
        }),
      )
      .describe('Custom fields applicable to this item'),
  }),
  handle: async params => {
    const custom_fields = await fetchCustomFields(Number(params.item_id));
    return { custom_fields };
  },
});
