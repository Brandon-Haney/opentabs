import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { BLANK_PPTX_BASE64 } from '../blank-pptx.js';
import { graphFetch, requireAuth } from '../powerpoint-api.js';
import { driveItemSchema, mapDriveItem, type RawDriveItem } from './schemas.js';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Decode the embedded blank-PPTX template into a fresh ArrayBuffer for upload. */
const blankPptxBuffer = (): ArrayBuffer => {
  const binary = atob(BLANK_PPTX_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

export const createPresentation = defineTool({
  name: 'create_presentation',
  displayName: 'Create Presentation',
  description:
    'Create a new blank PowerPoint presentation (.pptx) with one empty slide in OneDrive. Specify a name and optional parent folder. Returns the created file details. The result is a valid, immediately editable presentation.',
  summary: 'Create a new blank presentation',
  icon: 'file-plus',
  group: 'Presentations',
  input: z.object({
    name: z.string().describe('File name without extension — .pptx is appended automatically'),
    folder_id: z.string().optional().describe('Parent folder item ID — defaults to root'),
  }),
  output: z.object({
    item: driveItemSchema.describe('Created presentation file details'),
  }),
  handle: async params => {
    const name = params.name.endsWith('.pptx') ? params.name : `${params.name}.pptx`;
    const { token, driveId } = await requireAuth();
    const parentPath = params.folder_id ? `items/${params.folder_id}` : 'root';

    // Replaying this PUT is safe: a content PUT to a path replaces by default,
    // so a second attempt after a hidden success writes the same blank bytes to
    // the same file. Sending `@microsoft.graph.conflictBehavior=rename` would
    // make every replay create another file and would require dropping
    // `retryNonIdempotent`.
    const response = await graphFetch(`/drives/${driveId}/${parentPath}:/${encodeURIComponent(name)}:/content`, {
      method: 'PUT',
      body: new Blob([blankPptxBuffer()], { type: PPTX_MIME }),
      contentType: PPTX_MIME,
      token,
      retryNonIdempotent: true,
    });
    const data = (await response.json()) as RawDriveItem;
    return { item: mapDriveItem(data) };
  },
});
