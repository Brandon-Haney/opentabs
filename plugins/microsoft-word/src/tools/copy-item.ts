import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../microsoft-word-api.js';

export const copyItem = defineTool({
  name: 'copy_item',
  displayName: 'Copy Item',
  description:
    'Copy a file or folder. The copy operation is asynchronous — returns success immediately. The new copy appears in the destination folder shortly after.',
  summary: 'Copy a file or folder',
  icon: 'copy',
  group: 'Files',
  input: z.object({
    item_id: z.string().describe('ID of the file or folder to copy'),
    destination_id: z.string().describe('ID of the destination folder'),
    name: z.string().optional().describe('New name for the copy — defaults to original name'),
  }),
  output: z.object({
    success: z.boolean().describe('Whether the copy operation was accepted'),
  }),
  handle: async params => {
    const body: Record<string, unknown> = {
      parentReference: { id: params.destination_id },
    };
    if (params.name !== undefined) body.name = params.name;

    // Graph answers 202 Accepted with no body. Each POST starts another copy,
    // so the request keeps the default no-replay policy on transient failures.
    await api(`/me/drive/items/${params.item_id}/copy`, { method: 'POST', body });
    return { success: true };
  },
});
