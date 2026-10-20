import { defineTool, SAVE_FILE_PATH_FORMAT, saveLocalFile } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { downloadSharedFile } from '../outlook-api.js';

export const getSharedFile = defineTool({
  name: 'get_shared_file',
  displayName: 'Get Shared File',
  description:
    'Save a OneDrive or SharePoint file that an email links to (a link in the message body, e.g. ' +
    '"https://contoso.sharepoint.com/:x:/g/personal/..."), using your Microsoft 365 access. Safe Links-wrapped URLs ' +
    'are unwrapped automatically. The file is written straight to save_to and never passes through the browser ' +
    'Downloads folder. To read a file without keeping it, save it to your temporary or scratch directory, parse it ' +
    'there, and delete it when done. Use get_attachment_content for files attached to the message.',
  summary: 'Save a linked OneDrive or SharePoint file to a path',
  icon: 'cloud-download',
  group: 'Messages',
  input: z.object({
    url: z.string().url().describe('The OneDrive or SharePoint sharing URL, as it appears in the message body'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the file to, including the file name — e.g. a file in your temporary directory. ' +
          'The folder must exist; an existing file at the path is overwritten.',
      ),
  }),
  output: z.object({
    name: z.string().describe('File name'),
    content_type: z.string().describe('MIME type'),
    size: z.number().describe('Size in bytes'),
    saved_to: z.string().describe('Path the file was written to'),
    web_url: z.string().describe('The file in OneDrive or SharePoint'),
  }),
  handle: async (params, context) => {
    const file = await downloadSharedFile(params.url);
    saveLocalFile(context, params.save_to, file.contentBase64);
    return {
      name: file.name,
      content_type: file.contentType,
      size: file.size,
      saved_to: params.save_to,
      web_url: file.webUrl,
    };
  },
});
