import { defineTool } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { attachmentUrl, getAccountId, listTaskAttachments, type RawAttachment } from '../wrike-api.js';

const attachmentSchema = z.object({
  id: z.string().describe('Attachment id, used with get_attachment to download'),
  name: z.string().describe('File name'),
  size: z.number().int().describe('File size in bytes, or 0 if unknown'),
  media_type: z.string().describe('Media type: Image, Document, Video, etc., or empty'),
  uploaded: z.string().describe('Upload time (ISO 8601), or empty if unknown'),
  author: z.string().describe('Name of the user who uploaded the file, or empty'),
  version_count: z.number().int().describe('Number of active versions of this file'),
  permalink: z.string().describe('Permalink token identifying the file version'),
  preview_url: z.string().describe('Thumbnail URL (loads with the active Wrike session), or empty if none'),
  download_url: z
    .string()
    .describe('URL that downloads the file; open it in the browser, where the Wrike session applies'),
});

const fullName = (author: { firstName?: string; lastName?: string } | undefined): string =>
  [author?.firstName, author?.lastName].filter(Boolean).join(' ');

const isoFromEpoch = (ms: number | undefined): string =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : '';

const mapAttachment = (raw: RawAttachment, accountId: string | null): z.infer<typeof attachmentSchema> => {
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : '';
  const version = raw.currentVersion;
  const storageAddress = raw.versions?.[0]?.storageAddress ?? '';
  const previewUrl =
    version?.hasThumbnail && storageAddress && id && accountId
      ? `${storageAddress}/filemeta/thumb800/F${id}.A${accountId}`
      : '';
  return {
    id,
    name: typeof raw.title === 'string' ? raw.title : '',
    size: typeof version?.fileSize === 'number' ? version.fileSize : 0,
    media_type: raw.versions?.[0]?.mediaType ?? '',
    uploaded: isoFromEpoch(version?.date ?? version?.createdTimestamp),
    author: fullName(version?.author),
    version_count: typeof raw.activeVersionsCount === 'number' ? raw.activeVersionsCount : 0,
    permalink: typeof version?.permalink === 'string' ? version.permalink : '',
    preview_url: previewUrl,
    download_url: id ? attachmentUrl(id) : '',
  };
};

export const listAttachments = defineTool({
  name: 'list_attachments',
  displayName: 'List Attachments',
  description:
    'List the files attached to a task. Returns each attachment with its id, file name, size, media type, upload time, uploader, and a thumbnail preview URL (for images). Pass an attachment id to get_attachment to save that file to a path.',
  summary: 'List files attached to a task',
  icon: 'paperclip',
  group: 'Tasks',
  input: z.object({
    task_id: z.string().describe('The task id'),
  }),
  output: z.object({
    attachments: z.array(attachmentSchema).describe('Files attached to the task'),
    count: z.number().int().describe('Number of attachments'),
  }),
  handle: async params => {
    const accountId = getAccountId();
    const attachments = (await listTaskAttachments(Number(params.task_id))).map(raw => mapAttachment(raw, accountId));
    return { attachments, count: attachments.length };
  },
});
