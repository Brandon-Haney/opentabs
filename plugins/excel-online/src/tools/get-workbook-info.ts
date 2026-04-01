import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, getWorkbookContext, hasGraphAuth, isSharePoint, sharepointGetFileInfo } from '../excel-api.js';
import { workbookInfoSchema } from './schemas.js';

export const getWorkbookInfo = defineTool({
  name: 'get_workbook_info',
  displayName: 'Get Workbook Info',
  description:
    'Get information about the currently open Excel workbook including drive ID, item ID, and file name. Returns context needed by other tools. The workbook must be open in the browser.',
  summary: 'Get current workbook metadata',
  icon: 'file-spreadsheet',
  group: 'Workbook',
  input: z.object({}),
  output: z.object({ workbook: workbookInfoSchema }),
  handle: async () => {
    if (isSharePoint() && !hasGraphAuth()) {
      const info = await sharepointGetFileInfo();
      return { workbook: { drive_id: info.driveId, item_id: info.itemId, name: info.name } };
    }

    const ctx = getWorkbookContext();
    if (!ctx) {
      throw ToolError.validation('No workbook is currently open. Please open an Excel workbook in the browser first.');
    }

    const data = await api<{ id?: string; name?: string }>(
      `/drives/${ctx.driveId}/items/${encodeURIComponent(ctx.itemId)}`,
    );

    return {
      workbook: {
        drive_id: ctx.driveId,
        item_id: ctx.itemId,
        name: data.name ?? '',
      },
    };
  },
});
