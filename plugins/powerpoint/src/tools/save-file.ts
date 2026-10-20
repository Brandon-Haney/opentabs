import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  api,
  encodeBase64,
  FILE_DOWNLOAD_TIMEOUT_MS,
  fetchDownloadUrl,
  graphFetch,
  requireDriveId,
} from '../powerpoint-api.js';
import { driveIdInput, type RawDriveItem } from './schemas.js';

/** Formats Graph converts a file to on download, with the MIME type of each. */
const CONVERSION_CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  png: 'image/png',
} as const;

type ConversionFormat = keyof typeof CONVERSION_CONTENT_TYPES;

/** The file name a conversion produces: the original name with the format's extension. */
export const convertedFileName = (name: string, format: ConversionFormat): string => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${format}`;
};

const sizeLimitError = (name: string, size: number): ToolError =>
  ToolError.validation(
    `"${name}" is ${(size / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at most ` +
      `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB.`,
  );

export const saveFile = defineTool({
  name: 'save_file',
  displayName: 'Save File',
  description:
    'Download a file by its item ID and write it to save_to. The file never passes through the browser Downloads ' +
    'folder or the conversation. Optionally have Microsoft convert it first — pdf, jpg, or png; a presentation ' +
    'converts to pdf, and Microsoft refuses a format it cannot produce from the file. To read a file without ' +
    'keeping it, save it to your temporary or scratch directory, parse it there, and delete it when done.',
  summary: 'Save a file to a path',
  icon: 'download',
  group: 'Files',
  input: z.object({
    drive_id: driveIdInput,
    item_id: z.string().describe('Item ID of the file'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the file to, including the file name (e.g. a file in your temporary directory). ' +
          'The folder must exist; an existing file at the path is overwritten.',
      ),
    format: z
      .enum(['pdf', 'jpg', 'png'])
      .optional()
      .describe('Convert to this format before saving — pdf, jpg, or png. Omit to save the original file.'),
  }),
  output: z.object({
    saved_to: z.string().describe('Path the file was written to'),
    name: z.string().describe('File name, with the converted extension when format was given'),
    size: z.number().describe('Bytes written'),
    content_type: z.string().describe('MIME type of the bytes written'),
  }),
  handle: async (params, context) => {
    const driveId = await requireDriveId(params.drive_id);
    const itemPath = `/drives/${driveId}/items/${params.item_id}`;
    // @microsoft.graph.downloadUrl is a derived property excluded by $select, so the full item is read.
    const item = await api<RawDriveItem>(itemPath);
    const originalName = item.name ?? 'file';
    if (item.folder !== undefined) throw ToolError.validation(`"${originalName}" is a folder, not a file.`);

    let bytes: Uint8Array;
    let name: string;
    let contentType: string;
    if (params.format === undefined) {
      if ((item.size ?? 0) > MAX_LOCAL_FILE_BYTES) throw sizeLimitError(originalName, item.size ?? 0);
      const downloadUrl = item['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) throw ToolError.internal(`Graph returned no download URL for "${originalName}".`);
      const response = await fetchDownloadUrl(downloadUrl, { timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS });
      bytes = new Uint8Array(await response.arrayBuffer());
      name = originalName;
      contentType = item.file?.mimeType ?? 'application/octet-stream';
    } else {
      // A conversion has no pre-authenticated URL; `/content?format=` needs the bearer token.
      const response = await graphFetch(`${itemPath}/content`, {
        query: { format: params.format },
        timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
      });
      bytes = new Uint8Array(await response.arrayBuffer());
      name = convertedFileName(originalName, params.format);
      contentType = CONVERSION_CONTENT_TYPES[params.format];
      if (bytes.length > MAX_LOCAL_FILE_BYTES) throw sizeLimitError(name, bytes.length);
    }

    saveLocalFile(context, params.save_to, encodeBase64(bytes));
    return { saved_to: params.save_to, name, size: bytes.length, content_type: contentType };
  },
});
