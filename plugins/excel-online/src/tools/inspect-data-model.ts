import { ToolError, defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { isPeriodRelative } from '../period-relative.js';
import { readConnections, readPivotCaches, readPivotTables } from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';
import { availableHierarchySchema, availableMeasureSchema, connectionSchema, pivotTableSchema } from './schemas.js';

/** Case-insensitive substring match over the fields an agent would search by. */
const matchesFilter = (filter: string, ...fields: string[]): boolean =>
  filter === '' || fields.some(field => field.toLowerCase().includes(filter));

/**
 * True when `displayFolder` is `folder` or sits beneath it.
 *
 * Compared segment-wise on the model's backslash separator so that
 * "Time Series Measures" selects its subfolders without also selecting a
 * sibling that merely starts with the same letters.
 */
const inFolder = (displayFolder: string, folder: string): boolean => {
  const target = folder.toLowerCase().replace(/\\+$/, '');
  const candidate = displayFolder.toLowerCase();
  return candidate === target || candidate.startsWith(`${target}\\`);
};

/**
 * Summarise the folders a set of measures falls into, mirroring the tree
 * Excel's field list shows.
 *
 * Built from every measure in scope rather than the filtered subset, because
 * its job is to describe what exists: a caller searching "sales" gets hits from
 * several folders that mean quite different things, and the counts are what
 * reveal that a whole folder is period-relative and therefore cannot break a
 * figure down by month.
 */
const summariseFolders = (
  measures: Array<{ displayFolder: string; caption: string; cacheId: string }>,
): Array<{ folder: string; cache_id: string; measure_count: number; period_relative_count: number }> => {
  const byKey = new Map<
    string,
    { folder: string; cache_id: string; measure_count: number; period_relative_count: number }
  >();
  for (const measure of measures) {
    const key = JSON.stringify([measure.cacheId, measure.displayFolder]);
    const entry = byKey.get(key) ?? {
      folder: measure.displayFolder,
      cache_id: measure.cacheId,
      measure_count: 0,
      period_relative_count: 0,
    };
    entry.measure_count += 1;
    if (isPeriodRelative(measure.caption)) entry.period_relative_count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.cache_id.localeCompare(b.cache_id) || a.folder.localeCompare(b.folder));
};

export const inspectDataModel = defineTool({
  name: 'inspect_data_model',
  displayName: 'Inspect Data Model',
  description:
    'Inspect the data model behind the workbook: connections, PivotTables, and — for cube/OLAP connections — every measure and hierarchy it exposes. ' +
    'The only way to find fields not already in a PivotTable: GETPIVOTDATA resolves a measure only when laid out and returns #REF! otherwise. Use "is_laid_out", and pass "field_index" to add_pivot_field. ' +
    'READ "measure_folders" BEFORE CHOOSING A MEASURE: the model\'s own folder tree with counts. A name search returns candidates from folders meaning different things, and a wholly period_relative folder holds one fixed period each — useless for a monthly breakdown. Drill in with "folder". ' +
    'Models rarely publish what a measure means, so where two plausible ones exist, show the user the folder-grouped candidates rather than picking silently. ' +
    'For a Power BI connection, "dataset_id" gives the semantic-model ID for DAX. Reads the workbook file; the Graph API exposes no pivot surface. The *_count fields are true totals before filtering.',
  summary: 'Inspect connections, PivotTables, and all available cube measures',
  icon: 'database',
  group: 'Data Model',
  input: z.object({
    filter: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter applied to measure and hierarchy names and captions (e.g., "sales", "GM"). Omit to return everything.',
      ),
    folder: z
      .string()
      .optional()
      .describe(
        'Restrict measures to one display folder, as "measure_folders" reports it (e.g. "Base Measures", "Time Series Measures\\\\Sales"). ' +
          'Matches the folder and everything beneath it, so "Time Series Measures" covers all of its subfolders.',
      ),
    cache_id: z
      .string()
      .optional()
      .describe(
        'Restrict measures and hierarchies to a single pivot cache. Omit to cover every cache. ' +
          'Read it from this call, not from an earlier one: Excel reassigns cache ids whenever it rewrites the workbook, ' +
          'which ordinary edits do, so an id from a previous call may name nothing.',
      ),
    include_measures: z.boolean().optional().describe('Include the measure inventory (default true)'),
    include_hierarchies: z.boolean().optional().describe('Include the hierarchy inventory (default true)'),
  }),
  output: z.object({
    connections: z
      .array(connectionSchema)
      .describe(
        'External data connections defined in the workbook. These are READ-ONLY from here and cannot be deleted: ' +
          'no tool in this plugin removes a connection, Microsoft Graph has no connection API at any version, and ' +
          'Excel for the web only lists them — Data > Queries & Connections shows the list but offers no delete. ' +
          'Removing a connection requires opening the workbook in the Excel desktop application. Tell the user that ' +
          'plainly if they ask to delete one, rather than attempting it. Unused connections are inert, but they ' +
          'accumulate and only the desktop app can clear them.',
      ),
    pivot_tables: z.array(pivotTableSchema).describe('Every PivotTable in the workbook'),
    available_measures: z
      .array(availableMeasureSchema)
      .describe('Measures the connected models expose, laid out or not. Empty when include_measures is false.'),
    available_hierarchies: z
      .array(availableHierarchySchema)
      .describe('Hierarchies the connected models expose. Empty when include_hierarchies is false.'),
    measure_folders: z
      .array(
        z.object({
          folder: z.string().describe('Display folder path, "" for measures the model leaves ungrouped'),
          cache_id: z.string().describe('Pivot cache that exposes this folder'),
          measure_count: z.number().int().describe('Measures in this folder'),
          period_relative_count: z
            .number()
            .int()
            .describe('How many of them compute their own period — see period_relative on a measure'),
        }),
      )
      .describe(
        'The model\'s folder tree with counts, exactly as Excel\'s PivotTable field list groups it, and never narrowed by "filter" or "folder" — so it always describes the whole model. ' +
          'Read this before choosing a measure: a name search alone returns candidates from several folders that mean different things, and a folder whose measures are all period_relative holds one fixed period each. ' +
          'Drill into one with the "folder" argument.',
      ),
    measure_count: z.number().int().describe('Total measures across all caches, before filtering'),
    hierarchy_count: z.number().int().describe('Total hierarchies across all caches, before filtering'),
    laid_out_measure_count: z
      .number()
      .int()
      .describe('How many of those measures are currently placed in a PivotTable, and therefore GETPIVOTDATA-readable'),
  }),
  handle: async (params, context) => {
    context?.reportProgress({ progress: 0, total: 3, message: 'Downloading workbook package…' });
    const pkg = await fetchWorkbookPackage();

    context?.reportProgress({ progress: 1, total: 3, message: 'Reading connections and pivot caches…' });
    const connections = await readConnections(pkg);
    const caches = await readPivotCaches(pkg, connections);

    context?.reportProgress({ progress: 2, total: 3, message: 'Reading PivotTables…' });
    const pivotTables = await readPivotTables(pkg, caches);

    const scoped = params.cache_id ? caches.filter(cache => cache.cacheId === params.cache_id) : caches;
    // Raised rather than answered with an empty inventory, which reads exactly
    // like a model that publishes nothing. Cache ids are reassigned when Excel
    // rewrites the workbook, so an id carried over from an earlier call is the
    // likely cause — and the ids that exist now are what the caller needs.
    if (params.cache_id && scoped.length === 0) {
      throw ToolError.validation(
        `No pivot cache "${params.cache_id}" in this workbook. Its caches are: ${
          caches.map(cache => cache.cacheId).join(', ') || '(none — the workbook has no PivotTables)'
        }. Cache ids are reassigned whenever Excel rewrites the workbook, so re-read this call rather than reusing an id from an earlier one.`,
      );
    }
    const filter = (params.filter ?? '').toLowerCase();

    const allMeasures = scoped.flatMap(cache =>
      cache.measures.map(measure => ({ ...measure, cacheId: cache.cacheId })),
    );
    const allHierarchies = scoped.flatMap(cache =>
      cache.hierarchies.map(hierarchy => ({ ...hierarchy, cacheId: cache.cacheId })),
    );

    return {
      connections: connections.map(connection => ({
        id: connection.id,
        name: connection.name,
        description: connection.description,
        type: connection.typeLabel,
        provider: connection.provider,
        server: connection.dataSource,
        catalog: connection.catalog,
        command: connection.command,
        is_remote_model: connection.isRemoteModel,
        dataset_id: connection.datasetId,
        raw: connection.raw,
      })),
      pivot_tables: pivotTables.map(table => ({
        name: table.name,
        worksheet: table.worksheet,
        anchor: table.anchor,
        cache_id: table.cacheId,
        connection_name: table.connectionName,
        rows: table.rows,
        columns: table.columns,
        filters: table.filters.map(f => ({
          caption: f.caption,
          selected_member: f.selectedMember,
          field_index: f.fieldIndex,
        })),
        values: table.values,
      })),
      measure_folders: summariseFolders(allMeasures),
      available_measures:
        params.include_measures === false
          ? []
          : allMeasures
              .filter(measure => params.folder === undefined || inFolder(measure.displayFolder, params.folder))
              .filter(measure => matchesFilter(filter, measure.caption, measure.uniqueName, measure.displayFolder))
              .map(measure => ({
                unique_name: measure.uniqueName,
                caption: measure.caption,
                field_index: measure.index,
                cache_id: measure.cacheId,
                display_folder: measure.displayFolder,
                measure_group: measure.measureGroup,
                is_laid_out: measure.isLaidOut,
                period_relative: isPeriodRelative(measure.caption),
              })),
      available_hierarchies:
        params.include_hierarchies === false
          ? []
          : allHierarchies
              .filter(h => matchesFilter(filter, h.caption, h.uniqueName, h.dimension, h.displayFolder))
              .map(hierarchy => ({
                unique_name: hierarchy.uniqueName,
                caption: hierarchy.caption,
                field_index: hierarchy.index,
                cache_id: hierarchy.cacheId,
                dimension: hierarchy.dimension,
                display_folder: hierarchy.displayFolder,
                level_count: hierarchy.levelCount,
                levels: hierarchy.levels,
                is_attribute: hierarchy.isAttribute,
                is_time: hierarchy.isTime,
                is_laid_out: hierarchy.isLaidOut,
              })),
      measure_count: allMeasures.length,
      hierarchy_count: allHierarchies.length,
      laid_out_measure_count: allMeasures.filter(measure => measure.isLaidOut).length,
    };
  },
});
