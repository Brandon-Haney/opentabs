import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { tableQuery } from '../servicenow-api.js';
import {
  ATTACHMENT_FIELDS,
  attachmentSchema,
  DEFAULT_LIMIT,
  escapeQueryValue,
  isSysId,
  limitSchema,
  mapAttachment,
  type RawRecord,
  totalSchema,
  value,
} from './schemas.js';

export const listIncidentAttachments = defineTool({
  name: 'list_incident_attachments',
  displayName: 'List Incident Attachments',
  description:
    'List the files attached to one incident, newest upload first. Accepts either an incident number ' +
    '(e.g., INC0010023) or an incident sys_id — a number is resolved to its sys_id first, and the tool fails ' +
    'when no incident matches. Each attachment reports its file name, MIME type, size in bytes, upload ' +
    'timestamp, and an absolute download URL that only resolves for the signed-in browser session. Returns 20 ' +
    'attachments by default (max 100) along with the total attached to the record.',
  summary: 'Files attached to an incident, newest first',
  icon: 'paperclip',
  group: 'Incidents',
  input: z.object({
    incident: z
      .string()
      .min(1)
      .describe('Incident number (e.g., INC0010023) or the incident sys_id — a number is resolved to its sys_id'),
    limit: limitSchema,
  }),
  output: z.object({
    attachments: z.array(attachmentSchema).describe('Attachments on the incident, newest upload first'),
    total: totalSchema,
  }),
  handle: async params => {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const incident = params.incident.trim();

    let sysId = incident;
    if (!isSysId(incident)) {
      const match = await tableQuery<RawRecord>('incident', {
        query: `number=${escapeQueryValue(incident)}`,
        fields: 'sys_id',
        limit: 1,
      });

      sysId = value(match.records[0]?.sys_id);
      if (!sysId) throw ToolError.notFound(`No incident found with number ${incident}.`);
    }

    const page = await tableQuery<RawRecord>('sys_attachment', {
      query: `table_name=incident^table_sys_id=${sysId}^ORDERBYDESCsys_created_on`,
      fields: ATTACHMENT_FIELDS,
      limit,
    });

    return { attachments: page.records.map(mapAttachment), total: page.total };
  },
});
