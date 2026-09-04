import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { graphFetch } from '../microsoft-word-api.js';
import { driveItemSchema, mapDriveItem, type RawDriveItem } from './schemas.js';

export const uploadFile = defineTool({
  name: 'upload_file',
  displayName: 'Upload File',
  description:
    'Upload a text file to OneDrive. Creates a new file or overwrites existing. Specify the full path relative to drive root (e.g., "Documents/report.txt").',
  summary: 'Upload a text file to OneDrive',
  icon: 'upload',
  group: 'Files',
  input: z.object({
    path: z.string().min(1).describe('File path relative to drive root (e.g., "Documents/report.txt")'),
    content: z.string().describe('File content as text'),
    content_type: z.string().optional().describe('MIME type (default "text/plain")'),
  }),
  output: z.object({
    item: driveItemSchema.describe('The uploaded file'),
  }),
  handle: async params => {
    const encodedPath = encodeURIComponent(params.path).replace(/%2F/g, '/');

    // The PUT replays on a transient failure: with Graph's default
    // conflictBehavior (replace) a replay writes the same content to the same
    // path. Adding conflictBehavior=rename would make a replay create a
    // renamed duplicate, so it must come with retryNonIdempotent removed.
    const response = await graphFetch(`/me/drive/root:/${encodedPath}:/content`, {
      method: 'PUT',
      body: params.content,
      contentType: params.content_type ?? 'text/plain',
      retryNonIdempotent: true,
    });

    const data = (await response.json()) as RawDriveItem;
    return { item: mapDriveItem(data) };
  },
});
