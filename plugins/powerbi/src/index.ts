import { OpenTabsPlugin } from '@opentabs-dev/plugin-sdk';
import type { ToolDefinition } from '@opentabs-dev/plugin-sdk';
import { isAuthenticated, waitForAuth } from './powerbi-api.js';
import { describeDataset } from './tools/describe-dataset.js';
import { executeDax } from './tools/execute-dax.js';
import { getReport } from './tools/get-report.js';
import { listApps } from './tools/list-apps.js';
import { listDashboards } from './tools/list-dashboards.js';
import { listDatasets } from './tools/list-datasets.js';
import { listReportPages } from './tools/list-report-pages.js';
import { listReports } from './tools/list-reports.js';
import { listWorkspaces } from './tools/list-workspaces.js';

class PowerBiPlugin extends OpenTabsPlugin {
  readonly name = 'powerbi';
  readonly description = 'OpenTabs plugin for Microsoft Power BI';
  override readonly displayName = 'Power BI';
  readonly urlPatterns = ['*://app.powerbi.com/*'];
  override readonly homepage = 'https://app.powerbi.com/';
  readonly tools: ToolDefinition[] = [
    // Discovery
    listWorkspaces,
    listApps,
    listReports,
    getReport,
    listReportPages,
    listDashboards,
    // Semantic models
    listDatasets,
    describeDataset,
    executeDax,
  ];

  async isReady(): Promise<boolean> {
    if (isAuthenticated()) return true;
    return waitForAuth();
  }
}

export default new PowerBiPlugin();
