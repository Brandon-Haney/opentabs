import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { type PowerBiListResponse, api } from '../powerbi-api.js';
import { type RawDataset, type RawReport, datasetSchema, mapReport } from './schemas.js';

/**
 * Semantic models are gathered from two places and merged.
 *
 * `GET /datasets` lists only the caller's own workspace, and `GET
 * /groups/{id}/datasets` needs workspace membership — so for anyone who reaches
 * content through a published app, both come back empty or 401. Every reachable
 * report, however, names its model and that model's workspace, which makes the
 * report list the dependable source. Models found that way are marked
 * `source: "report"`.
 */
/**
 * Match a model name against the caller's search text, in either direction.
 *
 * Plain containment is not enough because the name here is often a report's
 * name rather than the model's own, and the two are decorated differently: a
 * model this tool reports as "POS Company Owned Store Sales Analysis" is listed
 * by Excel's Power BI pane as "SM_POS Company Owned Store Sales Analysis". A
 * caller passing the label a user copied from that pane would otherwise get an
 * empty result and conclude the model does not exist.
 *
 * Matching the reverse direction — the name contained in the search — handles
 * that without encoding anyone's naming convention, and cannot loosen a short
 * query, since a search shorter than a name can never contain it.
 */
const matchesName = (name: string, search: string): boolean => {
  if (search === '') return true;
  const candidate = name.toLowerCase();
  return candidate.includes(search) || (candidate !== '' && search.includes(candidate));
};

export const listDatasets = defineTool({
  name: 'list_datasets',
  displayName: 'List Datasets',
  description:
    'List the Power BI semantic models the signed-in user can reach, with the IDs execute_dax and describe_dataset take. ' +
    'Models are collected from the caller\'s own workspace and, additionally, from every reachable report — the report route is what surfaces models shared through an app, which the workspace endpoints do not return. The "source" field says which route found each model. ' +
    'A model found through a report carries the REPORT\'s name, which is not always the model\'s own: Excel\'s Power BI pane may show the same model differently (an "SM_" prefix, say). "search" therefore matches in either direction, so a label copied from that pane still finds it. ' +
    'A model listed here is not guaranteed to be queryable: running DAX against it additionally requires Build permission.',
  summary: 'List reachable semantic models',
  icon: 'database',
  group: 'Datasets',
  input: z.object({
    search: z.string().optional().describe('Case-insensitive substring filter on the model name'),
  }),
  output: z.object({
    datasets: z.array(datasetSchema).describe('Reachable semantic models, de-duplicated by ID'),
    total_count: z.number().int().describe('Total distinct models found before filtering'),
  }),
  handle: async params => {
    const [own, reports] = await Promise.all([
      api<PowerBiListResponse<RawDataset>>('/datasets').catch(() => ({ value: [] as RawDataset[] })),
      api<PowerBiListResponse<RawReport>>('/reports').catch(() => ({ value: [] as RawReport[] })),
    ]);

    const byId = new Map<string, z.infer<typeof datasetSchema>>();

    for (const dataset of own.value ?? []) {
      if (!dataset.id) continue;
      byId.set(dataset.id, {
        id: dataset.id,
        name: dataset.name ?? '',
        workspace_id: '',
        configured_by: dataset.configuredBy ?? '',
        is_refreshable: dataset.isRefreshable ?? false,
        web_url: dataset.webUrl ?? '',
        source: 'workspace',
      });
    }

    // A report names its model but not the model's own name, so the report name
    // is the best available label. Models already found directly keep their real
    // name rather than being overwritten.
    for (const report of (reports.value ?? []).map(mapReport)) {
      if (!report.dataset_id || byId.has(report.dataset_id)) continue;
      byId.set(report.dataset_id, {
        id: report.dataset_id,
        name: report.name,
        workspace_id: report.dataset_workspace_id,
        configured_by: '',
        is_refreshable: false,
        web_url: '',
        source: 'report',
      });
    }

    const all = [...byId.values()];
    const search = (params.search ?? '').toLowerCase();
    return {
      datasets: all.filter(dataset => matchesName(dataset.name, search)),
      total_count: all.length,
    };
  },
});
