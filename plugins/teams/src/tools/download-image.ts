import { defineTool, ToolError } from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchFullSizeImage, imageExtension, parseAmsImageUrl } from '../ams-image.js';

/** Characters Windows and macOS reject in a file name. */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

/** The saved file name: the caller's (sanitised, extension added if missing) or one derived from the object id. */
const resolveFilename = (requested: string | undefined, objectId: string, extension: string): string => {
  const base = (requested ?? '').replace(UNSAFE_FILENAME_CHARS, '_').trim();
  if (base === '') return `teams-image-${objectId}.${extension}`;
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${extension}`;
};

/** Save a blob to the browser's Downloads folder through an `<a download>` click. */
const saveToDownloads = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/** Pixel dimensions of an image blob, or null when the browser cannot decode it. */
const imageDimensions = async (blob: Blob): Promise<{ width: number; height: number } | null> => {
  try {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  } catch {
    return null;
  }
};

export const downloadImage = defineTool({
  name: 'download_image',
  displayName: 'Download Image',
  description:
    "Save an image from a chat message to the browser's Downloads folder at its original resolution and format — not " +
    'the downscaled preview shown inline in the chat. Pass an image URL from the `images` list returned by ' +
    'read_messages (or any <img> src on us-api.asm.skype.com in message content). Returns the saved file name, ' +
    'MIME type, size, and pixel dimensions.',
  summary: 'Save a chat image at full resolution',
  icon: 'image-down',
  group: 'Messages',
  input: z.object({
    image_url: z
      .string()
      .min(1)
      .describe('Image URL from read_messages `images[].url`, or an AMS <img> src from message content'),
    filename: z
      .string()
      .optional()
      .describe('File name to save as; the extension is added when missing (default "teams-image-<id>.<ext>")'),
  }),
  output: z.object({
    filename: z
      .string()
      .describe('File name requested for the download (the browser appends " (1)" etc. if the name is taken)'),
    content_type: z.string().describe('Image MIME type (e.g., "image/png")'),
    size: z.number().describe('Size in bytes'),
    width: z.number().nullable().describe('Image width in pixels, or null if it could not be decoded'),
    height: z.number().nullable().describe('Image height in pixels, or null if it could not be decoded'),
  }),
  handle: async params => {
    const image = parseAmsImageUrl(params.image_url);
    if (!image) {
      throw ToolError.validation(
        'image_url must be a Teams media URL like https://us-api.asm.skype.com/v1/objects/<id>/views/imgo.',
      );
    }
    const blob = await fetchFullSizeImage(image);
    const filename = resolveFilename(params.filename, image.objectId, imageExtension(blob.type));
    const dimensions = await imageDimensions(blob);
    saveToDownloads(blob, filename);
    return {
      filename,
      content_type: blob.type,
      size: blob.size,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  },
});
