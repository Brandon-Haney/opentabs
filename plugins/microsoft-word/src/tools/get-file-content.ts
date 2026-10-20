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
  METADATA_TIMEOUT_MS,
} from '../microsoft-word-api.js';

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/yaml',
]);

const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.tsv', '.html', '.htm', '.json', '.xml', '.yaml', '.yml', '.log'];

/**
 * Whether a file is text whose content reads usefully inline. The extension
 * counts as much as the MIME type: OneDrive reports a .csv as
 * application/vnd.ms-excel.
 */
const isTextFile = (name: string, mimeType: string): boolean =>
  mimeType.startsWith('text/') ||
  mimeType.endsWith('+json') ||
  mimeType.endsWith('+xml') ||
  TEXT_CONTENT_TYPES.has(mimeType) ||
  TEXT_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension));

/** The driveItem fields read before a download. */
interface DownloadableItem {
  name?: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: unknown;
  '@microsoft.graph.downloadUrl'?: string;
}

export const getFileContent = defineTool({
  name: 'get_file_content',
  displayName: 'Get File Content',
  description:
    'Read a file by its ID. Without save_to, returns the text of a text-based file (.txt, .md, .csv, .html, ' +
    '.json, .xml, .yaml, .log, etc.). Any other file (Word, PDF, Excel, PowerPoint, images) requires save_to: the ' +
    'raw file is written straight to that path and never passes through the browser Downloads folder. To read ' +
    'such a file without keeping it, save it to your temporary or scratch directory, parse it there, and delete it ' +
    'when done. For the text of a Word document (.docx), get_document_text needs no file.',
  summary: 'Read a text file or save any file to a path',
  icon: 'file-code',
  group: 'Files',
  input: z.object({
    item_id: z.string().describe('File ID'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .optional()
      .describe(
        'Absolute path to write the file to, including the file name (e.g. a file in your temporary directory). ' +
          'The folder must exist; an existing file at the path is overwritten. Required for any file that is not ' +
          'text.',
      ),
  }),
  output: z.object({
    content: z.string().optional().describe('File text content (present when save_to was not given)'),
    size: z.number().describe('Content size: characters of text, or bytes written when save_to was given'),
    saved_to: z.string().optional().describe('Path the file was written to (present when save_to was given)'),
    name: z.string().optional().describe('File name (present when save_to was given)'),
    content_type: z.string().optional().describe('MIME type (present when save_to was given)'),
  }),
  handle: async (params, context) => {
    const meta = await api<DownloadableItem>(`/me/drive/items/${params.item_id}`, {
      timeoutMs: METADATA_TIMEOUT_MS,
    });

    const name = meta.name ?? '';
    if (meta.folder !== undefined) {
      throw ToolError.validation(`"${name}" is a folder, not a file.`);
    }

    const mimeType = meta.file?.mimeType ?? 'application/octet-stream';
    if (params.save_to === undefined && !isTextFile(name, mimeType)) {
      throw ToolError.validation(
        `"${name}" (${mimeType}) is not a text file. Pass save_to with an absolute path in your temporary ` +
          'directory, read the file from there, and delete it when done.',
      );
    }

    if (params.save_to !== undefined && (meta.size ?? 0) > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `"${name}" is ${((meta.size ?? 0) / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at most ` +
          `${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB.`,
      );
    }

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw ToolError.internal('No download URL available for this file.');
    }

    if (params.save_to === undefined) {
      const response = await fetchDownloadUrl(downloadUrl);
      const content = await response.text();
      return { content, size: content.length };
    }

    const response = await fetchDownloadUrl(downloadUrl, { timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS });
    const bytes = new Uint8Array(await response.arrayBuffer());
    saveLocalFile(context, params.save_to, encodeBase64(bytes));
    return {
      saved_to: params.save_to,
      size: bytes.length,
      name,
      content_type: mimeType,
    };
  },
});
