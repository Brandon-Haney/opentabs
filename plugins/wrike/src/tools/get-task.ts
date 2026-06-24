import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import {
  buildRelatedIndex,
  PROP,
  permalink,
  propRefId,
  propRefIds,
  type RawPropertyValues,
  type RawRelatedEntity,
  resolveStatusTitle,
  resolveUser,
  userSchema,
} from './schemas.js';

interface WorkItemViewResponse {
  header?: {
    title?: { title?: string };
    workItemType?: { title?: string };
    location?: { folders?: Array<{ id?: number | string; title?: string }> };
  };
  actionBar?: { actionMenu?: { startDate?: string | null; finishDate?: string | null } };
  itemInfo?: { itemId?: number | string; baseEntityType?: string };
}

interface WivPropertiesResponse {
  propertiesValue?: RawPropertyValues;
  propertiesMetadata?: Record<string, { title?: string; origin?: string } | undefined>;
  relatedEntities?: RawRelatedEntity[];
}

interface LiveEditorResponse {
  description?: string | null;
}

const MAX_DESCRIPTION = 50_000;

export const getTask = defineTool({
  name: 'get_task',
  displayName: 'Get Task',
  description:
    'Get full details for a single Wrike task by id: title, workflow status, item type, assignees, author, start/finish dates, created date, parent folders, the HTML description, and any custom fields. Works for tasks and projects.',
  summary: 'Get full details of a task',
  icon: 'square-check-big',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id (numeric Wrike id), e.g. from list_folder_contents'),
  }),
  output: z.object({
    id: z.string().describe('Task id'),
    title: z.string().describe('Task title'),
    item_type: z.string().describe('Item type display name (e.g. Task, Project), or empty'),
    base_type: z.string().describe('Base entity type (task, folder, project), or empty'),
    status: z.string().describe('Workflow status title (e.g. Active, Completed), or empty'),
    status_id: z.string().describe('Workflow status id, or empty'),
    assignees: z.array(userSchema).describe('Assigned users'),
    author: userSchema.describe('User who created the task'),
    start_date: z.string().describe('Start date/time (e.g. 2025-07-07 09:00:00), or empty'),
    finish_date: z.string().describe('Finish/due date/time (e.g. 2025-07-11 17:00:00), or empty'),
    created_date: z.string().describe('ISO 8601 creation timestamp, or empty'),
    description: z.string().describe('Task description as HTML, or empty if none'),
    parent_folders: z
      .array(z.object({ id: z.string().describe('Folder id'), title: z.string().describe('Folder title') }))
      .describe('Folders this task lives in'),
    custom_fields: z
      .array(z.object({ name: z.string().describe('Field name'), value: z.string().describe('Field value as text') }))
      .describe('Custom field values set on this task'),
    permalink: z.string().describe('Permanent URL to open the task in Wrike'),
  }),
  handle: async params => {
    const id = params.task_id;
    const [view, props, le] = await Promise.all([
      rpc<WorkItemViewResponse>('work_item_view_get_initial_data', { itemId: Number(id), spaceId: null }),
      rpc<WivPropertiesResponse>('wiv_get_properties', {
        entityId: Number(id),
        visibilities: ['top', 'visible', 'hidden'],
      }),
      rpc<LiveEditorResponse>('le_get_initial_data', { taskId: Number(id), isStatic: false }).catch(() => ({
        description: null,
      })),
    ]);

    const pv = props.propertiesValue;
    const index = buildRelatedIndex(props.relatedEntities);
    const statusId = propRefId(pv, PROP.STATUS);
    const authorId = propRefId(pv, PROP.AUTHOR);

    const customFields = Object.entries(props.propertiesMetadata ?? {})
      .filter(([, meta]) => meta?.origin === 'Custom')
      .map(([key, meta]) => {
        const raw = pv?.[key]?.value;
        const value = raw === null || raw === undefined ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
        return { name: meta?.title ?? '', value };
      })
      .filter(field => field.value !== '');

    const description = (le.description ?? '').slice(0, MAX_DESCRIPTION);

    return {
      id,
      title: view.header?.title?.title ?? '',
      item_type: view.header?.workItemType?.title ?? '',
      base_type: view.itemInfo?.baseEntityType ?? '',
      status: statusId ? resolveStatusTitle(index, statusId) : '',
      status_id: statusId,
      assignees: propRefIds(pv, PROP.ASSIGNEES).map(uid => resolveUser(index, uid)),
      author: resolveUser(index, authorId),
      start_date: view.actionBar?.actionMenu?.startDate ?? '',
      finish_date: view.actionBar?.actionMenu?.finishDate ?? '',
      created_date: typeof pv?.[PROP.CREATED_DATE]?.value === 'string' ? (pv[PROP.CREATED_DATE]?.value as string) : '',
      description,
      parent_folders: (view.header?.location?.folders ?? []).map(folder => ({
        id: folder.id !== undefined && folder.id !== null ? String(folder.id) : '',
        title: folder.title ?? '',
      })),
      custom_fields: customFields,
      permalink: permalink(id),
    };
  },
});
