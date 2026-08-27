import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  collectCustomFields,
  escapeQueryValue,
  INCIDENT_DETAIL_FIELDS,
  incidentDetailSchema,
  isSysId,
  mapIncidentDetail,
  type RawRecord,
  text,
  value,
} from './schemas.js';

/** A knowledge article attached to the incident, linked through the task-to-article join table. */
interface RawKnowledgeLink extends RawRecord {
  kb_knowledge?: { display_value?: string; value?: string };
}

export const getIncident = defineTool({
  name: 'get_incident',
  displayName: 'Get Incident',
  description:
    'Read one incident in full, addressed either by its number (e.g., INC0010023) or by its 32-character ' +
    'sys_id. Returns every detail field the summary views omit: the full description, caller, category and ' +
    'subcategory, impact and urgency, affected configuration item, who opened and resolved it, the resolution ' +
    'block (timestamps, code, notes), the linked problem and change records, and timing figures including ' +
    'duration and whether the agreement was met. Also returns the knowledge articles attached to the ' +
    'incident, and — unless include_custom_fields is false — every populated field the instance has added ' +
    'beyond the ServiceNow defaults, which is where deployment-specific detail such as site, asset, or ' +
    'contact information lives. Comments and work notes are not included; read them with ' +
    'list_incident_comments, and read the field-change and email history with list_incident_activity. Raises ' +
    'a not-found error when nothing matches, which is also what an access rule hiding the record looks like.',
  summary: 'Read one incident in full by number or sys_id',
  icon: 'file-text',
  group: 'Incidents',
  input: z.object({
    incident: z
      .string()
      .min(1)
      .describe('Incident number (e.g., INC0010023) or the 32-character sys_id of the incident'),
    include_custom_fields: z
      .boolean()
      .optional()
      .describe(
        'Return the populated fields this instance has added beyond the ServiceNow defaults, as a field-name ' +
          'to display-value map (default true). Set false for a smaller, strictly typed response.',
      ),
  }),
  output: z.object({
    incident: incidentDetailSchema.describe('The matched incident, with every detail field resolved'),
    attached_knowledge: z
      .array(
        z.object({
          number: z.string().describe('Article number (e.g., KB0010023)'),
          sys_id: z.string().describe('sys_id of the article, to pass to get_knowledge_article'),
        }),
      )
      .describe('Knowledge articles attached to the incident, empty when none are linked'),
    custom_fields: z
      .record(z.string(), z.string())
      .describe(
        'Populated fields outside the standard schema, keyed by field name and holding the display value. ' +
          'Instance-specific columns are conventionally prefixed "u_". Empty when include_custom_fields is false.',
      ),
  }),
  handle: async params => {
    const identifier = params.incident.trim();
    const query = isSysId(identifier) ? `sys_id=${identifier}` : `number=${escapeQueryValue(identifier)}`;
    const wantsCustomFields = params.include_custom_fields ?? true;

    // Omitting the field list returns every column, which is the only way to see what this
    // instance has added on top of the ServiceNow defaults.
    const page = await tableQuery<RawRecord>('incident', {
      query,
      fields: wantsCustomFields ? undefined : INCIDENT_DETAIL_FIELDS,
      limit: 1,
    });

    const record = page.records[0];
    if (!record) {
      throw ToolError.notFound(
        `No incident matches "${identifier}" — check the number, or the record may be restricted.`,
      );
    }

    // Attached articles are held in a join table rather than on the incident itself.
    const links = await tableQuery<RawKnowledgeLink>('m2m_kb_task', {
      query: `task=${value(record.sys_id)}`,
      fields: 'kb_knowledge',
      limit: 20,
    });

    return {
      incident: mapIncidentDetail(record),
      attached_knowledge: links.records
        .map(link => ({ number: text(link.kb_knowledge), sys_id: value(link.kb_knowledge) }))
        .filter(article => article.sys_id !== ''),
      custom_fields: wantsCustomFields ? collectCustomFields(record) : {},
    };
  },
});
