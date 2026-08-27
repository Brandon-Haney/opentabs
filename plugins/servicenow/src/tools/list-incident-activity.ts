import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import { escapeQueryValue, isSysId, type RawRecord, text, value } from './schemas.js';

const DEFAULT_ACTIVITY_LIMIT = 50;

/**
 * Field changes are read from the history table rather than the audit table.
 *
 * Both record the same edits, but access rules commonly withhold the audit table from users who
 * can read the record it describes — it answers 200 with an empty result and a non-zero count.
 */
const HISTORY_TABLE = 'sys_history_line';

/** Housekeeping columns the form does not show, recorded on nearly every update. */
const NOISE_FIELDS = new Set(['email', 'sys_mod_count', 'sys_updated_on', 'sys_updated_by']);

export const listIncidentActivity = defineTool({
  name: 'list_incident_activity',
  displayName: 'List Incident Activity',
  description:
    'Read the audit trail of an incident: every field change with its old and new value, and every ' +
    'notification email the instance sent about the record, merged into one timeline, newest first. This is ' +
    'the history behind the activity stream on the ServiceNow form — it answers when a ticket changed state, ' +
    'who reassigned it, when the resolution code was set, and who was emailed. Comments and work notes are ' +
    'not repeated here; read those with list_incident_comments. Accepts an incident number (e.g., ' +
    'INC0010023) or a sys_id. Housekeeping columns that change on every update are filtered out unless ' +
    'include_system_fields is set.',
  summary: 'Read the field-change and email history of an incident',
  icon: 'history',
  group: 'Incidents',
  input: z.object({
    incident: z
      .string()
      .min(1)
      .describe('Incident number (e.g., INC0010023) or the 32-character sys_id of the incident'),
    include_emails: z
      .boolean()
      .optional()
      .describe('Include the notification emails the instance sent about this incident (default true)'),
    include_system_fields: z
      .boolean()
      .optional()
      .describe(
        'Include housekeeping columns that change on every update, such as the modification counter ' +
          '(default false)',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum entries to return across both sources (default 50, max 200)'),
  }),
  output: z.object({
    number: z.string().describe('Incident number the activity belongs to'),
    entries: z
      .array(
        z.object({
          kind: z.string().describe('Entry type: "field_change" for an edit, "email" for a notification sent'),
          occurred_at: z.string().describe("Timestamp of the entry, in the signed-in user's timezone"),
          actor: z.string().describe('Person or account responsible, empty when the instance acted on its own'),
          field: z.string().describe('Label of the changed field, empty for an email entry'),
          old_value: z.string().describe('Value before the change, empty when the field was previously unset'),
          new_value: z.string().describe('Value after the change, empty for an email entry'),
          summary: z.string().describe('Subject line for an email entry, empty for a field change'),
        }),
      )
      .describe('Field changes and emails merged into one timeline, newest first'),
    total: z.number().int().describe('Number of entries returned'),
  }),
  handle: async params => {
    const identifier = params.incident.trim();
    const query = isSysId(identifier) ? `sys_id=${identifier}` : `number=${escapeQueryValue(identifier)}`;

    const incidents = await tableQuery<RawRecord>('incident', { query, fields: 'number,sys_id', limit: 1 });
    const incident = incidents.records[0];
    if (!incident) {
      throw ToolError.notFound(
        `No incident matches "${identifier}" — check the number, or the record may be restricted.`,
      );
    }

    const sysId = value(incident.sys_id);
    const limit = params.limit ?? DEFAULT_ACTIVITY_LIMIT;

    const changes = await tableQuery<RawRecord>(HISTORY_TABLE, {
      query: `set.id=${sysId}^field!=^ORDERBYDESCupdate_time`,
      fields: 'field,label,old,new,update_time,user_name',
      limit,
    });

    const entries = changes.records
      .filter(record => params.include_system_fields === true || !NOISE_FIELDS.has(value(record.field)))
      .map(record => ({
        kind: 'field_change',
        occurred_at: text(record.update_time),
        actor: text(record.user_name),
        field: text(record.label) || text(record.field),
        old_value: text(record.old),
        new_value: text(record.new),
        summary: '',
      }));

    if (params.include_emails !== false) {
      const emails = await tableQuery<RawRecord>('sys_email', {
        query: `instance=${sysId}^ORDERBYDESCsys_created_on`,
        fields: 'subject,type,recipients,sys_created_on',
        limit,
      });

      for (const record of emails.records) {
        entries.push({
          kind: 'email',
          occurred_at: text(record.sys_created_on),
          actor: text(record.recipients),
          field: '',
          old_value: '',
          new_value: '',
          summary: text(record.subject),
        });
      }
    }

    // Both sources use the same sortable timestamp format, so a plain descending string sort
    // interleaves them correctly.
    entries.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    const trimmed = entries.slice(0, limit);

    return { number: text(incident.number), entries: trimmed, total: trimmed.length };
  },
});
