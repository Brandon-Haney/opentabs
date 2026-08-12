import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../makerworld-api.js';
import type { MakerWorldList } from './schemas.js';

interface RawDraft {
  id?: number;
  title?: string;
  cover?: string;
  coverUrl?: string;
  status?: number;
  createTime?: string;
  updateTime?: string;
}

export const listDrafts = defineTool({
  name: 'list_drafts',
  displayName: 'List Drafts',
  description:
    'List unpublished model drafts, including drafts created by upload_model that have not been submitted yet. Returns the draft IDs needed by publish_draft and delete_draft.',
  summary: 'List unpublished model drafts',
  icon: 'file-pen',
  group: 'Uploads',
  input: z.object({
    offset: z.number().int().min(0).optional().describe('Number of drafts to skip (default 0)'),
    limit: z.number().int().min(1).max(100).optional().describe('Drafts per page (default 20, max 100)'),
  }),
  output: z.object({
    drafts: z
      .array(
        z.object({
          id: z.number().describe('Draft ID'),
          title: z.string().describe('Draft title'),
          cover_url: z.string().describe('Cover image URL, empty if none set'),
          status: z.number().describe('Draft status code'),
          created_at: z.string().describe('ISO 8601 creation timestamp'),
          updated_at: z.string().describe('ISO 8601 last-update timestamp'),
        }),
      )
      .describe('Unpublished drafts'),
    total: z.number().describe('Total number of drafts'),
  }),
  handle: async params => {
    const data = await api<MakerWorldList<RawDraft>>('design-service', '/my/drafts', {
      query: { offset: params.offset ?? 0, limit: params.limit ?? 20 },
    });

    return {
      drafts: (data.hits ?? []).map(d => ({
        id: d.id ?? 0,
        title: d.title ?? '',
        cover_url: d.coverUrl ?? d.cover ?? '',
        status: d.status ?? 0,
        created_at: d.createTime ?? '',
        updated_at: d.updateTime ?? '',
      })),
      total: data.total ?? 0,
    };
  },
});
