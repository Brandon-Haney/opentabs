// Images pasted into a Teams chat are stored in the Skype media service (AMS)
// and referenced from the message HTML as
// `https://<region>-api.asm.skype.com/v1/objects/<id>/views/imgo`. AMS keeps
// several renditions of each object: `imgo` is the downscaled JPEG the chat
// shows inline, while `imgpsh_fullsize_anim` is the file as uploaded (original
// resolution and format, animation intact) that the Teams full-screen viewer
// opens. AMS authenticates the signed-in user by cookie, so the page fetches
// it with `credentials: 'include'` and no token.

import { ToolError } from '@opentabs-dev/plugin-sdk';

/** AMS rendition holding the image as uploaded. */
const FULL_SIZE_VIEW = 'imgpsh_fullsize_anim';

/** An AMS object URL: captures the regional API host and the object id. */
const AMS_OBJECT_URL = /^https:\/\/([a-z0-9-]+\.asm\.skype\.com)\/v1\/objects\/([^/?#"]+)/i;

/** An `<img>` tag's `src` attribute value. */
const IMG_SRC = /<img\b[^>]*?\bsrc="([^"]+)"/gi;

/** A chat image stored in AMS. */
export interface AmsImage {
  /** AMS object id. */
  objectId: string;
  /** URL of the full-resolution rendition. */
  fullSizeUrl: string;
}

/** Resolve an AMS object URL (any rendition, or the bare object) to its full-size rendition, or null. */
export const parseAmsImageUrl = (url: string): AmsImage | null => {
  const match = AMS_OBJECT_URL.exec(url.trim().replace(/&amp;/g, '&'));
  const host = match?.[1];
  const objectId = match?.[2];
  if (!host || !objectId) return null;
  return { objectId, fullSizeUrl: `https://${host}/v1/objects/${objectId}/views/${FULL_SIZE_VIEW}` };
};

/** The AMS images embedded in a message's HTML, in order of appearance and without duplicates. */
export const extractMessageImages = (html: string): AmsImage[] => {
  const images = new Map<string, AmsImage>();
  for (const match of html.matchAll(IMG_SRC)) {
    const image = parseAmsImageUrl(match[1] ?? '');
    if (image && !images.has(image.objectId)) images.set(image.objectId, image);
  }
  return [...images.values()];
};

/** Fetch the full-resolution rendition of an AMS image. */
export const fetchFullSizeImage = async (image: AmsImage): Promise<Blob> => {
  let response: Response;
  try {
    response = await fetch(image.fullSizeUrl, { credentials: 'include' });
  } catch (error) {
    throw ToolError.internal(`Could not reach the Teams media service: ${String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw ToolError.auth(`The Teams media service refused the image (${response.status}); reload Teams and retry.`);
  }
  if (response.status === 404) throw ToolError.notFound(`Image ${image.objectId} was not found or has been deleted.`);
  if (!response.ok) throw ToolError.internal(`Teams media service error (${response.status}) for ${image.objectId}.`);
  return response.blob();
};
