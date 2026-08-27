import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  andQuery,
  escapeQueryValue,
  isSysId,
  mapSla,
  type RawRecord,
  SLA_FIELDS,
  slaSchema,
  totalSchema,
  value,
} from './schemas.js';

const SLA_LIMIT = 50;

export const listTaskSlas = defineTool({
  name: 'list_task_slas',
  displayName: 'List Task SLAs',
  description:
    'List the service level agreements tracked against one task record — an incident, change, problem, request ' +
    'item, or any other task-derived record. Accepts a task number of any type (e.g., INC0010023, CHG0010023, ' +
    'RITM0010023) or a task sys_id; a number is resolved against the generic task table, and the tool fails when ' +
    'nothing matches. Each entry reports the agreement name, tracking stage, whether it has been breached, the ' +
    'percentage of the allotted business time consumed, and the business time left. Returns the 50 most recently ' +
    'started agreements, newest first, together with a count of the breached ones.',
  summary: 'SLA tracking for a task, with a breach count',
  icon: 'timer',
  group: 'Tasks',
  input: z.object({
    task: z
      .string()
      .min(1)
      .describe(
        'Task number of any type (e.g., INC0010023, CHG0010023, RITM0010023) or the task sys_id — a number is ' +
          'resolved against the generic task table',
      ),
    active_only: z
      .boolean()
      .optional()
      .describe('Return only agreements still being tracked (default false, which also includes finished ones)'),
  }),
  output: z.object({
    slas: z.array(slaSchema).describe('Agreements tracked against the task, most recently started first'),
    total: totalSchema,
    breached: z.number().int().describe('How many of the returned agreements have been breached'),
  }),
  handle: async params => {
    const activeOnly = params.active_only ?? false;
    const task = params.task.trim();

    let sysId = task;
    if (!isSysId(task)) {
      const match = await tableQuery<RawRecord>('task', {
        query: `number=${escapeQueryValue(task)}`,
        fields: 'sys_id',
        limit: 1,
      });

      sysId = value(match.records[0]?.sys_id);
      if (!sysId) throw ToolError.notFound(`No task found with number ${task}.`);
    }

    const page = await tableQuery<RawRecord>('task_sla', {
      query: andQuery(`task=${sysId}`, activeOnly ? 'active=true' : undefined, 'ORDERBYDESCsys_created_on'),
      fields: SLA_FIELDS,
      limit: SLA_LIMIT,
    });

    const slas = page.records.map(mapSla);
    return { slas, total: page.total, breached: slas.filter(sla => sla.has_breached).length };
  },
});
