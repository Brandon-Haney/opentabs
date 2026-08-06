import { parseBoundedRange } from './a1.js';
import type { OoxmlPackage } from './ooxml.js';

/**
 * Reads the workbook's PivotTable, pivot-cache and data-connection model out of
 * the raw OOXML package.
 *
 * The pivot cache is the interesting part: for an OLAP/cube connection its
 * `cacheHierarchies` list every measure and hierarchy the *model* exposes, not
 * merely the handful a human dragged into the pivot. That is the difference
 * between an agent being able to read the ~24 fields already on a sheet and
 * being able to see the several hundred the semantic model actually publishes.
 */

const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** ECMA-376 `connection/@type` codes. */
const CONNECTION_TYPE_LABELS: Record<string, string> = {
  '1': 'ODBC',
  '2': 'DAO',
  '3': 'File',
  '4': 'Web query',
  '5': 'OLE DB',
  '6': 'Text',
  '7': 'ADO recordset',
  '8': 'DSP',
};

/** Data sources naming the workbook's own in-file Data Model rather than an external system. */
const EMBEDDED_DATA_SOURCE = /^\$Embedded/i;
/** URL-shaped data sources: Power BI, Azure Analysis Services, and plain HTTP OLAP endpoints. */
const REMOTE_DATA_SOURCE_SCHEME = /^(?:pbiazure|powerbi|asazure|https?|net\.tcp):\/\//i;
/** A Power BI semantic-model id, as it appears inside `Initial Catalog=sobe_wowvirtualserver-<guid>`. */
const GUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// --- package path helpers ---

const directoryOf = (partPath: string): string => partPath.slice(0, partPath.lastIndexOf('/') + 1);

/** The `_rels` part that holds a part's relationships. */
const relationshipsPathFor = (partPath: string): string => {
  const directory = directoryOf(partPath);
  return `${directory}_rels/${partPath.slice(directory.length)}.rels`;
};

