import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import { permalink, userSchema } from './schemas.js';

interface SearchAssignee {
  uid?: string;
  firstName?: string;
  lastName?: string;
}

interface SearchTaskResult {
  id?: number | string;
  title?: string;
  briefDescription?: string;
  project?: boolean;
  stage?: { id?: number | string; title?: string; color?: string };
  assignees?: SearchAssignee[];
  folders?: Array<{ id?: number | string; title?: string }>;
  author?: string;
  startDate?: string | null;
  finishDate?: string | null;
  createdDate?: number;
  isStarred?: boolean;
  hasAttachments?: boolean;
}

const idStr = (id: number | string | undefined): string => (id !== undefined && id !== null ? String(id) : '');

const isoFromEpoch = (epochMs: number | undefined): string => {
  if (typeof epochMs !== 'number') return '';
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

export const searchTasks = defineTool({
  name: 'search_tasks',
  displayName: 'Search Tasks',
  description:
    'Full-text search for tasks and projects across the whole account by keyword. Matches titles, descriptions, and comments, ranked by relevance. Returns each result with its title, brief description, workflow status, assignees, parent folders, and dates. Use this to find items when you do not know which folder they live in.',
  summary: 'Search tasks and projects by keyword',
  icon: 'search',
  group: 'Tasks',
  input: z.object({
    query: z.string().min(1).describe('Text to search for in task titles, descriptions, and comments'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum results to return (default 25, max 100)'),
    offset: z.number().int().min(0).optional().describe('Number of results to skip for pagination (default 0)'),
  }),
  output: z.object({
    tasks: z
      .array(
        z.object({
          id: z.string().describe('Task/project id'),
          title: z.string().describe('Title'),
          brief_description: z.string().describe('Short plain-text description excerpt, or empty'),
          is_project: z.boolean().describe('True if this item is a project rather than a task'),
          status: z.string().describe('Workflow status title (e.g. Active, Completed), or empty'),
          status_id: z.string().describe('Workflow status id, or empty'),
          assignees: z.array(userSchema).describe('Assigned users (email is not included in search results)'),
          folders: z
            .array(z.object({ id: z.string().describe('Folder id'), title: z.string().describe('Folder title') }))
            .describe('Parent folders'),
          author_id: z.string().describe('Contact id of the author'),
          start_date: z.string().describe('Start date, or empty'),
          finish_date: z.string().describe('Finish/due date, or empty'),
          created_at: z.string().describe('ISO 8601 creation timestamp, or empty'),
          permalink: z.string().describe('Permanent URL to open the item in Wrike'),
        }),
      )
      .describe('Matching tasks and projects, most relevant first'),
    count: z.number().int().describe('Number of results returned'),
  }),
  handle: async params => {
    const data = await rpc<SearchTaskResult[]>('get_view_task_search', {
      text: [params.query],
      limit: params.limit ?? 25,
      offset: params.offset ?? 0,
      fetchLimit: 1000,
      sortByField: 'Relevancy',
      sortOrder: 'ASC',
      Context: 'global',
      scope: ['RealWork'],
      showDescendants: true,
      showSubtasks: false,
      skipSubProjects: false,
      recycleBin: false,
      withRights: false,
      firstDayOfWeek: 0,
      // The endpoint expects every filter array to be present, even when empty.
      keyword: [],
      assigned: [],
      shared: [],
      author: [],
      start: [],
      finish: [],
      due: [],
      created: [],
      updated: [],
      completed: [],
      stageIds: [],
      notupdated: [],
      duration: [],
      priority: [],
      between: [],
      title: [],
      description: [],
      folder: [],
      comment: [],
      field: [],
      notfolder: [],
      file: [],
      status: [],
    });

    // The search index can return permission-restricted or ghost entries that
    // come back with an id but no readable fields — drop those.
    const tasks = (data ?? [])
      .filter(result => (result.title ?? '') !== '')
      .map(result => ({
        id: idStr(result.id),
        title: result.title ?? '',
        brief_description: result.briefDescription ?? '',
        is_project: result.project ?? false,
        status: result.stage?.title ?? '',
        status_id: idStr(result.stage?.id),
        assignees: (result.assignees ?? []).map(assignee => ({
          id: assignee.uid ?? '',
          name: [assignee.firstName, assignee.lastName].filter(Boolean).join(' '),
          email: '',
        })),
        folders: (result.folders ?? []).map(folder => ({ id: idStr(folder.id), title: folder.title ?? '' })),
        author_id: result.author ?? '',
        start_date: result.startDate ?? '',
        finish_date: result.finishDate ?? '',
        created_at: isoFromEpoch(result.createdDate),
        permalink: permalink(idStr(result.id)),
      }));

    return { tasks, count: tasks.length };
  },
});
