import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawDashboard, dashboardSchema, mapDashboard } from './schemas.js';

export const listDashboards = defineTool({
  name: 'list_dashboards',
  displayName: 'List Dashboards',
  description:
    'List the Power BI dashboards the signed-in user can reach. Dashboards are pinned-tile canvases and are a different object from reports — an organisation that publishes only reports will get an empty list here, which is not an error. Use list_reports for reports.',
  summary: 'List reachable dashboards',
  icon: 'gauge',
  group: 'Dashboards',
  input: z.object({}),
  output: z.object({
    dashboards: z.array(dashboardSchema).describe('Reachable dashboards, possibly empty'),
  }),
  handle: async () => {
    const data = await api<PowerBiListResponse<RawDashboard>>('/dashboards');
    return { dashboards: (data.value ?? []).map(mapDashboard) };
  },
});
