import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { buildDocx, DOCX_MIME, toArrayBuffer } from '../docx-utils.js';
import { graphFetch } from '../microsoft-word-api.js';
import { driveItemSchema, mapDriveItem, type RawDriveItem } from './schemas.js';

export const createDocument = defineTool({
  name: 'create_document',
  displayName: 'Create Document',
  description:
    'Create a new Word document (.docx) with the given text content. Each string in the paragraphs array becomes a separate paragraph in the document. The file is created at the specified path in OneDrive.',
  summary: 'Create a new Word document with text',
  icon: 'file-plus',
  group: 'Documents',
  input: z.object({
    path: z
      .string()
      .min(1)
      .describe('File path relative to drive root, must end with .docx (e.g., "Documents/report.docx")'),
    paragraphs: z.array(z.string()).min(1).describe('Array of text paragraphs for the document content'),
  }),
  output: z.object({
    item: driveItemSchema.describe('The created document'),
  }),
  handle: async params => {
    const encodedPath = encodeURIComponent(params.path).replace(/%2F/g, '/');

    // The PUT replays on a transient failure: with Graph's default
    // conflictBehavior (replace) a replay writes the same bytes to the same
    // path. Adding conflictBehavior=rename would make a replay create a
    // renamed duplicate, so it must come with retryNonIdempotent removed.
    const response = await graphFetch(`/me/drive/root:/${encodedPath}:/content`, {
      method: 'PUT',
      body: toArrayBuffer(buildDocx(params.paragraphs)),
      contentType: DOCX_MIME,
      retryNonIdempotent: true,
    });

    const data = (await response.json()) as RawDriveItem;
    return { item: mapDriveItem(data) };
  },
});
