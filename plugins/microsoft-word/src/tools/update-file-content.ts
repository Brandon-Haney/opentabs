import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { graphFetch } from '../microsoft-word-api.js';
import { driveItemSchema, mapDriveItem, type RawDriveItem } from './schemas.js';

export const updateFileContent = defineTool({
  name: 'update_file_content',
  displayName: 'Update File Content',
  description: 'Update the content of an existing file by its ID.',
  summary: "Update a file's content",
  icon: 'file-pen',
  group: 'Files',
  input: z.object({
    item_id: z.string().describe('File ID'),
    content: z.string().describe('New file content'),
    content_type: z.string().optional().describe('MIME type (default "text/plain")'),
  }),
  output: z.object({
    item: driveItemSchema.describe('The updated file'),
  }),
  handle: async params => {
    // The PUT replays on a transient failure: the body is fixed, so a replay
    // after a hidden success writes the same content again.
    const response = await graphFetch(`/me/drive/items/${params.item_id}/content`, {
      method: 'PUT',
      body: params.content,
      contentType: params.content_type ?? 'text/plain',
      retryNonIdempotent: true,
    });

    const data = (await response.json()) as RawDriveItem;
    return { item: mapDriveItem(data) };
  },
});
