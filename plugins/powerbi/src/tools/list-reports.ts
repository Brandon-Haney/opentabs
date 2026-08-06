import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawReport, mapReport, reportSchema } from './schemas.js';

export const listReports = defineTool({
  name: 'list_reports',
  displayName: 'List Reports',
  description:
    'List every Power BI report the signed-in user can reach, with the semantic model behind each one. ' +
    'This is the main discovery tool and the most reliable way to find a dataset_id: it returns both dataset_id and dataset_workspace_id for each report, which the workspace-scoped endpoints do not surface to users who reach content through a published app. ' +
    'Filter by name with "search", by app with "app_id", or by model with "dataset_id". ' +
    'Note that a report distributed through an app has a different ID here than its app-scoped ID, and only the ID returned by this tool works with list_report_pages.',
  summary: 'List reachable reports and their semantic models',
  icon: 'chart-column',
  group: 'Reports',
  input: z.object({
    search: z.string().optional().describe('Case-insensitive substring filter on the report name'),
    app_id: z.string().optional().describe('Return only reports distributed by this app'),
    dataset_id: z.string().optional().describe('Return only reports built on this semantic model'),
  }),
  output: z.object({
    reports: z.array(reportSchema).describe('Matching reports'),
    total_count: z.number().int().describe('Total reports reachable before filtering'),
  }),
  handle: async params => {
    const data = await api<PowerBiListResponse<RawReport>>('/reports');
    const all = (data.value ?? []).map(mapReport);
    const search = (params.search ?? '').toLowerCase();

    return {
      reports: all.filter(
        report =>
          (search === '' || report.name.toLowerCase().includes(search)) &&
          (params.app_id === undefined || report.app_id === params.app_id) &&
          (params.dataset_id === undefined || report.dataset_id === params.dataset_id),
      ),
      total_count: all.length,
    };
  },
});
