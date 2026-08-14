import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, requireDriveId } from '../powerpoint-api.js';
import { driveIdInput, driveSchema, mapDrive, type RawDrive } from './schemas.js';

export const getDrive = defineTool({
  name: 'get_drive',
  displayName: 'Get Drive Info',
  description: 'Get OneDrive storage information including total capacity, used space, and remaining quota.',
  summary: 'Get drive storage quota info',
  icon: 'hard-drive',
  group: 'Drive',
  input: z.object({
    drive_id: driveIdInput,
  }),
  output: z.object({
    drive: driveSchema.describe('Drive storage information'),
  }),
  handle: async params => {
    const driveId = await requireDriveId(params.drive_id);
    const data = await api<RawDrive>(`/drives/${driveId}`, {
      query: { $select: 'id,name,driveType,quota' },
    });
    return { drive: mapDrive(data) };
  },
});
