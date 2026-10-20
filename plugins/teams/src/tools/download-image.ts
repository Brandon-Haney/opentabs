import {
  defineTool,
  MAX_LOCAL_FILE_BYTES,
  SAVE_FILE_PATH_FORMAT,
  saveLocalFile,
  ToolError,
} from '@opentabs-dev/plugin-sdk';
import { z } from 'zod';
import { fetchFullSizeImage, parseAmsImageUrl } from '../ams-image.js';
import { bytesToBase64 } from '../chat-files.js';

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
    'Save an image from a chat message to a path at its original resolution and format — not the downscaled ' +
    'preview shown inline in the chat. Pass an image URL from the `images` list returned by read_messages (or any ' +
    '<img> src on us-api.asm.skype.com in message content). The file is written straight to save_to and never ' +
    'passes through the browser Downloads folder. To look at an image without keeping it, save it to your ' +
    'temporary or scratch directory, read it there, and delete it when done. Returns the saved path, MIME type, ' +
    'size, and pixel dimensions.',
  summary: 'Save a chat image at full resolution to a path',
  icon: 'image-down',
  group: 'Messages',
  input: z.object({
    image_url: z
      .string()
      .min(1)
      .describe('Image URL from read_messages `images[].url`, or an AMS <img> src from message content'),
    save_to: z
      .string()
      .min(1)
      .meta({ format: SAVE_FILE_PATH_FORMAT })
      .describe(
        'Absolute path to write the image to, including the file name — e.g. a file in your temporary directory. ' +
          'The folder must exist; an existing file at the path is overwritten. The image keeps its original ' +
          'format (see content_type), whatever extension the path has.',
      ),
  }),
  output: z.object({
    saved_to: z.string().describe('Path the image was written to'),
    content_type: z.string().describe('Image MIME type (e.g., "image/png")'),
    size: z.number().describe('Size in bytes'),
    width: z.number().nullable().describe('Image width in pixels, or null if it could not be decoded'),
    height: z.number().nullable().describe('Image height in pixels, or null if it could not be decoded'),
  }),
  handle: async (params, context) => {
    const image = parseAmsImageUrl(params.image_url);
    if (!image) {
      throw ToolError.validation(
        'image_url must be a Teams media URL like https://us-api.asm.skype.com/v1/objects/<id>/views/imgo.',
      );
    }
    const blob = await fetchFullSizeImage(image);
    if (blob.size > MAX_LOCAL_FILE_BYTES) {
      throw ToolError.validation(
        `Image ${image.objectId} is ${(blob.size / 1024 / 1024).toFixed(1)} MB; files saved in one call may be at ` +
          `most ${MAX_LOCAL_FILE_BYTES / 1024 / 1024} MB.`,
      );
    }
    const dimensions = await imageDimensions(blob);
    saveLocalFile(context, params.save_to, bytesToBase64(new Uint8Array(await blob.arrayBuffer())));
    return {
      saved_to: params.save_to,
      content_type: blob.type,
      size: blob.size,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  },
});