/** Resolve a relationship `Target` (relative to its owning part) to a package path. */
const resolveRelationshipTarget = (owningPart: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1);
  const resolved: string[] = [];
  for (const segment of `${directoryOf(owningPart)}${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join('/');
};

/** Relationship targets of a given type, resolved to package paths. */
const relationshipTargets = async (pkg: OoxmlPackage, owningPart: string, typeSuffix: string): Promise<string[]> => {
  const doc = await pkg.partXml(relationshipsPathFor(owningPart));
  if (!doc) return [];
  return [...doc.getElementsByTagName('Relationship')]
    .filter(rel => (rel.getAttribute('Type') ?? '').endsWith(`/${typeSuffix}`))
    .map(rel => resolveRelationshipTarget(owningPart, rel.getAttribute('Target') ?? ''));
};

/** Relationship id → resolved package path, for a given relationship type. */
const relationshipsById = async (
  pkg: OoxmlPackage,
  owningPart: string,
  typeSuffix: string,
): Promise<Map<string, string>> => {
  const doc = await pkg.partXml(relationshipsPathFor(owningPart));
  const byId = new Map<string, string>();
  if (!doc) return byId;
  for (const rel of doc.getElementsByTagName('Relationship')) {
    if (!(rel.getAttribute('Type') ?? '').endsWith(`/${typeSuffix}`)) continue;
    byId.set(rel.getAttribute('Id') ?? '', resolveRelationshipTarget(owningPart, rel.getAttribute('Target') ?? ''));
  }
  return byId;
};

// --- connection strings ---

/**
 * Split an OLE DB connection string into its key/value pairs.
 *
 * Values may be wrapped in `{}` or `""` precisely so they can contain the `;`
 * that otherwise separates pairs, so a plain `split(';')` corrupts them.
 */
const parseConnectionString = (raw: string): Map<string, string> => {
  const pairs = new Map<string, string>();
  let key = '';
  let value = '';
  let readingKey = true;
  let closer = '';

  const commit = () => {
    if (key.trim()) pairs.set(key.trim().toLowerCase(), value.trim());
    key = '';
    value = '';
    readingKey = true;
  };

  for (const char of raw) {
    if (closer) {
      if (char === closer) closer = '';
      else value += char;
      continue;
    }
    if (readingKey) {
      if (char === '=') readingKey = false;
      else if (char === ';') commit();
      else key += char;
      continue;
    }
    if (char === ';') commit();
    else if (value === '' && (char === '{' || char === '"')) closer = char === '{' ? '}' : '"';
    else value += char;
  }
  commit();
  return pairs;
};

/**
 * Whether the connection's data lives outside this workbook.
 *
 * `true` for a remote model or external source, `false` for the workbook's own
 * embedded Data Model, and `null` when the connection string does not say — in
 * which case callers surface the raw string rather than guessing.
 */
const resolveIsRemoteModel = (dataSource: string): boolean | null => {
  if (!dataSource) return null;
  if (EMBEDDED_DATA_SOURCE.test(dataSource)) return false;
  if (REMOTE_DATA_SOURCE_SCHEME.test(dataSource)) return true;
  return true;
};

export interface WorkbookConnection {
  /** `connection/@id`, the key `cacheSource/@connectionId` joins on. */
  id: string;
  /** `connection/@name` — the exact string `CUBEVALUE`/`CUBEMEMBER` take as their first argument. */
  name: string;
  description: string;
  typeLabel: string;
  provider: string;
  dataSource: string;
  catalog: string;
  command: string;
  isRemoteModel: boolean | null;
  /** Power BI semantic-model id, when the catalog encodes one. */
  datasetId: string;
  /**
   * The connection string's `Identity Provider` clause — authority, resource,
   * and client id, comma-separated. A cube connection cannot authenticate
   * without it, so anything rebuilding a connection string has to carry it over
   * rather than reconstruct it.
   */
  identityProvider: string;
  raw: string;
}

/** Read `xl/connections.xml`. Absent in workbooks with no external data. */
export const readConnections = async (pkg: OoxmlPackage): Promise<WorkbookConnection[]> => {
  const doc = await pkg.partXml('xl/connections.xml');
  if (!doc) return [];

  return [...doc.getElementsByTagName('connection')].map(element => {
    const dbPr = element.getElementsByTagName('dbPr')[0];
    const raw = dbPr?.getAttribute('connection') ?? '';
    const parts = parseConnectionString(raw);
    const catalog = parts.get('initial catalog') ?? parts.get('database') ?? '';
    const dataSource = parts.get('data source') ?? parts.get('server') ?? '';
    return {
      id: element.getAttribute('id') ?? '',
      name: element.getAttribute('name') ?? '',
      description: element.getAttribute('description') ?? '',
      typeLabel: CONNECTION_TYPE_LABELS[element.getAttribute('type') ?? ''] ?? 'Unknown',
      provider: parts.get('provider') ?? '',
      dataSource,
      catalog,
      command: dbPr?.getAttribute('command') ?? '',
      isRemoteModel: resolveIsRemoteModel(dataSource),
      datasetId: catalog.match(GUID_PATTERN)?.[0] ?? '',
      identityProvider: parts.get('identity provider') ?? '',
      raw,
    };
  });
};

// --- pivot caches ---

/**
 * Position of a `cacheHierarchy` element in its cache, in document order.
 *
 * This is the id every pivot write operation addresses a field by — the service
 * calls it `PivotCacheIndex` in a field-layout response and `FieldId` in a
 * filter request. Measures and hierarchies share one numbering because they
 * share one element list, so the index cannot be recovered from either array's
 * own position and has to be recorded while reading.
 */
export interface CacheHierarchyIndex {
  index: number;
}

export interface CacheMeasure extends CacheHierarchyIndex {
  uniqueName: string;
  caption: string;
  displayFolder: string;
  measureGroup: string;
  isLaidOut: boolean;
}

export interface CacheHierarchy extends CacheHierarchyIndex {
  uniqueName: string;
  caption: string;
  dimension: string;
  displayFolder: string;
  /** Number of levels the hierarchy has, per `cacheHierarchy/@count`. */
  levelCount: number;
  /** Level unique names materialised in this cache. Empty unless the hierarchy is laid out. */
  levels: string[];
  isAttribute: boolean;
  isTime: boolean;
  isLaidOut: boolean;
}

export interface PivotCacheModel {
  part: string;
  /** `pivotCache/@cacheId` from `xl/workbook.xml`; the key a PivotTable references. */
  cacheId: string;
  connectionId: string;
  connectionName: string;
  /** Unique names of the fields materialised in the cache — i.e. used by a pivot. */
  cacheFieldNames: string[];
  measures: CacheMeasure[];
  hierarchies: CacheHierarchy[];
  dimensions: string[];
  measureGroups: string[];
}

/** Caption for a cache field index, falling back to its unique name. */
const captionOfCacheField = (fields: Element[], index: number): string => {
  const field = fields[index];
  if (!field) return '';
  return field.getAttribute('caption') || field.getAttribute('name') || '';
};

const readPivotCache = async (
  pkg: OoxmlPackage,
  part: string,
  cacheId: string,
  connectionsById: Map<string, WorkbookConnection>,
): Promise<PivotCacheModel | null> => {
  const doc = await pkg.partXml(part);
  if (!doc) return null;

  const cacheFields = [...doc.getElementsByTagName('cacheField')];
  const cacheFieldNames = cacheFields.map(field => field.getAttribute('name') ?? '');
  const laidOutNames = new Set(cacheFieldNames);

  const measures: CacheMeasure[] = [];
  const hierarchies: CacheHierarchy[] = [];

  // Enumerated with an explicit counter because the index is the field id the
  // write operations take, and measures and hierarchies are split into separate
  // arrays as they are read.
  let index = -1;
  for (const element of doc.getElementsByTagName('cacheHierarchy')) {
    index += 1;
    const uniqueName = element.getAttribute('uniqueName') ?? '';
    const caption = element.getAttribute('caption') ?? '';
    const displayFolder = element.getAttribute('displayFolder') ?? '';

    if (element.getAttribute('measure') === '1') {
      // A measure's cacheField carries the hierarchy's own unique name verbatim,
      // so set membership is an exact test for "already in the pivot".
      measures.push({
        index,
        uniqueName,
        caption,
        displayFolder,
        measureGroup: element.getAttribute('measureGroup') ?? '',
        isLaidOut: laidOutNames.has(uniqueName),
      });
      continue;
    }

    // A hierarchy's cacheFields are its *levels*, named `<hierarchy>.<level>`,
    // so membership is a prefix test. `fieldsUsage` corroborates it: a level
    // bound to a cache field carries a non-negative index.
    const levels = cacheFieldNames.filter(name => name.startsWith(`${uniqueName}.`));
    const usages = [...element.getElementsByTagName('fieldUsage')].map(usage =>
      Number.parseInt(usage.getAttribute('x') ?? '-1', 10),
    );
    hierarchies.push({
      index,
      uniqueName,
      caption,
      dimension: element.getAttribute('dimensionUniqueName') ?? '',
      displayFolder,
      levelCount: Number.parseInt(element.getAttribute('count') ?? '0', 10) || 0,
      levels,
      isAttribute: element.getAttribute('attribute') === '1',
      isTime: element.getAttribute('time') === '1',
      isLaidOut: levels.length > 0 || usages.some(index => index >= 0),
    });
  }

  const connectionId = doc.getElementsByTagName('cacheSource')[0]?.getAttribute('connectionId') ?? '';
  return {
    part,
    cacheId,
    connectionId,
    connectionName: connectionsById.get(connectionId)?.name ?? '',
    cacheFieldNames,
    measures,
    hierarchies,
    dimensions: [...doc.getElementsByTagName('dimension')].map(
      d => d.getAttribute('uniqueName') || d.getAttribute('name') || '',
    ),
    measureGroups: [...doc.getElementsByTagName('measureGroup')].map(g => g.getAttribute('name') ?? ''),
  };
};

/**
 * Read every pivot cache in the workbook.
 *
 * `xl/workbook.xml` owns the cacheId → cache-part mapping, which is the join
 * key a PivotTable uses, so caches are discovered through it rather than by
 * globbing part names.
 */
export const readPivotCaches = async (
  pkg: OoxmlPackage,
  connections: WorkbookConnection[],
): Promise<PivotCacheModel[]> => {
  const workbook = await pkg.partXml('xl/workbook.xml');
  if (!workbook) return [];

  const cachePartsById = await relationshipsById(pkg, 'xl/workbook.xml', 'pivotCacheDefinition');
  const connectionsById = new Map(connections.map(connection => [connection.id, connection]));

  const caches: PivotCacheModel[] = [];
  for (const element of workbook.getElementsByTagName('pivotCache')) {
    const cacheId = element.getAttribute('cacheId') ?? '';
    const part = cachePartsById.get(element.getAttributeNS(RELATIONSHIP_NS, 'id') ?? '');
    if (!part) continue;
    const cache = await readPivotCache(pkg, part, cacheId, connectionsById);
    if (cache) caches.push(cache);
  }
  return caches;
};

// --- pivot tables ---

export interface PivotFilter {
  caption: string;
  /** Unique name of the member the filter is pinned to, empty when unpinned or multi-select. */
  selectedMember: string;
  /**
   * The filter field's `cacheHierarchy` index, from `pageField/@hier`, which is
   * the id a filter write addresses it by. -1 when the pivot is not cube-backed,
   * where `@hier` does not name a hierarchy.
   */
  fieldIndex: number;
}

export interface PivotTableModel {
  name: string;
  worksheet: string;
  /** Range the PivotTable occupies, in A1 notation (`location/@ref`). */
  anchor: string;
  cacheId: string;
  connectionName: string;
  rows: string[];
  columns: string[];
  filters: PivotFilter[];
  values: string[];
  part: string;
}

/** Field indices in `rowFields`/`colFields`; -2 is the synthetic "Values" field. */
const DATA_FIELD_PLACEHOLDER = -2;

const axisCaptions = (doc: Document, tagName: string, cacheFields: Element[]): string[] =>
  [...(doc.getElementsByTagName(tagName)[0]?.getElementsByTagName('field') ?? [])].map(field => {
    const index = Number.parseInt(field.getAttribute('x') ?? '-1', 10);
    if (index === DATA_FIELD_PLACEHOLDER) return 'Values';
    return captionOfCacheField(cacheFields, index);
  });

/** Worksheet name → its part path, in workbook order. */
export const readSheetParts = async (pkg: OoxmlPackage): Promise<Map<string, string>> => {
  const workbook = await pkg.partXml('xl/workbook.xml');
  const parts = new Map<string, string>();
  if (!workbook) return parts;

  const sheetPartsById = await relationshipsById(pkg, 'xl/workbook.xml', 'worksheet');
  for (const sheet of workbook.getElementsByTagName('sheet')) {
    const part = sheetPartsById.get(sheet.getAttributeNS(RELATIONSHIP_NS, 'id') ?? '');
    if (part) parts.set(sheet.getAttribute('name') ?? '', part);
  }
  return parts;
};

/** Map each PivotTable part to the worksheet that hosts it, via the sheet relationships. */
const readPivotTableWorksheets = async (pkg: OoxmlPackage): Promise<Map<string, string>> => {
  const worksheetByPivotPart = new Map<string, string>();
  for (const [name, sheetPart] of await readSheetParts(pkg)) {
    for (const pivotPart of await relationshipTargets(pkg, sheetPart, 'pivotTable')) {
      worksheetByPivotPart.set(pivotPart, name);
    }
  }
  return worksheetByPivotPart;
};

/** A formula that reads a PivotTable's values, and where it lives. */
export interface GetPivotDataReference {
  /** Worksheet holding the formula. */
  worksheet: string;
  /** Cell the formula sits in, in A1 notation. */
  cell: string;
  /** The formula itself. */
  formula: string;
}

/**
 * Find every `GETPIVOTDATA` formula in the workbook that reads the PivotTable on
 * `pivotWorksheet`.
 *
 * This exists to make a specific hazard visible before it bites. A
 * `GETPIVOTDATA` call carrying no field/item argument pairs resolves to the
 * pivot's grand total, so adding a field to Rows or Columns silently changes
 * what every such formula returns — no error, no recalculation warning, just
 * different numbers on whatever reads them. Adding to Values or Filters does
 * not have that effect.
 *
 * Matching is by the pivot's host sheet name, which is what a `GETPIVOTDATA`
 * reference argument names. That can over-report when several pivots share a
 * sheet — deliberately, since the failure mode of missing a reference is far
 * worse than the failure mode of flagging one too many.
 */
export const findGetPivotDataReferences = async (
  pkg: OoxmlPackage,
  pivotWorksheet: string,
): Promise<GetPivotDataReference[]> => {
  const references: GetPivotDataReference[] = [];
  // A reference may be written bare or quoted, and quoting is mandatory once the
  // name contains a space: GETPIVOTDATA("m",Sheet!$A$4) vs ('My Sheet'!$A$4).
  const sheetToken = pivotWorksheet.toLowerCase();

  for (const [worksheet, part] of await readSheetParts(pkg)) {
    const doc = await pkg.partXml(part);
    if (!doc) continue;
    for (const formulaElement of doc.getElementsByTagName('f')) {
      const formula = formulaElement.textContent ?? '';
      if (!formula.toUpperCase().includes('GETPIVOTDATA')) continue;
      if (!formula.toLowerCase().includes(sheetToken)) continue;
      references.push({
        worksheet,
        cell: formulaElement.parentElement?.getAttribute('r') ?? '',
        formula,
      });
    }
  }
  return references;
};

/** Read every PivotTable in the workbook, resolved against its cache and host sheet. */
export const readPivotTables = async (pkg: OoxmlPackage, caches: PivotCacheModel[]): Promise<PivotTableModel[]> => {
  const worksheetByPart = await readPivotTableWorksheets(pkg);
  const cacheByPart = new Map(caches.map(cache => [cache.part, cache]));

  const tables: PivotTableModel[] = [];
  for (const part of pkg.matching(/^xl\/pivotTables\/pivotTable\d*\.xml$/)) {
    const doc = await pkg.partXml(part);
    if (!doc) continue;

    // The PivotTable's own relationship names its cache part directly, which is
    // more robust than trusting `@cacheId` — Excel renumbers cache ids on refresh.
    const [cachePart] = await relationshipTargets(pkg, part, 'pivotCacheDefinition');
    const cache = cachePart ? cacheByPart.get(cachePart) : undefined;
    const cacheDoc = cachePart ? await pkg.partXml(cachePart) : null;
    const cacheFields = cacheDoc ? [...cacheDoc.getElementsByTagName('cacheField')] : [];

    const filters: PivotFilter[] = [...doc.getElementsByTagName('pageField')].map(field => ({
      caption: captionOfCacheField(cacheFields, Number.parseInt(field.getAttribute('fld') ?? '-1', 10)),
      selectedMember: field.getAttribute('name') ?? '',
      fieldIndex: Number.parseInt(field.getAttribute('hier') ?? '-1', 10),
    }));

    const values = [...doc.getElementsByTagName('dataField')].map(
      field =>
        field.getAttribute('name') ||
        captionOfCacheField(cacheFields, Number.parseInt(field.getAttribute('fld') ?? '-1', 10)),
    );

    tables.push({
      name: doc.documentElement.getAttribute('name') ?? '',
      worksheet: worksheetByPart.get(part) ?? '',
      anchor: doc.getElementsByTagName('location')[0]?.getAttribute('ref') ?? '',
      cacheId: cache?.cacheId ?? doc.documentElement.getAttribute('cacheId') ?? '',
      connectionName: cache?.connectionName ?? '',
      rows: axisCaptions(doc, 'rowFields', cacheFields),
      columns: axisCaptions(doc, 'colFields', cacheFields),
      filters,
      values,
      part,
    });
  }
  return tables;
};

/**
 * Locate the PivotTable on `worksheet`, by name when several share the sheet.
 *
 * Returns null rather than throwing so a caller can phrase the failure in its
 * own terms — the useful error names the pivots that do exist.
 */
export const findPivotTable = (tables: PivotTableModel[], worksheet: string, name?: string): PivotTableModel | null => {
  const onSheet = tables.filter(table => table.worksheet === worksheet);
  if (name !== undefined) return onSheet.find(table => table.name === name) ?? null;
  return onSheet.length === 1 ? (onSheet[0] ?? null) : null;
};

/**
 * The cell the filter operations address one page filter by: the cell showing
 * that filter's current selection, zero-based.
 *
 * Page filters stack in the rows directly above the pivot body, one per row and
 * in declaration order, separated from it by a blank row, with the caption in
 * the pivot's own column and the selected value in the next one. So the value
 * cell for filter `filterIndex` is that many rows below the block's top.
 *
 * Verified on two live pivots that share a layout but differ in which filter
 * was addressed: on a pivot anchored at A4 with two filters, its *second*
 * filter is row 1 and its *first* is row 0. Deriving this from the block's top
 * alone matches only when the filter happens to be the second one.
 *
 * Returns null when the index is out of range or the arithmetic falls off the
 * top of the sheet; a fabricated cell is rejected as a generic out-of-sync
 * request rather than an obviously bad argument.
 */
export const pageFilterCell = (table: PivotTableModel, filterIndex: number): { row: number; column: number } | null => {
  if (filterIndex < 0 || filterIndex >= table.filters.length) return null;
  const bounds = parseBoundedRange(table.anchor);
  const blockTop = bounds.startRow - 1 - table.filters.length;
  const row = blockTop + filterIndex;
  if (row < 0) return null;
  return { row, column: bounds.startCol + 1 };
};

/**
 * Render a field id the way the filter methods take it: **hexadecimal**, upper
 * case, as a string.
 *
 * Every other pivot method takes this id as a plain number. Field 6 encodes as
 * "6" in either base, which is why a decimal id worked on the first pivot
 * tested and failed on the next one, whose field 14 the service wants as "E".
 */
export const toFilterFieldId = (fieldIndex: number): string => fieldIndex.toString(16).toUpperCase();

/** True when the package contains at least one PivotTable part. */
export const hasPivotTableParts = (partNames: string[]): boolean =>
  partNames.some(name => /^xl\/pivotTables\/pivotTable\d*\.xml$/.test(name));
