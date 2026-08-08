import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawDataset, type RawReport, datasetSchema, mapReport } from './schemas.js';

/**
 * Look up one semantic model by ID.
 *
 * Two routes, for the same reason `list_datasets` merges two: the direct
 * endpoint only answers for a model in the caller's own workspace, so anyone
 * reaching content through a published app gets nothing from it. Every
 * reachable report names its model and that model's workspace, which covers the
 * app case — at the cost of the report's name standing in for the model's,
 * since a report does not carry it.
 */
export const getDataset = defineTool({
  name: 'get_dataset',
  displayName: 'Get Dataset',
  description:
    'Look up one Power BI semantic model by ID, including the workspace that owns it. ' +
    'Use it to confirm a model ID resolves before running DAX against it — in particular an ID taken from an Excel workbook connection, which inspect_data_model reports as dataset_id. ' +
    "Resolves through the caller's own workspace first and falls back to the reachable report list, which is what finds a model shared through an app. The \"source\" field says which route matched, and a model found via a report carries the report's name because a report does not carry the model's. " +
    'Resolving here does not guarantee the model is queryable: execute_dax additionally needs Build permission on it.',
  summary: 'Look up one semantic model by ID',
  icon: 'database',
  group: 'Datasets',
  input: z.object({
    dataset_id: z
      .string()
      .describe('Semantic model ID (a GUID), as reported by list_datasets, list_reports, or inspect_data_model'),
  }),
  output: z.object({
    dataset: datasetSchema.describe('The resolved semantic model'),
  }),
  handle: async params => {
    const direct = await api<RawDataset>(`/datasets/${encodeURIComponent(params.dataset_id)}`).catch(() => null);
    if (direct?.id) {
      return {
        dataset: {
          id: direct.id,
          name: direct.name ?? '',
          workspace_id: '',
          configured_by: direct.configuredBy ?? '',
          is_refreshable: direct.isRefreshable ?? false,
          web_url: direct.webUrl ?? '',
          source: 'workspace',
        },
      };
    }

    const reports = await api<PowerBiListResponse<RawReport>>('/reports').catch(() => ({ value: [] as RawReport[] }));
    const match = (reports.value ?? []).map(mapReport).find(report => report.dataset_id === params.dataset_id);
    if (!match) {
      throw ToolError.notFound(
        `No semantic model with ID "${params.dataset_id}" is reachable. It is not in your own workspace, and no report you can see uses it. ` +
          'Call list_datasets to see what is reachable — a model you can open in the Power BI service is not necessarily one this API exposes to you.',
      );
    }

    return {
      dataset: {
        id: match.dataset_id,
        name: match.name,
        workspace_id: match.dataset_workspace_id,
        configured_by: '',
        is_refreshable: false,
        web_url: '',
        source: 'report',
      },
    };
  },
});
