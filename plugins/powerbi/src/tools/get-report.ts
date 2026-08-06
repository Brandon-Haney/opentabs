import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../powerbi-api.js';
import { type RawReport, mapReport, reportSchema } from './schemas.js';

export const getReport = defineTool({
  name: 'get_report',
  displayName: 'Get Report',
  description:
    'Get a single Power BI report by ID, including the ID of the semantic model behind it. ' +
    'Pass a report ID from list_reports. An app-scoped report ID (the GUID after /reports/ in an app URL) is a different identifier and will not resolve here. ' +
    'This endpoint does not return dataset_workspace_id, so that field comes back empty — use list_reports when you need the owning workspace.',
  summary: 'Get one report by ID',
  icon: 'chart-column',
  group: 'Reports',
  input: z.object({
    report_id: z.string().min(1).describe('Report ID, as returned by list_reports'),
  }),
  output: z.object({
    report: reportSchema.describe('The report'),
  }),
  handle: async params => {
    const data = await api<RawReport>(`/reports/${encodeURIComponent(params.report_id)}`);
    return { report: mapReport(data) };
  },
});
