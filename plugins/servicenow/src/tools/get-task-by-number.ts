import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, mapTask, type RawRecord, TASK_FIELDS, taskShape, text, value } from './schemas.js';

export const getTaskByNumber = defineTool({
  name: 'get_task_by_number',
  displayName: 'Get Task by Number',
  description:
    'Resolve any ServiceNow record number to its record without knowing in advance which table it lives in. ' +
    'The lookup runs against the generic "task" parent table, so one call covers incidents (INC0010023), ' +
    'changes (CHG0010023), problems (PRB0010023), requested items (RITM0010023), requests (REQ0010023), ' +
    'catalog tasks (SCTASK0010023), change tasks (CTASK0010023) and every other task-derived table. Returns ' +
    'the shared task fields — state, priority, assignment, timestamps — plus the table the record actually ' +
    'lives in, which can then be passed to the matching get_ tool to read the table-specific detail. Matches ' +
    'one exact number rather than searching text, and only covers the task hierarchy: knowledge articles and ' +
    'other non-task records are not found here.',
  summary: 'Resolve any task number to its record and table',
  icon: 'search-code',
  group: 'Tasks',
  input: z.object({
    number: z
      .string()
      .min(1)
      .describe('Exact record number to resolve, e.g., INC0010023, CHG0010023, RITM0010023 or SCTASK0010023'),
  }),
  output: z.object({
    task: z
      .object({
        ...taskShape,
        table: z
          .string()
          .describe(
            'Table the record lives in (e.g., incident) — pass it to the matching get_ tool for the full record',
          ),
        table_label: z.string().describe('Human-readable label of that table (e.g., Incident)'),
      })
      .describe('The resolved record, with the table it belongs to'),
  }),
  handle: async params => {
    const number = escapeQueryValue(params.number);
    const page = await tableQuery<RawRecord>('task', {
      query: `number=${number}`,
      fields: `${TASK_FIELDS},sys_class_name`,
      limit: 1,
    });

    const record = page.records[0];
    if (!record) {
      throw ToolError.notFound(`No task found with number ${params.number} — check the number and try again.`);
    }

    return {
      task: {
        ...mapTask(record),
        table: value(record.sys_class_name),
        table_label: text(record.sys_class_name),
      },
    };
  },
});
