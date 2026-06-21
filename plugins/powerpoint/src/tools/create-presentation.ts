import { defineTool, parseRetryAfterMs, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { BLANK_PPTX_BASE64 } from '../blank-pptx.js';
import { GRAPH_BASE, requireAuth } from '../powerpoint-api.js';
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

    // Use raw fetch because the api() helper only supports JSON request bodies.
    // This endpoint requires a binary PUT with the PPTX Content-Type.
    const url = `${GRAPH_BASE}/drives/${driveId}/${parentPath}:/${encodeURIComponent(name)}:/content`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': PPTX_MIME,
        },
        body: new Blob([blankPptxBuffer()], { type: PPTX_MIME }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'TimeoutError')
        throw ToolError.timeout('Timed out creating presentation');
      throw ToolError.internal(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const errorBody = (await response.text().catch(() => '')).substring(0, 512);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const retryMs = retryAfter !== null ? parseRetryAfterMs(retryAfter) : undefined;
        throw ToolError.rateLimited(`Rate limited: ${errorBody}`, retryMs);
      }
      if (response.status === 401 || response.status === 403) throw ToolError.auth(`Auth error: ${errorBody}`);
      if (response.status === 409) throw ToolError.validation(`Conflict — file may already exist: ${errorBody}`);
      throw ToolError.internal(`Failed to create presentation (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as RawDriveItem;
    return { item: mapDriveItem(data) };
  },
});
