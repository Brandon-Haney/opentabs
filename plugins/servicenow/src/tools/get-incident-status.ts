import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, isSysId, mapTask, type RawRecord, TASK_FIELDS, taskShape, text } from './schemas.js';

const STATUS_FIELDS = `${TASK_FIELDS},resolved_at,closed_at`;

export const getIncidentStatus = defineTool({
  name: 'get_incident_status',
  displayName: 'Get Incident Status',
  description:
    'Answer "where does this ticket stand" for up to 50 incidents at once. Accepts any mix of incident numbers ' +
    '(e.g., INC0010023) and 32-character sys_ids, and resolves all of them with a single query, which makes this ' +
    'the cheapest way to check status — far cheaper than one get_incident call per ticket. Returns only the ' +
    'status fields: state, priority, active flag, assignee, assignment group, and the last-updated, resolved, and ' +
    'closed timestamps. Descriptions, journals, and resolution notes are not included; use get_incident for the ' +
    'full record. The lookup is not scoped to the signed-in user, so any readable incident resolves. Identifiers ' +
    'that match no readable record come back in not_found rather than raising an error.',
  summary: 'Check the state of up to 50 incidents in one call',
  icon: 'activity',
  group: 'Incidents',
  input: z.object({
    incidents: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe('Incident numbers (e.g., INC0010023) and/or 32-character sys_ids, in any mix, up to 50 per call'),
  }),
  output: z.object({
    statuses: z
      .array(
        z.object({
          ...taskShape,
          resolved_at: z.string().describe('Resolution timestamp, empty when unresolved'),
          closed_at: z.string().describe('Close timestamp, empty when not closed'),
        }),
      )
      .describe('One entry per identifier that resolved, in the order ServiceNow returned them'),
    not_found: z
      .array(z.string())
      .describe('Requested identifiers that matched no readable incident, echoed back exactly as they were passed'),
  }),
  handle: async params => {
    const identifiers = params.incidents.map(escapeQueryValue).filter(identifier => identifier.length > 0);
    if (identifiers.length === 0) return { statuses: [], not_found: params.incidents };

    const sysIds = identifiers.filter(identifier => isSysId(identifier));
    const numbers = identifiers.filter(identifier => !isSysId(identifier));

    const conditions: string[] = [];
    if (numbers.length > 0) conditions.push(`numberIN${numbers.join(',')}`);
    if (sysIds.length > 0) conditions.push(`sys_idIN${sysIds.join(',')}`);

    const page = await tableQuery<RawRecord>('incident', {
      query: conditions.join('^OR'),
      fields: STATUS_FIELDS,
      limit: params.incidents.length,
    });

    const statuses = page.records.map(record => ({
      ...mapTask(record),
      resolved_at: text(record.resolved_at),
      closed_at: text(record.closed_at),
    }));

    const resolved = new Set(
      statuses
        .flatMap(status => [status.number, status.sys_id])
        .filter(id => id.length > 0)
        .map(id => id.toLowerCase()),
    );

    return {
      statuses,
      not_found: params.incidents.filter(input => !resolved.has(escapeQueryValue(input).toLowerCase())),
    };
  },
});
