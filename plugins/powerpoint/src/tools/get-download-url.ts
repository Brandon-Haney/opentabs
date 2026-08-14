import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput, type RawDriveItem } from './schemas.js';

export const getDownloadUrl = defineTool({
  name: 'get_download_url',
  displayName: 'Get Download URL',
  description: 'Get a temporary download URL for a file. The URL is pre-authenticated and expires after a short time.',
  summary: 'Get a download URL for a file',
  icon: 'download',
  group: 'Files',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file'),
    format: z
      .enum(['pdf', 'jpg', 'png'])
      .optional()
      .describe('Convert to this format before downloading — pdf, jpg, or png. Omit for original format.'),
  }),
  output: z.object({
    download_url: z.string().describe('Pre-authenticated temporary download URL'),
    name: z.string().describe('File name'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);

    if (params.format) {
      return {
        download_url: `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${params.item_id}/content?format=${params.format}`,
        name: '',
      };
    }

    // @microsoft.graph.downloadUrl is a derived property excluded by $select — fetch the full item
    const data = await api<RawDriveItem>(`/drives/${driveId}/items/${params.item_id}`);
    return {
      download_url: data['@microsoft.graph.downloadUrl'] ?? '',
      name: data.name ?? '',
    };
  },
});
