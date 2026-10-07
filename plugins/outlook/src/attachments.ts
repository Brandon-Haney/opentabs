import {
  LOCAL_FILE_PATH_FORMAT,
  type LocalFile,
  readLocalFile,
  ToolError,
  type ToolHandlerContext,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import {
  attachFileToMessage,
  attachLargeFileToMessage,
  attachReferenceToMessage,
  type UploadProgressReporter,
  uploadAttachmentToOneDrive,
} from './outlook-api.js';

/**
 * Adds files to draft messages the plugin creates. The caller names each file by its
 * path on the user's computer; the OpenTabs server reads it and delivers the bytes
 * with the tool call, since the plugin runs in the page and cannot read the disk
 * itself.
 *
 * An attachment is either embedded as a copy of its bytes (a `fileAttachment`) or,
 * when `as_cloud_link` is set, uploaded to the user's OneDrive and attached as a
 * sharing link (a `referenceAttachment`). An inline image is an embedded
 * `fileAttachment` marked inline with a content id, which the HTML body shows through
 * `<img src="cid:<content id>">`.
 */

/**
 * Largest file embedded inline as base64 `contentBytes`. Microsoft rejects a single
 * attachment request over ~3 MB, so anything larger needs a chunked upload session.
 */
const INLINE_ATTACHMENT_LIMIT_BYTES = 3_000_000;

/** Input schema for a path to a file on the user's computer, read by the OpenTabs server. */
const localFilePath = (example: string) =>
  z
    .string()
    .min(1)
    .meta({ format: LOCAL_FILE_PATH_FORMAT })
    .describe(
      `Absolute path of the file on this computer, e.g. "${example}". The file is read from disk — pass the path, never the contents.`,
    );

/** Shared input shape for one attachment, reused across every compose tool. */
export const attachmentInputSchema = z.object({
  path: localFilePath('C:\\Users\\me\\Documents\\report.pdf'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("File name recipients see, including extension (default: the file's own name)"),
  as_cloud_link: z
    .boolean()
    .optional()
    .describe(
      'Attach as a OneDrive sharing link instead of embedding a copy of the file (default: false). Use for large files or documents recipients should open in the cloud.',
    ),
});

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

/** Characters allowed in an inline image's content id, which the body quotes inside `cid:` URLs. */
const CONTENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Shared input shape for one image shown inside an HTML body. */
const inlineImageInputSchema = z.object({
  path: localFilePath('C:\\Users\\me\\Pictures\\chart.png'),
  content_id: z
    .string()
    .regex(CONTENT_ID_PATTERN)
    .describe('Id the body uses to show the image, as <img src="cid:<content_id>">, e.g. "chart1"'),
});

export type InlineImageInput = z.infer<typeof inlineImageInputSchema>;

/** The `inline_images` field shared by every tool that writes an HTML body. */
export const inlineImagesField = z
  .array(inlineImageInputSchema)
  .optional()
  .describe(
    'Images shown inside the body. Requires body_type "html"; place each with <img src="cid:<content_id>">. ' +
      'Every image must be placed in the body, and every cid: the body uses must be listed here.',
  );

/** Content ids referenced by `cid:` URLs in an HTML body. */
const CID_REFERENCE = /cid:([^"'\s<>)]+)/gi;

/** The content ids an HTML body references through `cid:` URLs. */
export const referencedContentIds = (html: string): Set<string> =>
  new Set([...html.matchAll(CID_REFERENCE)].map(match => match[1] ?? ''));

/**
 * Check a body against the inline images supplied with it, before the draft is
 * written. Content ids must be unique, images need an HTML body, every supplied image
 * must be placed in the body, and every `cid:` an HTML body uses must have an image —
 * supplied now, or among `existingContentIds` already on the draft. A missing one
 * renders as a broken image, and an unplaced one shows up as a stray attachment.
 */
export const validateInlineImages = (
  body: string,
  bodyType: 'text' | 'html' | undefined,
  images: InlineImageInput[] = [],
  existingContentIds: ReadonlySet<string> = new Set(),
): void => {
  if (images.length > 0 && bodyType !== 'html') {
    throw ToolError.validation('inline_images need an HTML body: set body_type to "html".');
  }
  if (bodyType !== 'html') return;

  const supplied = new Set<string>();
  for (const { content_id } of images) {
    if (supplied.has(content_id)) throw ToolError.validation(`Inline image content_id "${content_id}" is repeated.`);
    supplied.add(content_id);
  }
  const referenced = referencedContentIds(body);
  for (const id of supplied) {
    if (!referenced.has(id)) {
      throw ToolError.validation(`Inline image "${id}" is never placed in the body; add <img src="cid:${id}">.`);
    }
  }
  for (const id of referenced) {
    if (!supplied.has(id) && !existingContentIds.has(id)) {
      throw ToolError.validation(`The body shows cid:${id}, but no inline image has content_id "${id}".`);
    }
  }
};

/** Decode a base64 string to its raw bytes. */
const decodeBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** One file to add to a draft, with its bytes already delivered. */
interface PendingFile {
  file: LocalFile;
  name: string;
  /** Set for an inline image: the id the body references it by. */
  contentId?: string;
  asCloudLink: boolean;
}

/** Attach one file to a draft, dispatching on embed-vs-link and size. */
const attachOne = async (
  messageId: string,
  pending: PendingFile,
  onUploadProgress: UploadProgressReporter,
): Promise<void> => {
  const { file, name, contentId } = pending;
  const { contentType, contentBase64 } = file;

  // A cloud link uploads the bytes to OneDrive and references the file by sharing link,
  // so it is not bound by the inline-embed size ceiling.
  if (pending.asCloudLink) {
    const sourceUrl = await uploadAttachmentToOneDrive(name, decodeBase64(contentBase64), contentType);
    await attachReferenceToMessage(messageId, { name, sourceUrl });
    return;
  }

  // A single inline request cannot carry more than ~3 MB of base64, so larger embeds
  // stream the raw bytes to the draft through a chunked upload session instead.
  if (file.size > INLINE_ATTACHMENT_LIMIT_BYTES) {
    await attachLargeFileToMessage(
      messageId,
      { name, contentType, contentId, bytes: decodeBase64(contentBase64) },
      onUploadProgress,
    );
    return;
  }

  await attachFileToMessage(messageId, { name, contentType, contentId, contentBase64 });
};

/** Files a compose tool adds to its draft: regular attachments and images placed in the body. */
export interface DraftFiles {
  attachments?: AttachmentInput[];
  inline_images?: InlineImageInput[];
}

/** Pair each requested file with its delivered bytes, rejecting an inline image that is not an image. */
const resolveFiles = (files: DraftFiles, context: ToolHandlerContext | undefined): PendingFile[] => {
  const attachments = (files.attachments ?? []).map(attachment => {
    const file = readLocalFile(context, attachment.path);
    return { file, name: attachment.name ?? file.name, asCloudLink: attachment.as_cloud_link === true };
  });
  const images = (files.inline_images ?? []).map(image => {
    const file = readLocalFile(context, image.path);
    if (!file.contentType.startsWith('image/')) {
      throw ToolError.validation(`Inline image "${image.content_id}" (${file.name}) is not an image file.`);
    }
    return { file, name: file.name, contentId: image.content_id, asCloudLink: false };
  });
  return [...images, ...attachments];
};

const formatMegabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * Add files to a draft message in order, inline images first. Files are applied
 * sequentially — concurrent POSTs to the same message race on its change key — so a
 * failure stops the run and propagates, leaving the draft with whatever attached
 * before it. Every file is resolved before the first is attached, so a missing or
 * invalid one leaves the draft untouched.
 *
 * Progress is reported through `context` on one scale, files completed out of the
 * total: once per attached file, and fractionally after every chunk of a chunked
 * upload so a large embed keeps restarting the extension's no-progress budget while
 * its bytes are still moving.
 */
export const attachToDraft = async (
  messageId: string,
  files: DraftFiles,
  context?: ToolHandlerContext,
): Promise<void> => {
  if (!files.attachments?.length && !files.inline_images?.length) return;
  const pending = resolveFiles(files, context);
  const total = pending.length;
  for (const [index, item] of pending.entries()) {
    const position = `Attachment ${index + 1} of ${total}`;
    await attachOne(messageId, item, (uploadedBytes, totalBytes) =>
      context?.reportProgress({
        progress: index + uploadedBytes / totalBytes,
        total,
        message: `${position}: ${formatMegabytes(uploadedBytes)} of ${formatMegabytes(totalBytes)} uploaded`,
      }),
    );
    context?.reportProgress({ progress: index + 1, total, message: `${position} attached` });
  }
};
