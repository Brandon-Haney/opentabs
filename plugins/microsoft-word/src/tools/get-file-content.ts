import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api, fetchDownloadUrl, METADATA_TIMEOUT_MS } from '../microsoft-word-api.js';

export const getFileContent = defineTool({
  name: 'get_file_content',
  displayName: 'Get File Content',
  description:
    'Read text content of a file by its ID. Works with text-based files (.txt, .md, .csv, .html, .json, .xml, .yaml, .log, etc.). For Word documents (.docx), use get_document_text instead.',
  summary: 'Read text content of a file',
  icon: 'file-code',
  group: 'Files',
  input: z.object({
    item_id: z.string().describe('File ID'),
  }),
  output: z.object({
    content: z.string().describe('File text content'),
    size: z.number().describe('Content size in bytes'),
  }),
  handle: async params => {
    const meta = await api<{ '@microsoft.graph.downloadUrl'?: string }>(`/me/drive/items/${params.item_id}`, {
      timeoutMs: METADATA_TIMEOUT_MS,
    });

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw ToolError.internal('No download URL available for this file.');
    }

    const response = await fetchDownloadUrl(downloadUrl);
    const content = await response.text();
    return {
      content,
      size: content.length,
    };
  },
});
