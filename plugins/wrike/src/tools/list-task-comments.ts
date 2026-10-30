import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { rpc } from '../wrike-api.js';
import { userSchema } from './schemas.js';

interface StreamAuthor {
  uid?: string;
  firstName?: string;
  lastName?: string;
}

interface ScheduledDates {
  startDate?: string | null;
  finishDate?: string | null;
}

interface StreamUpdate {
  statusUpdate?: { newValue?: { title?: string } };
  assigneeUpdate?: { action?: string; newValue?: StreamAuthor[] };
  parentsUpdate?: { action?: string; newValue?: Array<{ name?: string }> };
  rescheduleUpdate?: { oldValue?: ScheduledDates; newValue?: ScheduledDates };
  titleUpdate?: { oldValue?: string | null; newValue?: string | null };
  /** Its values are version counters, so the entry says the description changed but not how. */
  descriptionUpdate?: unknown;
}

interface StreamEntry {
  id?: string;
  authors?: StreamAuthor[];
  createdDate?: number;
  comment?: string | null;
  updates?: StreamUpdate[];
}

interface StreamResponse {
  entries?: StreamEntry[];
  hasOlderChanges?: boolean;
}

const authorName = (author: StreamAuthor | undefined): string =>
  [author?.firstName, author?.lastName].filter(Boolean).join(' ');

/** Wrike sends null on both sides for a date the change left alone, so only a null after a value means cleared. */
const describeDateChange = (label: string, oldDate?: string | null, newDate?: string | null): string => {
  if (newDate) return `${label} ${newDate}`;
  return oldDate ? `${label} cleared` : '';
};

const summarizeUpdate = (update: StreamUpdate): string => {
  if (update.statusUpdate) return `Status changed to "${update.statusUpdate.newValue?.title ?? ''}"`;
  if (update.assigneeUpdate) {
    const names = (update.assigneeUpdate.newValue ?? []).map(authorName).filter(Boolean).join(', ');
    return `Assignee ${update.assigneeUpdate.action === 'Remove' ? 'removed' : 'added'}: ${names}`;
  }
  if (update.parentsUpdate) {
    const names = (update.parentsUpdate.newValue ?? [])
      .map(folder => folder.name ?? '')
      .filter(Boolean)
      .join(', ');
    return `${update.parentsUpdate.action === 'Remove' ? 'Removed from' : 'Added to'} folder: ${names}`;
  }
  if (update.rescheduleUpdate) {
    const { oldValue, newValue } = update.rescheduleUpdate;
    const dates = [
      describeDateChange('start', oldValue?.startDate, newValue?.startDate),
      describeDateChange('finish', oldValue?.finishDate, newValue?.finishDate),
    ].filter(Boolean);
    return dates.length > 0 ? `Dates changed: ${dates.join(', ')}` : 'Dates changed';
  }
  if (update.titleUpdate) {
    return `Title changed from "${update.titleUpdate.oldValue ?? ''}" to "${update.titleUpdate.newValue ?? ''}"`;
  }
  if (update.descriptionUpdate) return 'Description edited';
  const keys = Object.keys(update);
  const updateKeys = keys.filter(key => key.endsWith('Update'));
  const unknown = updateKeys.length > 0 ? updateKeys : keys;
  return unknown.length > 0 ? `[unsupported: ${unknown.join(', ')}]` : '';
};

const isoFromEpoch = (epochMs: number | undefined): string => {
  if (typeof epochMs !== 'number') return '';
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

export const listTaskComments = defineTool({
  name: 'list_task_comments',
  displayName: 'List Task Comments',
  description:
    'List the comments and activity history for a task, newest first. Each entry has the author, timestamp, the comment text (HTML, empty for system events), and a summary of any changes (status, assignee, dates, folder moves, title, description; any other change appears as [unsupported: <type>]). This is the full activity stream Wrike shows in the task comments panel.',
  summary: 'List comments and activity on a task',
  icon: 'message-square',
  group: 'Comments',
  input: z.object({
    task_id: z.string().describe('The task id (numeric Wrike id)'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum entries to return (default 25)'),
  }),
  output: z.object({
    entries: z
      .array(
        z.object({
          id: z.string().describe('Stream entry id'),
          author: userSchema.describe('Author of the comment or change (email is not available in the stream)'),
          created_at: z.string().describe('ISO 8601 timestamp'),
          text: z.string().describe('Comment text as HTML, or empty for a system event'),
          changes: z.array(z.string()).describe('Human-readable summaries of non-comment changes in this entry'),
        }),
      )
      .describe('Activity stream entries, newest first'),
    has_older: z.boolean().describe('Whether more (older) entries exist beyond the returned set'),
  }),
  handle: async params => {
    const limit = params.limit ?? 25;
    const data = await rpc<StreamResponse>('stream_get_initial_data', {
      entityId: Number(params.task_id),
      entriesLimit: limit,
    });

    // Wrike returns the newest `limit` entries in oldest-first order.
    const newestFirst = [...(data.entries ?? [])].sort((a, b) => (b.createdDate ?? 0) - (a.createdDate ?? 0));
    const entries = newestFirst.map(entry => {
      const author = entry.authors?.[0];
      return {
        id: entry.id ?? '',
        author: { id: author?.uid ?? '', name: authorName(author), email: '' },
        created_at: isoFromEpoch(entry.createdDate),
        text: entry.comment ?? '',
        changes: (entry.updates ?? []).map(summarizeUpdate).filter(Boolean),
      };
    });

    return { entries, has_older: data.hasOlderChanges ?? false };
  },
});
