import {
  LOCAL_FILE_PATH_FORMAT,
  type LocalFile,
  readLocalFile,
  ToolError,
  type ToolHandlerContext,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { api } from './jira-api.js';
import type { AdfNode } from './tools/adf.js';

/**
 * Adds files on the user's computer to Jira issues, and places images inside
 * comments. The caller names each file by its path; the OpenTabs server reads it and
 * delivers the bytes with the tool call, since the plugin runs in the page and cannot
 * read the disk itself.
 *
 * An image in a comment is an issue attachment the comment shows inline. Each file
 * is uploaded through the public attachments endpoint. The comment's ADF then points
 * at the attachment's Media Services file id with an empty `collection`, which is the
 * form Jira stores for images its own editor embeds. Media ids come from the issue's
 * attachment read credentials, the endpoint the issue view uses to show attachments.
 */

/** Widest an image is shown in a comment, matching the width Jira's editor gives a full-width image. */
const MAX_DISPLAY_WIDTH_PX = 686;

/** Uploads carry whole files, so they get longer than the default 30 s request budget. */
const UPLOAD_TIMEOUT_MS = 120_000;

/** How long an uploaded attachment may take to show up in the read credentials with its media id. */
const MEDIA_ID_ATTEMPTS = 5;
const MEDIA_ID_RETRY_MS = 1_000;

/** Input schema for a path to a file on the user's computer, read by the OpenTabs server. */
export const localFilePath = (example: string) =>
  z
    .string()
    .min(1)
    .meta({ format: LOCAL_FILE_PATH_FORMAT })
    .describe(
      `Absolute path of the file on this computer, e.g. "${example}". The file is read from disk — pass the path, never the contents.`,
    );

/** Shared input shape for one image placed in a comment. */
export const commentImageInputSchema = z.object({
  path: localFilePath('C:\\Users\\me\\Pictures\\screenshot.png'),
  alt: z.string().optional().describe("Alt text for the image (default: the file's name)"),
});

export type CommentImageInput = z.infer<typeof commentImageInputSchema>;

export const attachmentSchema = z.object({
  id: z.string().describe('Attachment ID'),
  filename: z.string().describe('File name'),
  size: z.number().describe('Size in bytes'),
  mime_type: z.string().describe('MIME type'),
});

export type Attachment = z.infer<typeof attachmentSchema>;

interface JiraAttachment {
  id?: string | number;
  filename?: string;
  size?: number;
  mimeType?: string;
}

const mapAttachment = (a: JiraAttachment): Attachment => ({
  id: String(a.id ?? ''),
  filename: a.filename ?? '',
  size: a.size ?? 0,
  mime_type: a.mimeType ?? '',
});

interface AttachmentReadCredentials {
  tokensWithFiles?: { files?: { attachmentId?: number | string; attachmentMediaApiId?: string }[] }[];
}

const decodeBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const toBlob = (file: LocalFile): Blob => new Blob([decodeBase64(file.contentBase64)], { type: file.contentType });

/** Read every delivered file up front, so a missing one fails the call before anything is uploaded. */
export const readLocalFiles = (context: ToolHandlerContext | undefined, paths: string[]): LocalFile[] =>
  paths.map(path => readLocalFile(context, path));

/** Read the delivered images, rejecting any file that is not an image. */
export const readCommentImages = (context: ToolHandlerContext | undefined, images: CommentImageInput[]): LocalFile[] =>
  images.map((image, index) => {
    const file = readLocalFile(context, image.path);
    if (!file.contentType.startsWith('image/')) {
      throw ToolError.validation(`Image ${index + 1} (${file.name}) is not an image file.`);
    }
    return file;
  });

const uploadAttachment = async (issueKey: string, file: LocalFile): Promise<Attachment> => {
  const form = new FormData();
  form.append('file', toBlob(file), file.name);
  const created = await api<JiraAttachment[]>(`/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: 'POST',
    form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  const attachment = Array.isArray(created) ? created[0] : undefined;
  if (!attachment) throw ToolError.internal(`Jira did not return an attachment for ${file.name}.`);
  return mapAttachment(attachment);
};

/**
 * Upload files to an issue as attachments, one request per file in order, reporting
 * progress before each so a long run keeps restarting the dispatch's no-progress budget.
 * A failure stops the run, leaving the files uploaded before it attached.
 */
export const uploadAttachments = async (
  issueKey: string,
  files: LocalFile[],
  context?: ToolHandlerContext,
): Promise<Attachment[]> => {
  const attachments: Attachment[] = [];
  for (const [index, file] of files.entries()) {
    context?.reportProgress({
      progress: index,
      total: files.length,
      message: `Uploading ${file.name} (${index + 1} of ${files.length})`,
    });
    attachments.push(await uploadAttachment(issueKey, file));
  }
  return attachments;
};

const fetchMediaIds = async (issueKey: string): Promise<Map<string, string>> => {
  const credentials = await api<AttachmentReadCredentials>(
    `/attachment/read/issue/${encodeURIComponent(issueKey)}/credentials`,
    { basePath: '/rest/api/2', query: { maxTokenLength: 65536 } },
  );
  const mediaIds = new Map<string, string>();
  for (const group of credentials.tokensWithFiles ?? []) {
    for (const file of group.files ?? []) {
      if (file.attachmentId !== undefined && file.attachmentMediaApiId) {
        mediaIds.set(String(file.attachmentId), file.attachmentMediaApiId);
      }
    }
  }
  return mediaIds;
};

/**
 * Look up the Media Services file id of each attachment, waiting briefly for ones
 * the credentials do not list yet.
 */
export const getMediaIds = async (issueKey: string, attachmentIds: string[]): Promise<string[]> => {
  for (let attempt = 1; ; attempt++) {
    const mediaIds = await fetchMediaIds(issueKey);
    const missing = attachmentIds.filter(id => !mediaIds.has(id));
    if (missing.length === 0) return attachmentIds.map(id => mediaIds.get(id) ?? '');
    if (attempt === MEDIA_ID_ATTEMPTS) {
      throw ToolError.internal(
        `Attachments ${missing.join(', ')} were uploaded to ${issueKey} but Jira did not report their media ids, so they could not be shown in the comment.`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, MEDIA_ID_RETRY_MS));
  }
};

interface ImageSize {
  width: number;
  height: number;
}

/** The image's pixel size, or undefined when the page cannot decode it (Jira then sizes it itself). */
const measureImage = async (file: LocalFile): Promise<ImageSize | undefined> => {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    const bitmap = await createImageBitmap(toBlob(file));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return undefined;
  }
};

/** An ADF block showing one attached image, left-aligned at its own width up to the comment width. */
export const mediaSingleNode = (mediaId: string, alt: string, size: ImageSize | undefined): AdfNode => {
  const media: AdfNode = {
    type: 'media',
    attrs: { type: 'file', id: mediaId, collection: '', alt, ...(size ?? {}) },
  };
  const attrs: Record<string, unknown> = { layout: 'align-start' };
  if (size) {
    attrs.width = Math.min(size.width, MAX_DISPLAY_WIDTH_PX);
    attrs.widthType = 'pixel';
  }
  return { type: 'mediaSingle', attrs, content: [media] };
};

/** Upload comment images to the issue and build the ADF block for each, in input order. */
export const attachCommentImages = async (
  issueKey: string,
  images: CommentImageInput[],
  files: LocalFile[],
  context?: ToolHandlerContext,
): Promise<AdfNode[]> => {
  if (files.length === 0) return [];
  const attachments = await uploadAttachments(issueKey, files, context);
  const mediaIds = await getMediaIds(
    issueKey,
    attachments.map(a => a.id),
  );
  return Promise.all(
    files.map(async (file, index) =>
      mediaSingleNode(mediaIds[index] ?? '', images[index]?.alt ?? file.name, await measureImage(file)),
    ),
  );
};
