import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawReportPage, mapReportPage, reportPageSchema } from './schemas.js';

export const listReportPages = defineTool({
  name: 'list_report_pages',
  displayName: 'List Report Pages',
  description:
    'List the pages (the tabs along the bottom of a report) in a Power BI report, in display order. ' +
    'Pass a report ID from list_reports. An app-scoped report ID — the GUID in an app URL such as /apps/<appId>/reports/<reportId> — is a different identifier and is rejected here; use list_reports to get the ID that works.',
  summary: 'List the pages in a report',
  icon: 'layout-dashboard',
  group: 'Reports',
  input: z.object({
    report_id: z.string().min(1).describe('Report ID, as returned by list_reports'),
  }),
  output: z.object({
    pages: z.array(reportPageSchema).describe('Report pages, ordered by their position in the report'),
  }),
  handle: async params => {
    const data = await api<PowerBiListResponse<RawReportPage>>(
      `/reports/${encodeURIComponent(params.report_id)}/pages`,
    );
    return {
      pages: (data.value ?? []).map(mapReportPage).sort((a, b) => a.order - b.order),
    };
  },
});
