import { defineTool, SAVE_FILE_PATH_FORMAT, saveLocalFile, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from '../retool-api.js';
import { blobToBase64, getCurrentSourceControlBranchName, serializeToolscriptArchive } from '../toolscript.js';

const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export const exportToolscriptArchive = defineTool({
  name: 'export_toolscript_archive',
  displayName: 'Export Toolscript Archive',
  description:
    "Export a Retool app as a Toolscript ZIP archive using Retool's own browser-side archive serializer and write it to save_to on this computer. " +
    'The ZIP never passes through the conversation: unzip and edit it locally, re-zip it, then pass its path as archive_path to ' +
    'create_app_from_toolscript_archive or update_app_from_toolscript_archive.',
  summary: 'Export a Retool app as a Toolscript ZIP to a path',
  icon: 'download',
  group: 'Apps',
  input: z.object({
    page_uuid: z.string().describe('App UUID to export'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the ZIP archive to, including the file name, e.g. "C:\\Users\\me\\retool\\my-app.zip". ' +
          'The folder must exist; an existing file at the path is overwritten.',
      ),
    branch_name: z
      .string()
      .optional()
      .describe(
        'Optional source-control branch name to export. Defaults to the branch in the targeted editor URL, if present.',
      ),
    per_page_position_json_files: z
      .boolean()
      .optional()
      .describe('Whether to emit per-page position JSON files in the archive (default true).'),
  }),
  output: z.object({
    saved_to: z.string().describe('Path the ZIP archive was written to'),
    file_name: z.string().describe('File name of the written ZIP archive'),
    mime_type: z.string().describe('MIME type of the archive'),
    size_bytes: z.number().int().describe('Size of the ZIP archive in bytes'),
  }),
  handle: async (params, context) => {
    context?.reportProgress({ progress: 1, total: 3, message: 'Fetching Retool export data...' });

    const branchName = params.branch_name ?? getCurrentSourceControlBranchName() ?? undefined;
    const data = await api<{
      uuid?: string;
      page?: unknown;
      modules?: Record<string, unknown>;
    }>(`/api/pages/uuids/${params.page_uuid}/export`, {
      method: 'POST',
      query: { branch: branchName },
    });

    if (!data.page) throw ToolError.internal('Retool export response did not include page data.');

    context?.reportProgress({ progress: 2, total: 3, message: 'Serializing Toolscript ZIP...' });

    const archive = await serializeToolscriptArchive({
      pageUuid: params.page_uuid,
      exportData: {
        uuid: data.uuid ?? params.page_uuid,
        page: data.page,
        modules: data.modules ?? {},
      },
      perPagePositionJsonFiles: params.per_page_position_json_files ?? true,
    });

    context?.reportProgress({ progress: 3, total: 3, message: 'Saving ZIP...' });

    saveLocalFile(context, params.save_to, await blobToBase64(archive));

    return {
      saved_to: params.save_to,
      file_name: fileNameOf(params.save_to),
      mime_type: 'application/zip',
      size_bytes: archive.size,
    };
  },
});
