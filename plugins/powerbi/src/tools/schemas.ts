import { z } from 'zod';

// --- Workspaces (groups) ---

export const workspaceSchema = z.object({
  id: z.string().describe('Workspace (group) ID'),
  name: z.string().describe('Workspace display name'),
  is_read_only: z.boolean().describe('Whether the caller has read-only access to the workspace'),
  is_on_dedicated_capacity: z.boolean().describe('Whether the workspace runs on dedicated (Premium/Fabric) capacity'),
});

export interface RawWorkspace {
  id?: string;
  name?: string;
  isReadOnly?: boolean;
  isOnDedicatedCapacity?: boolean;
}

export const mapWorkspace = (w: RawWorkspace) => ({
  id: w.id ?? '',
  name: w.name ?? '',
  is_read_only: w.isReadOnly ?? false,
  is_on_dedicated_capacity: w.isOnDedicatedCapacity ?? false,
});

// --- Apps ---

export const appSchema = z.object({
  id: z.string().describe('App ID. Note this is NOT a workspace ID — see workspace_id.'),
  name: z.string().describe('App display name'),
  description: z.string().describe('App description, empty when unset'),
  workspace_id: z.string().describe('ID of the workspace the app publishes from, empty when not exposed'),
  published_by: z.string().describe('Who published the app, empty when unset'),
  last_update: z.string().describe('ISO 8601 timestamp of the last app update, empty when unset'),
});

export interface RawApp {
  id?: string;
  name?: string;
  description?: string;
  workspaceId?: string;
  publishedBy?: string;
  lastUpdate?: string;
}

export const mapApp = (a: RawApp) => ({
  id: a.id ?? '',
  name: a.name ?? '',
  description: a.description ?? '',
  workspace_id: a.workspaceId ?? '',
  published_by: a.publishedBy ?? '',
  last_update: a.lastUpdate ?? '',
});

// --- Reports ---

export const reportSchema = z.object({
  id: z.string().describe('Report ID'),
  name: z.string().describe('Report display name'),
  report_type: z.string().describe('Report type (e.g., "PowerBIReport", "PaginatedReport")'),
  web_url: z.string().describe('URL that opens the report in the Power BI service'),
  dataset_id: z
    .string()
    .describe(
      'ID of the semantic model behind the report. This is the ID execute_dax takes, and it matches the dataset_id an Excel workbook connection reports.',
    ),
  dataset_workspace_id: z.string().describe('ID of the workspace owning the semantic model, empty when not exposed'),
  app_id: z.string().describe('ID of the app distributing this report, empty when the report is not from an app'),
  is_owned_by_me: z.boolean().describe('Whether the caller owns the report'),
});

export interface RawReport {
  id?: string;
  name?: string;
  reportType?: string;
  webUrl?: string;
  datasetId?: string;
  datasetWorkspaceId?: string;
  appId?: string;
  isOwnedByMe?: boolean;
}

export const mapReport = (r: RawReport) => ({
  id: r.id ?? '',
  name: r.name ?? '',
  report_type: r.reportType ?? '',
  web_url: r.webUrl ?? '',
  dataset_id: r.datasetId ?? '',
  dataset_workspace_id: r.datasetWorkspaceId ?? '',
  app_id: r.appId ?? '',
  is_owned_by_me: r.isOwnedByMe ?? false,
});

// --- Report pages ---

export const reportPageSchema = z.object({
  name: z.string().describe('Internal page name, used to address the page (e.g., "ReportSection1a2b3c")'),
  display_name: z.string().describe('Page name as shown in the report tab strip'),
  order: z.number().int().describe('Zero-based position of the page within the report'),
});

export interface RawReportPage {
  name?: string;
  displayName?: string;
  order?: number;
}

export const mapReportPage = (p: RawReportPage) => ({
  name: p.name ?? '',
  display_name: p.displayName ?? '',
  order: p.order ?? 0,
});

// --- Dashboards ---

export const dashboardSchema = z.object({
  id: z.string().describe('Dashboard ID'),
  display_name: z.string().describe('Dashboard display name'),
  web_url: z.string().describe('URL that opens the dashboard in the Power BI service'),
  is_read_only: z.boolean().describe('Whether the dashboard is read-only for the caller'),
});

export interface RawDashboard {
  id?: string;
  displayName?: string;
  webUrl?: string;
  isReadOnly?: boolean;
}

export const mapDashboard = (d: RawDashboard) => ({
  id: d.id ?? '',
  display_name: d.displayName ?? '',
  web_url: d.webUrl ?? '',
  is_read_only: d.isReadOnly ?? false,
});

// --- Datasets (semantic models) ---

export const datasetSchema = z.object({
  id: z.string().describe('Semantic model (dataset) ID — the ID execute_dax takes'),
  name: z.string().describe('Semantic model display name'),
  workspace_id: z.string().describe('ID of the workspace owning the model, empty when not exposed'),
  configured_by: z.string().describe('Account that configured the model, empty when unset'),
  is_refreshable: z.boolean().describe('Whether the model supports refresh'),
  web_url: z.string().describe('URL that opens the model in the Power BI service, empty when unset'),
  source: z
    .string()
    .describe(
      'How this model was discovered: "workspace" when listed directly, or "report" when derived from a report the caller can see.',
    ),
});

export interface RawDataset {
  id?: string;
  name?: string;
  configuredBy?: string;
  isRefreshable?: boolean;
  webUrl?: string;
}

// --- DAX query results ---

/**
 * A DAX result cell. `executeQueries` returns JSON scalars only — DAX has no
 * nested or array-valued columns — so this union is exhaustive rather than a
 * convenience.
 */
export const daxValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .nullable()
  .describe('A single cell value. Null when the model returned a blank.');

export const daxRowSchema = z
  .record(z.string(), daxValueSchema)
  .describe('One result row, keyed by column name. Column names arrive bracketed, e.g. "[Total Sales]".');
