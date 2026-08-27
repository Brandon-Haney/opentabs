import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  CI_FIELDS,
  configurationItemSchema,
  escapeQueryValue,
  isSysId,
  mapConfigurationItem,
  type RawRecord,
} from './schemas.js';

export const getConfigurationItem = defineTool({
  name: 'get_configuration_item',
  displayName: 'Get Configuration Item',
  description:
    'Fetch one configuration item from the CMDB by sys_id or by its exact name, returning its class, operational ' +
    'status, category, serial number, assigned user, and support group. A 32-character hexadecimal value is treated ' +
    'as a sys_id; anything else is matched against the item name exactly, not as a substring — use ' +
    'search_configuration_items when only part of the name is known or when several items may match. Fails with a ' +
    'not-found error when no item matches or when access rules hide it from the signed-in user.',
  summary: 'Fetch one CMDB item by sys_id or exact name',
  icon: 'server-cog',
  group: 'Configuration Items',
  input: z.object({
    item: z.string().min(1).describe('sys_id of the configuration item, or its exact name (e.g., "app-server-01")'),
  }),
  output: z.object({
    item: configurationItemSchema.describe('The configuration item'),
  }),
  handle: async params => {
    const identifier = escapeQueryValue(params.item);
    const query = isSysId(identifier) ? `sys_id=${identifier}` : `name=${identifier}`;

    const page = await tableQuery<RawRecord>('cmdb_ci', { query, fields: CI_FIELDS, limit: 1 });
    const record = page.records[0];
    if (!record) throw ToolError.notFound(`No configuration item found for "${params.item}".`);

    return { item: mapConfigurationItem(record) };
  },
});
