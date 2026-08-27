import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  CI_FIELDS,
  configurationItemSchema,
  DEFAULT_LIMIT,
  equalsFragment,
  escapeQueryValue,
  limitSchema,
  mapConfigurationItem,
  offsetSchema,
  type RawRecord,
  totalSchema,
} from './schemas.js';

/** Matches the search term against the two fields a person identifies hardware by. */
const nameOrSerialQuery = (term: string | undefined): string | undefined => {
  const cleaned = term ? escapeQueryValue(term) : '';
  if (!cleaned) return undefined;
  return `nameLIKE${cleaned}^ORserial_numberLIKE${cleaned}`;
};

export const searchConfigurationItems = defineTool({
  name: 'search_configuration_items',
  displayName: 'Search Configuration Items',
  description:
    'Search the CMDB for configuration items — servers, applications, databases, network gear, and every other ' +
    'tracked asset — returning name, class, operational status, category, serial number, assigned user, and ' +
    'support group for each match. The free-text term matches the item name or serial number as a case-insensitive ' +
    'substring; ci_class, operational_status, and assigned_to narrow further and can be used on their own. Results ' +
    'are ordered by name and capped at 100 per call (default 20), so a call with no filters returns only the first ' +
    'page of an instance that holds millions of items — always pass at least one filter for a targeted lookup, and ' +
    'use the returned total to judge whether the query needs narrowing. Use get_configuration_item once a specific ' +
    'item is identified.',
  summary: 'Search the CMDB by name, serial number, class, or owner',
  icon: 'server',
  group: 'Configuration Items',
  input: z.object({
    query: z
      .string()
      .optional()
      .describe('Free text matched as a substring against the item name or its serial number'),
    ci_class: z
      .string()
      .optional()
      .describe(
        'Restrict to one CMDB class by its table name (e.g., "cmdb_ci_server", "cmdb_ci_appl", "cmdb_ci_db_instance")',
      ),
    operational_status: z
      .string()
      .optional()
      .describe('Restrict to one operational status by its stored value (e.g., "1" for Operational)'),
    assigned_to: z.string().optional().describe('sys_id of the user the item is assigned to'),
    limit: limitSchema,
    offset: offsetSchema,
  }),
  output: z.object({
    items: z.array(configurationItemSchema).describe('Matching configuration items, ordered by name'),
    total: totalSchema,
  }),
  handle: async params => {
    const query = andQuery(
      nameOrSerialQuery(params.query),
      equalsFragment('sys_class_name', params.ci_class),
      equalsFragment('operational_status', params.operational_status),
      equalsFragment('assigned_to', params.assigned_to),
      'ORDERBYname',
    );

    const page = await tableQuery<RawRecord>('cmdb_ci', {
      query,
      fields: CI_FIELDS,
      limit: params.limit ?? DEFAULT_LIMIT,
      offset: params.offset,
    });

    return { items: page.records.map(mapConfigurationItem), total: page.total };
  },
});
