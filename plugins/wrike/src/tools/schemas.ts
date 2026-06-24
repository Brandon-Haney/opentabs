import { z } from 'zod';

// ---------------------------------------------------------------------------
// Wrike's internal model keys properties and entity references by stable
// negative system ids. These constants name them so tool code stays readable.
// ---------------------------------------------------------------------------

/** Property ids on a work item's `propertyValues` map. */
export const PROP = {
  NAME: '-1',
  ASSIGNEES: '-2',
  STATUS: '-4',
  PARENTS: '-5',
  START_DATE: '-6',
  DUE_DATE: '-7',
  DURATION: '-8',
  AUTHOR: '-9',
  IMPORTANCE: '-10',
  CREATED_DATE: '-14',
  ITEM_TYPE: '-31',
  NUMERIC_ID: '-38',
} as const;

/** Property ids found on entries in a `relatedEntities` list. */
export const REL_PROP = {
  FIRST_NAME: '-32',
  LAST_NAME: '-33',
  AVATAR: '-34',
  TYPE_NAME: '-35',
  STATUS_TITLE: '-36',
  EMAIL: '-39',
} as const;

/** Reference `typeId` values used inside property values. */
export const REF_TYPE = {
  CONTACT: -5,
  STATUS: -3,
  ITEM_TYPE: -4,
  TASK: -11,
  PROJECT: -12,
  FOLDER: -13,
} as const;

// ---------------------------------------------------------------------------
// Raw response shapes (all fields optional — the API may omit any of them)
// ---------------------------------------------------------------------------

export interface RawPropertyValue {
  value?: unknown;
}

export type RawPropertyValues = Record<string, RawPropertyValue | undefined>;

export interface RawEntity {
  entityId?: number | string;
  tableViewEntityType?: string;
  propertyValues?: RawPropertyValues;
}

export interface RawRelatedEntity {
  id?: number | string;
  typeId?: number;
  propertyValues?: RawPropertyValues;
}

interface RawReference {
  id?: number | string;
  typeId?: number;
}

// ---------------------------------------------------------------------------
// Related-entity index — resolves reference ids to human-readable values
// ---------------------------------------------------------------------------

export type RelatedIndex = Map<string, RawRelatedEntity>;

export const buildRelatedIndex = (related: RawRelatedEntity[] | undefined): RelatedIndex => {
  const index: RelatedIndex = new Map();
  for (const entity of related ?? []) {
    if (entity.id !== undefined && entity.id !== null) index.set(String(entity.id), entity);
  }
  return index;
};

const relText = (entity: RawRelatedEntity | undefined, key: string): string => {
  const raw = entity?.propertyValues?.[key]?.value;
  return typeof raw === 'string' ? raw : '';
};

export const resolveUser = (index: RelatedIndex, id: string): z.infer<typeof userSchema> => {
  const entity = index.get(id);
  const firstName = relText(entity, REL_PROP.FIRST_NAME);
  const lastName = relText(entity, REL_PROP.LAST_NAME);
  return {
    id,
    name: [firstName, lastName].filter(Boolean).join(' '),
    email: relText(entity, REL_PROP.EMAIL),
  };
};

export const resolveStatusTitle = (index: RelatedIndex, id: string): string =>
  relText(index.get(id), REL_PROP.STATUS_TITLE);

export const resolveItemTypeName = (index: RelatedIndex, id: string): string =>
  relText(index.get(id), REL_PROP.TYPE_NAME);

// ---------------------------------------------------------------------------
// Property-value extractors
// ---------------------------------------------------------------------------

export const propText = (pv: RawPropertyValues | undefined, key: string): string => {
  const raw = pv?.[key]?.value;
  return typeof raw === 'string' ? raw : '';
};

export const propRefId = (pv: RawPropertyValues | undefined, key: string): string => {
  const raw = pv?.[key]?.value as RawReference | undefined;
  return raw?.id !== undefined && raw?.id !== null ? String(raw.id) : '';
};

export const propRefIds = (pv: RawPropertyValues | undefined, key: string): string[] => {
  const raw = pv?.[key]?.value as Array<{ value?: RawReference }> | undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => item.value?.id)
    .filter((id): id is number | string => id !== undefined && id !== null)
    .map(String);
};

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export const userSchema = z.object({
  id: z.string().describe('Wrike contact id'),
  name: z.string().describe('Full display name, or empty if unknown'),
  email: z.string().describe('Email address, or empty if not available'),
});

// ---------------------------------------------------------------------------
// Work item (task / folder / project listing entry)
// ---------------------------------------------------------------------------

export const workItemSchema = z.object({
  id: z.string().describe('Work item id (use with get_task / list_folder_contents)'),
  type: z.string().describe('Entity type: Task, Folder, or Project'),
  title: z.string().describe('Item title'),
  status: z.string().describe('Workflow status title (e.g. Active, Completed), or empty if not resolved'),
  status_id: z.string().describe('Workflow status id, or empty'),
  item_type: z.string().describe('Custom item type name (e.g. Task, Project), or empty'),
  assignees: z.array(userSchema).describe('Assigned users'),
  start_date: z.string().describe('Start date (local, e.g. 2024-10-07T00:00), or empty'),
  due_date: z.string().describe('Due date (local, e.g. 2028-12-31T00:00), or empty'),
  parent_ids: z.array(z.string()).describe('Parent folder/project ids this item lives under'),
  permalink: z.string().describe('Permanent URL to open this item in Wrike'),
});

export const permalink = (id: string): string => `https://www.wrike.com/open.htm?id=${id}`;

export const mapWorkItem = (entity: RawEntity, index: RelatedIndex): z.infer<typeof workItemSchema> => {
  const pv = entity.propertyValues;
  const id = entity.entityId !== undefined && entity.entityId !== null ? String(entity.entityId) : '';
  const statusId = propRefId(pv, PROP.STATUS);
  const itemTypeId = propRefId(pv, PROP.ITEM_TYPE);
  return {
    id,
    type: entity.tableViewEntityType ?? '',
    title: propText(pv, PROP.NAME),
    status: statusId ? resolveStatusTitle(index, statusId) : '',
    status_id: statusId,
    item_type: itemTypeId ? resolveItemTypeName(index, itemTypeId) : '',
    assignees: propRefIds(pv, PROP.ASSIGNEES).map(uid => resolveUser(index, uid)),
    start_date: propText(pv, PROP.START_DATE),
    due_date: propText(pv, PROP.DUE_DATE),
    parent_ids: propRefIds(pv, PROP.PARENTS),
    permalink: permalink(id),
  };
};
