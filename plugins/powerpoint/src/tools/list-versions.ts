import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput, type GraphCollection, mapVersion, type RawVersion, versionSchema } from './schemas.js';

export const listVersions = defineTool({
  name: 'list_versions',
  displayName: 'List File Versions',
  description: 'List version history of a file. Returns all saved versions with modifier, timestamp, and size.',
  summary: 'List version history of a file',
  icon: 'history',
  group: 'Files',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file'),
  }),
  output: z.object({
    versions: z.array(versionSchema).describe('Version history entries'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const data = await api<GraphCollection<RawVersion>>(`/drives/${driveId}/items/${params.item_id}/versions`);
    return { versions: (data.value ?? []).map(mapVersion) };
  },
});
