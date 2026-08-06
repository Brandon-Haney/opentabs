import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { readConnections, readPivotCaches, readPivotTables } from '../pivot-model.js';
import { fetchWorkbookPackage } from '../workbook-package.js';
import { availableHierarchySchema, availableMeasureSchema, connectionSchema, pivotTableSchema } from './schemas.js';

/** Case-insensitive substring match over the fields an agent would search by. */
const matchesFilter = (filter: string, ...fields: string[]): boolean =>
  filter === '' || fields.some(field => field.toLowerCase().includes(filter));

export const inspectDataModel = defineTool({
  name: 'inspect_data_model',
  displayName: 'Inspect Data Model',
  description:
    'Inspect the data model behind the workbook: its external data connections, its PivotTables, and — for cube/OLAP connections — the complete inventory of measures and hierarchies the model exposes. ' +
    'This is the only way to discover fields that are NOT already in a PivotTable: GETPIVOTDATA resolves a measure only when it is laid out in a pivot and returns #REF! otherwise, so the sheet shows a small fraction of what the model publishes. ' +
    'Use "is_laid_out" to tell the two apart, and pass "field_index" to add_pivot_field to place one. For a Power BI connection, "dataset_id" gives the semantic-model ID for running DAX against the same model. ' +
    'Reads the workbook file itself, because the Microsoft Graph workbook API has no PivotTable, connection or pivot-cache surface at any version. ' +
    'A large semantic model can expose several hundred measures — pass "filter" to narrow the result. The *_count fields always report true totals before filtering, so you can tell when you are seeing a subset.',
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
    cache_id: z
      .string()
      .optional()
      .describe('Restrict measures and hierarchies to a single pivot cache. Omit to cover every cache.'),
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
      available_measures:
        params.include_measures === false
          ? []
          : allMeasures
              .filter(measure => matchesFilter(filter, measure.caption, measure.uniqueName, measure.displayFolder))
              .map(measure => ({
                unique_name: measure.uniqueName,
                caption: measure.caption,
                field_index: measure.index,
                cache_id: measure.cacheId,
                display_folder: measure.displayFolder,
                measure_group: measure.measureGroup,
                is_laid_out: measure.isLaidOut,
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
