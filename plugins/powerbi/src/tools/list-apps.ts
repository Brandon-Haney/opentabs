import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawApp, appSchema, mapApp } from './schemas.js';

export const listApps = defineTool({
  name: 'list_apps',
  displayName: 'List Apps',
  description:
    'List the Power BI apps installed for the signed-in user. Apps are how most read-only consumers receive reports. ' +
    'An app ID is not a workspace ID: the GUID after /apps/ in a Power BI URL identifies the app, while queries and workspace-scoped endpoints need the workspace ID, which this tool reports separately as workspace_id. ' +
    'Use list_reports with app_id to see the reports an app distributes.',
  summary: 'List installed Power BI apps',
  icon: 'layout-grid',
  group: 'Apps',
  input: z.object({}),
  output: z.object({
    apps: z.array(appSchema).describe('Installed apps'),
  }),
  handle: async () => {
    const data = await api<PowerBiListResponse<RawApp>>('/apps');
    return { apps: (data.value ?? []).map(mapApp) };
  },
});
