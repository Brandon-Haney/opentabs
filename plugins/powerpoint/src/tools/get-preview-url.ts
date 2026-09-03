import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput } from './schemas.js';

export const getPreviewUrl = defineTool({
  name: 'get_preview_url',
  displayName: 'Get Preview URL',
  description:
    'Get an embeddable preview URL for a file. The URL can be used to embed a read-only preview of the presentation in an iframe.',
  summary: 'Get an embeddable preview URL',
  icon: 'eye',
  group: 'Presentations',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file'),
  }),
  output: z.object({
    url: z.string().describe('Embeddable preview URL'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    // `/preview` is a POST only because it takes options; it reads the item
    // and changes nothing, so replaying it is safe.
    const data = await api<{ getUrl?: string }>(`/drives/${driveId}/items/${params.item_id}/preview`, {
      method: 'POST',
      body: {},
      retryNonIdempotent: true,
    });
    return { url: data.getUrl ?? '' };
  },
});
