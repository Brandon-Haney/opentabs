import { defineTool, readLocalFile } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../retool-api.js';
import { compileToolscriptArchive } from '../toolscript.js';
import { toolscriptArchivePathSchema } from './schemas.js';

const warningSchema = z.string().describe('Warning about Retool Toolscript import behavior');

export const createAppFromToolscriptArchive = defineTool({
  name: 'create_app_from_toolscript_archive',
  displayName: 'Create App from Toolscript Archive',
  description:
    "Create a new Retool app from a Toolscript ZIP archive on this computer, named by archive_path (for example one written by export_toolscript_archive with save_to and edited locally). The tool uses Retool's own browser-side Toolscript compiler to turn the ZIP into a Transit appState string, then calls Retool's create page API. The archive determines whether the result is a web app, mobile app, or module.",
  summary: 'Create a Retool app from a Toolscript ZIP on disk',
  icon: 'file-plus',
  group: 'Apps',
  input: z.object({
    name: z.string().describe('Name for the new Retool app'),
    folder_id: z.number().describe('Folder ID to create the app in (use list_apps to find folder IDs)'),
    archive_path: toolscriptArchivePathSchema,
  }),
  output: z.object({
    page_uuid: z.string().describe('UUID of the created Retool page'),
    save_id: z.number().describe('ID of the initial save record'),
    is_global_widget: z.boolean().describe('Whether the archive created a module/global widget'),
    is_mobile_app: z.boolean().describe('Whether the archive created a mobile app'),
    multi_screen_mobile_app: z.boolean().describe('Whether the archive created a multi-screen mobile app'),
    warnings: z.array(warningSchema).describe('Warnings about Retool Toolscript import limitations'),
  }),
  handle: async (params, context) => {
    context?.reportProgress({ progress: 1, total: 2, message: 'Compiling Toolscript archive...' });

    const archive = readLocalFile(context, params.archive_path);
    const compiled = await compileToolscriptArchive(archive.contentBase64, archive.name);

    context?.reportProgress({ progress: 2, total: 2, message: 'Creating Retool app...' });

    const data = await api<{
      save?: { id?: number };
      page?: { uuid?: string };
    }>('/api/pages/createPage', {
      method: 'POST',
      body: {
        appState: compiled.appState,
        pageName: params.name,
        folderId: params.folder_id,
        isGlobalWidget: compiled.isGlobalWidget,
        modules: {},
        isMobileApp: compiled.isMobileApp,
        multiScreenMobileApp: compiled.multiScreenMobileApp,
      },
    });

    return {
      page_uuid: data.page?.uuid ?? '',
      save_id: data.save?.id ?? 0,
      is_global_widget: compiled.isGlobalWidget,
      is_mobile_app: compiled.isMobileApp,
      multi_screen_mobile_app: compiled.multiScreenMobileApp,
      warnings: compiled.warnings,
    };
  },
});
