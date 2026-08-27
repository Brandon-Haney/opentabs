import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { statsQuery } from '../servicenow-api.js';
import { andQuery, buildScopeQuery, num, scopeSchema, totalSchema } from './schemas.js';

export const summarizeIncidents = defineTool({
  name: 'summarize_incidents',
  displayName: 'Summarize Incidents',
  description:
    'Count incidents grouped by a single field and return one bucket per distinct value, largest first. This asks ' +
    'the instance to aggregate, so it answers questions like "how many open incidents does each group have" or ' +
    '"what is the priority mix" in one call, without paging through records — always prefer it over search_incidents ' +
    'when the answer is a count rather than a list. Counts are scoped to the groups the signed-in user belongs to ' +
    'unless "scope" says otherwise, and cover only open incidents unless "active_only" is false. Bucket labels are ' +
    'the values shown in the ServiceNow UI (e.g., "In Progress"), so pass a label back to search_incidents only ' +
    'through a filter that accepts one.',
  summary: 'Count incidents grouped by state, priority, group, or assignee',
  icon: 'chart-bar',
  group: 'Incidents',
  input: z.object({
    group_by: z
      .enum(['state', 'priority', 'assignment_group', 'category', 'assigned_to'])
      .optional()
      .describe('Field to group the counts by (default "state")'),
    scope: scopeSchema,
    active_only: z
      .boolean()
      .optional()
      .describe('Count only incidents that are still open (default true). Set false to include resolved and closed.'),
  }),
  output: z.object({
    buckets: z
      .array(
        z.object({
          label: z
            .string()
            .describe('Value of the grouped field as shown in the UI, empty when the field is unset on those records'),
          count: z.number().int().describe('Number of incidents in this bucket'),
        }),
      )
      .describe('One bucket per distinct value of the grouped field, ordered by count descending'),
    total: totalSchema,
  }),
  handle: async params => {
    const groupBy = params.group_by ?? 'state';
    const activeOnly = params.active_only ?? true;

    const query = andQuery(await buildScopeQuery(params.scope), activeOnly ? 'active=true' : undefined);
    const rows = await statsQuery('incident', query, groupBy);

    const buckets = rows
      .map(row => ({
        label: (row.groupby_fields?.find(field => field.field === groupBy) ?? row.groupby_fields?.[0])?.value ?? '',
        count: num(row.stats?.count),
      }))
      .sort((left, right) => right.count - left.count);

    return { buckets, total: buckets.reduce((sum, bucket) => sum + bucket.count, 0) };
  },
});
